import { prisma } from "./prisma.js";
import { normalizePhone } from "./phone.js";
import { setCallContext } from "./callRegistry.js";
import { buildNewCallPrompt, buildFollowUpPrompt } from "./prompt.js";
import { initiateOutboundCall } from "./provider.js";

/**
 * Outbound dialer loop (the Express equivalent of TSK Backend's
 * BulkCallCronService). Every tick, within the IST call window:
 *   1. NEW CALLS      — leads never called (callMade=false, no nextDate)
 *   2. FOLLOW-UP CALLS — leads whose scheduled nextDate has arrived
 * Failed dials bump retry; the Vobiz hangup webhook does the same for
 * no-answer/busy, and both stop once MAX_CALL_RETRIES is reached.
 */

const INTERVAL_MS = parseInt(process.env.DIALER_INTERVAL_SECONDS || "30", 10) * 1000;
const MAX_RETRIES = parseInt(process.env.MAX_CALL_RETRIES || "3", 10);
const RETRY_WAIT_S = parseInt(process.env.RETRY_WAIT_SECONDS || "300", 10);
const BATCH_SIZE = parseInt(process.env.DIALER_BATCH_SIZE || "5", 10);
const WINDOW_START = process.env.CALL_WINDOW_START || "10:00";
const WINDOW_END = process.env.CALL_WINDOW_END || "19:00";

let running = false;

export function startDialer() {
  if (process.env.DIALER_ENABLED === "false") {
    console.log("[dialer] Disabled via DIALER_ENABLED=false");
    return;
  }
  console.log(
    `[dialer] Started — every ${INTERVAL_MS / 1000}s, window ${WINDOW_START}-${WINDOW_END} IST`,
  );
  setInterval(tick, INTERVAL_MS);
}

async function tick() {
  if (running) return; // previous tick still in flight
  running = true;
  try {
    if (!withinCallWindow()) return;
    await dialNewLeads();
    await dialFollowUps();
  } catch (err) {
    console.error("[dialer] Tick failed:", (err as Error).message);
  } finally {
    running = false;
  }
}

function withinCallWindow(): boolean {
  const nowIst = new Date().toLocaleTimeString("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return nowIst >= WINDOW_START && nowIst < WINDOW_END;
}

// A failed attempt bumps updatedAt and retry, so retry=0 means "never
// attempted" (dial immediately); otherwise wait RETRY_WAIT_S since the last
// attempt before retrying.
function retryPacing() {
  return {
    OR: [
      { retry: 0 },
      { updatedAt: { lte: new Date(Date.now() - RETRY_WAIT_S * 1000) } },
    ],
  };
}

async function dialNewLeads() {
  const leads = await prisma.lead.findMany({
    where: {
      status: { not: "completed" },
      callMade: false,
      onCall: false,
      retry: { lt: MAX_RETRIES },
      nextDate: null,
      phone: { not: "" },
      ...retryPacing(),
    },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
  });

  for (const lead of leads) {
    await dial(lead.id, () => buildNewCallPrompt(lead), lead.phone, "new");
  }
}

async function dialFollowUps() {
  const leads = await prisma.lead.findMany({
    where: {
      status: { not: "completed" },
      nextDate: { lte: new Date() },
      onCall: false,
      retry: { lt: MAX_RETRIES },
      phone: { not: "" },
      ...retryPacing(),
    },
    orderBy: { nextDate: "asc" },
    take: BATCH_SIZE,
  });

  for (const lead of leads) {
    // A lead scheduled ahead of any actual conversation still needs the
    // first-call prompt — "follow-up" only makes sense once a summary exists.
    const hasHistory = Array.isArray(lead.summary) && lead.summary.length > 0;
    await dial(
      lead.id,
      () => (hasHistory ? buildFollowUpPrompt(lead) : buildNewCallPrompt(lead)),
      lead.phone,
      "follow-up",
    );
  }
}

async function dial(
  leadId: string,
  buildPrompt: () => string,
  rawPhone: string,
  kind: "new" | "follow-up",
) {
  const phone = normalizePhone(rawPhone);
  try {
    setCallContext(phone, { systemPrompt: buildPrompt(), leadId });

    // Lock the record before dialling so no other tick picks it up
    await prisma.lead.update({
      where: { id: leadId },
      data: { onCall: true, callMade: true },
    });

    const { callId, provider } = await initiateOutboundCall(phone);
    console.log(`[dialer] ${kind} call → ${phone} (lead ${leadId}, ${provider} ${callId})`);
  } catch (err) {
    console.error(`[dialer] ${kind} call to ${phone} failed:`, (err as Error).message);
    await incrementRetry(leadId);
  }
}

async function incrementRetry(leadId: string) {
  try {
    const updated = await prisma.lead.update({
      where: { id: leadId },
      data: { retry: { increment: 1 }, onCall: false, callMade: false },
      select: { retry: true, summary: true },
    });
    if (updated.retry >= MAX_RETRIES) {
      const existing = Array.isArray(updated.summary) ? updated.summary : [];
      await prisma.lead.update({
        where: { id: leadId },
        data: {
          summary: [
            ...existing,
            { text: "Call could not be completed.", createdAt: new Date().toISOString() },
          ] as any,
        },
      });
    }
  } catch (err) {
    console.error("[dialer] incrementRetry failed:", (err as Error).message);
  }
}
