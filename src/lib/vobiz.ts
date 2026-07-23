import { prisma } from "./prisma.js";
import { getCallContext, linkCallId, phoneForCallId, unlinkCallId } from "./callRegistry.js";

/**
 * Vobiz telephony provider (default). Plivo-compatible REST API + a
 * bidirectional mulaw/8k media stream that connects to our /api/calls/stream
 * WebSocket. Ported from the TSK Backend VobizService, minus the multi-tenant
 * configure table — credentials come straight from env.
 */

const VOBIZ_API_BASE = "https://api.vobiz.ai/api/v1";

const MAX_CALL_RETRIES = parseInt(process.env.MAX_CALL_RETRIES || "3", 10);

// Hangup causes that mean the callee never actually talked to us → retry.
const FAILED_CALL_STATUSES = [
  "no-answer",
  "busy",
  "failed",
  "cancel",
  "canceled",
  "rejected",
  "timeout",
];

function creds() {
  const authId = process.env.VOBIZ_AUTH_ID;
  const authToken = process.env.VOBIZ_AUTH_TOKEN;
  const from = process.env.VOBIZ_PHONE_NUMBER;
  if (!authId || !authToken || !from) {
    throw new Error(
      "Missing Vobiz env vars: VOBIZ_AUTH_ID, VOBIZ_AUTH_TOKEN, VOBIZ_PHONE_NUMBER",
    );
  }
  return { authId, authToken, from };
}

function publicBaseUrl(): string {
  const url = process.env.PUBLIC_BASE_URL;
  if (!url) throw new Error("Missing PUBLIC_BASE_URL env var (public https URL)");
  return url.replace(/\/$/, "");
}

/**
 * Places an outbound call. Vobiz hits /api/calls/vobiz/answer when the call
 * is answered (we return Stream XML), and /api/calls/vobiz/hangup when it
 * ends. Returns the request UUID which identifies the call from then on.
 */
export async function initiateVobizCall(phone: string): Promise<{ callUuid: string }> {
  const { authId, authToken, from } = creds();
  const base = publicBaseUrl();

  const res = await fetch(`${VOBIZ_API_BASE}/Account/${authId}/Call/`, {
    method: "POST",
    headers: {
      "X-Auth-ID": authId,
      "X-Auth-Token": authToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // Vobiz expects E.164 without the leading "+"
      from: from.replace(/^\+/, ""),
      to: phone.replace(/^\+/, ""),
      answer_url: `${base}/api/calls/vobiz/answer?phone=${encodeURIComponent(phone)}`,
      answer_method: "POST",
      hangup_url: `${base}/api/calls/vobiz/hangup`,
      hangup_method: "POST",
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Vobiz call failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as { request_uuid: string };
  linkCallId(data.request_uuid, phone);
  return { callUuid: data.request_uuid };
}

/**
 * Answer webhook response — connects the call audio to our WebSocket.
 * keepCallAlive="true" means closing the WS does NOT end the call; the only
 * way to hang up from our side is the REST hangupVobizCall() below.
 */
export function buildVobizAnswerXml(phone: string, callUuid: string): string {
  const wsHost = publicBaseUrl().replace(/^https?:\/\//, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream
    bidirectional="true"
    audioTrack="inbound"
    contentType="audio/x-mulaw;rate=8000"
    keepCallAlive="true"
    extraHeaders="phone=${phone},callUuid=${callUuid}">wss://${wsHost}/api/calls/stream</Stream>
</Response>`;
}

export function buildVobizHangupXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;
}

/** Ends a live call from the server side (used by the hangup_call tool). */
export async function hangupVobizCall(callUuid: string): Promise<void> {
  const { authId, authToken } = creds();
  const res = await fetch(`${VOBIZ_API_BASE}/Account/${authId}/Call/${callUuid}/`, {
    method: "DELETE",
    headers: { "X-Auth-ID": authId, "X-Auth-Token": authToken },
  });
  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Failed to end Vobiz call ${callUuid} (${res.status}): ${detail}`);
  }
}

/**
 * Hangup webhook bookkeeping. On a failed call (no-answer/busy/...), release
 * the lead and bump retry so the dialer cron tries again; once retries are
 * exhausted, record the failure in the lead's summary history.
 */
export async function handleVobizHangup(callUuid: string, callStatus: string): Promise<void> {
  const phone = phoneForCallId(callUuid);
  unlinkCallId(callUuid);

  if (!FAILED_CALL_STATUSES.includes(callStatus)) return;
  if (!phone) return;

  const ctx = getCallContext(phone);
  const leadId = ctx?.leadId;
  if (!leadId) return;

  try {
    const updated = await prisma.lead.update({
      where: { id: leadId },
      data: { callMade: false, onCall: false, retry: { increment: 1 } },
      select: { retry: true, summary: true },
    });
    console.log(`[vobiz] Retry ${updated.retry} for lead ${leadId} (status: ${callStatus})`);

    if (updated.retry >= MAX_CALL_RETRIES) {
      const existing = Array.isArray(updated.summary) ? updated.summary : [];
      await prisma.lead.update({
        where: { id: leadId },
        data: {
          summary: [
            ...existing,
            { text: "Call didn't answer.", createdAt: new Date().toISOString() },
          ] as any,
        },
      });
      console.warn(`[vobiz] Lead ${leadId} exceeded max retries (${MAX_CALL_RETRIES})`);
    }
  } catch (err) {
    console.error(`[vobiz] handleVobizHangup failed: ${(err as Error).message}`);
  }
}
