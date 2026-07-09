import { GoogleGenAI, Modality } from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

const ai = new GoogleGenAI({ apiKey });

const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-2.0-flash-live-001";
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.0-flash";
const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";

export type LiveTurn = { role: "user" | "model"; text: string };

export type LiveSessionHandle = {
  sendAudioChunk: (pcm16kBase64: string) => void;
  close: () => void;
};

type LiveSessionCallbacks = {
  onAudio: (pcm24kBase64: string) => void;
  onTranscriptTurn: (turn: LiveTurn) => void;
  onClose: () => void;
  onError: (err: unknown) => void;
};

/**
 * A single Gemini Live function-calling tool: the declaration is what the
 * model sees (name/description/params), the handler is what actually runs
 * locally when the model decides to call it.
 */
export type LiveTool = {
  declaration: Record<string, unknown>;
  handler: (args: Record<string, any>) => Promise<Record<string, unknown>>;
};

/**
 * Opens a Gemini Live session for one phone call, optionally wired up with
 * function-calling tools (e.g. appointment booking).
 *
 * NOTE: The exact shape of `ai.live.connect` (event names, config keys,
 * tool-call/tool-response field names) has shifted across @google/genai
 * versions — check the installed version's docs and adjust below if the
 * SDK has moved on.
 */
export async function startLiveSession(
  systemPrompt: string,
  callbacks: LiveSessionCallbacks,
  tools: LiveTool[] = [],
): Promise<LiveSessionHandle> {
  const toolHandlers = new Map(tools.map((t) => [t.declaration.name as string, t.handler]));

  let session: any;

  session = await ai.live.connect({
    model: LIVE_MODEL,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: systemPrompt,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      ...(tools.length
        ? { tools: [{ functionDeclarations: tools.map((t) => t.declaration) }] }
        : {}),
    },
    callbacks: {
      onmessage: async (message: any) => {
        try {
          // Audio output from the model
          const audioPart = message?.serverContent?.modelTurn?.parts?.find(
            (p: any) => p.inlineData?.mimeType?.startsWith("audio/"),
          );
          if (audioPart?.inlineData?.data) {
            callbacks.onAudio(audioPart.inlineData.data);
          }

          // Transcripts (used later to build the post-call summary)
          const inputTranscript = message?.serverContent?.inputTranscription?.text;
          if (inputTranscript) {
            callbacks.onTranscriptTurn({ role: "user", text: inputTranscript });
          }
          const outputTranscript = message?.serverContent?.outputTranscription?.text;
          if (outputTranscript) {
            callbacks.onTranscriptTurn({ role: "model", text: outputTranscript });
          }

          // Tool calls — the model wants to run one of our functions
          const functionCalls = message?.toolCall?.functionCalls;
          if (functionCalls?.length) {
            const functionResponses = await Promise.all(
              functionCalls.map(async (fc: any) => {
                const handler = toolHandlers.get(fc.name);
                let response: Record<string, unknown>;
                if (!handler) {
                  response = { error: `Unknown tool: ${fc.name}` };
                } else {
                  try {
                    response = await handler(fc.args ?? {});
                  } catch (err) {
                    response = { error: (err as Error).message };
                  }
                }
                return { id: fc.id, name: fc.name, response };
              }),
            );
            session.sendToolResponse({ functionResponses });
          }
        } catch (err) {
          callbacks.onError(err);
        }
      },
      onclose: () => callbacks.onClose(),
      onerror: (err: unknown) => callbacks.onError(err),
    },
  });

  return {
    sendAudioChunk: (pcm16kBase64: string) => {
      session.sendRealtimeInput({
        audio: { data: pcm16kBase64, mimeType: "audio/pcm;rate=16000" },
      });
    },
    close: () => {
      try {
        session.close();
      } catch {
        // already closed — ignore
      }
    },
  };
}

/** Turns a raw transcript into a 100-200 word call summary. */
export async function generateCallSummary(turns: LiveTurn[]): Promise<string> {
  if (turns.length === 0) {
    return "The call connected but no meaningful conversation was recorded.";
  }

  const transcript = turns
    .map((t) => `${t.role === "user" ? "Caller" : "Assistant"}: ${t.text}`)
    .join("\n");

  const result = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Summarize the following phone call transcript in 100-200 words. Write in plain prose (no bullet points), covering: what was discussed, the caller's key responses/intent (e.g. what appointment was booked, with which specialist, at what time — or why no booking was made), and any next steps or outcome. Be factual and concise.\n\nTRANSCRIPT:\n${transcript}`,
          },
        ],
      },
    ],
  });

  return result.text?.trim() || "Summary could not be generated.";
}

/** Embeds text into a vector for Pinecone storage. */
export async function embedText(text: string): Promise<number[]> {
  const result = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: [{ text }],
  });
  const values = result.embeddings?.[0]?.values ?? [];
  if (!values.length) throw new Error("Empty embedding returned from Gemini");
  return values;
}
