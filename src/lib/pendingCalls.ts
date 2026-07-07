/**
 * Short-lived, in-process store that bridges the gap between:
 *   1. POST /api/calls/initiate  (builds the system prompt, incl. last summary)
 *   2. The Twilio WS media stream (needs that same prompt once the call connects)
 *
 * Keyed by normalized phone number. Twilio's <Stream> passes the phone back
 * as a <Parameter>, so the WS handler can look the context up here.
 *
 * NOTE: this only works with a single Node process. If you ever scale to
 * multiple instances, swap this for Redis with a short TTL instead.
 */

type PendingCallContext = {
  systemPrompt: string;
  name?: string;
  createdAt: number;
};

const store = new Map<string, PendingCallContext>();
const TTL_MS = 10 * 60 * 1000; // 10 minutes — plenty of time for Twilio to connect

export function setPendingCall(phone: string, ctx: Omit<PendingCallContext, "createdAt">) {
  store.set(phone, { ...ctx, createdAt: Date.now() });
}

export function getPendingCall(phone: string): PendingCallContext | undefined {
  const ctx = store.get(phone);
  if (!ctx) return undefined;
  if (Date.now() - ctx.createdAt > TTL_MS) {
    store.delete(phone);
    return undefined;
  }
  return ctx;
}

export function deletePendingCall(phone: string) {
  store.delete(phone);
}
