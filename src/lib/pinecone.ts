import { Pinecone } from "@pinecone-database/pinecone";
import { embedText } from "./gemini.js";

const apiKey = process.env.PINECONE_API_KEY;
const indexName = process.env.PINECONE_INDEX;

if (!apiKey) throw new Error("PINECONE_API_KEY is not configured");
if (!indexName) throw new Error("PINECONE_INDEX is not configured");

const pinecone = new Pinecone({ apiKey });
const index = pinecone.index(indexName);

type UpsertCallSummaryArgs = {
  callId: string;
  phone: string;
  name?: string | null;
  summary: string;
};

/**
 * Embeds the call summary and upserts it into Pinecone, keyed by the
 * Postgres `calls.id` so the two stores stay in sync (1 vector <-> 1 row).
 */
export async function upsertCallSummary({ callId, phone, name, summary }: UpsertCallSummaryArgs) {
  const vector = await embedText(summary);

  const record = {
    id: callId,
    values: vector,
    metadata: {
      phone,
      name: name ?? "",
      summary,
      createdAt: new Date().toISOString(),
    },
  };

  try {
    await index.upsert([record]);
  } catch (err: any) {
    // If the index doesn't exist, create it using the embedding dimension
    // then retry the upsert. Use optional env vars to configure cloud/region.
    const isNotFound = err?.name === "PineconeNotFoundError" || err?.message?.includes("404");
    if (!isNotFound) throw err;

    const dimension = 3072;
    const cloud = (process.env.PINECONE_CLOUD || "aws") as any;
    const region = (process.env.PINECONE_REGION || "us-east-1") as string;

    console.log(`[pinecone] Index '${indexName}' not found — creating (dim=${dimension})`);

    try {
      await pinecone.createIndex({
        name: indexName as string,
        dimension,
        metric: "cosine",
        spec: {
          serverless: {
            cloud,
            region,
          },
        },
        waitUntilReady: true,
        suppressConflicts: true,
      });

      // Re-resolve index host/cache and retry upsert
      const newIndex = pinecone.index(indexName as string);
      await newIndex.upsert([record]);
      console.log(`[pinecone] Index '${indexName}' created and record upserted`);
    } catch (createErr) {
      console.error("[pinecone] Failed to create index or upsert record:", createErr);
      throw createErr;
    }
  }
}
