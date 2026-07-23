/**
 * Short-lived, in-process store bridging call initiation and the media stream:
 *   1. The dialer/route builds the system prompt and registers it by phone.
 *   2. The provider (Vobiz/Twilio) connects the media stream, which looks the
 *      context back up by phone (Twilio customParameters / Vobiz extraHeaders)
 *      or by provider call id (Vobiz extraHeaders don't always arrive).
 *
 * Single Node process only — swap for Redis with a TTL if you ever scale out.
 */

export type CallContext = {
  systemPrompt: string;
  leadId: string;
  name?: string;
  createdAt: number;
};

const byPhone = new Map<string, CallContext>();
// Provider call id (Vobiz callUuid / Twilio callSid) → phone, so the stream
// handler and the hangup webhook can resolve the lead without extraHeaders.
const phoneByCallId = new Map<string, string>();

const TTL_MS = 10 * 60 * 1000;

export function setCallContext(phone: string, ctx: Omit<CallContext, "createdAt">) {
  byPhone.set(phone, { ...ctx, createdAt: Date.now() });
}

export function getCallContext(phone: string): CallContext | undefined {
  const ctx = byPhone.get(phone);
  if (!ctx) return undefined;
  if (Date.now() - ctx.createdAt > TTL_MS) {
    byPhone.delete(phone);
    return undefined;
  }
  return ctx;
}

export function deleteCallContext(phone: string) {
  byPhone.delete(phone);
}

export function linkCallId(callId: string, phone: string) {
  phoneByCallId.set(callId, phone);
}

export function phoneForCallId(callId: string): string | undefined {
  return phoneByCallId.get(callId);
}

export function unlinkCallId(callId: string) {
  phoneByCallId.delete(callId);
}
