import Twilio from "twilio";
import { linkCallId } from "./callRegistry.js";

/**
 * Twilio telephony provider — kept for future use; Vobiz is the default.
 * All env access is lazy so the app boots fine without Twilio configured.
 */

let client: ReturnType<typeof Twilio> | null = null;

function getClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("Missing Twilio env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN");
  }
  if (!client) client = Twilio(accountSid, authToken);
  return client;
}

function publicBaseUrl(): string {
  const url = process.env.PUBLIC_BASE_URL;
  if (!url) throw new Error("Missing PUBLIC_BASE_URL env var (public https URL)");
  return url.replace(/\/$/, "");
}

/** Places an outbound call; Twilio hits /api/calls/twilio/voice on answer. */
export async function initiateTwilioCall(phone: string): Promise<{ callSid: string }> {
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!fromNumber) throw new Error("Missing TWILIO_PHONE_NUMBER env var");

  const base = publicBaseUrl();
  const call = await getClient().calls.create({
    to: phone,
    from: fromNumber,
    url: `${base}/api/calls/twilio/voice?phone=${encodeURIComponent(phone)}`,
    statusCallback: `${base}/api/calls/twilio/status`,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
  });

  linkCallId(call.sid, phone);
  return { callSid: call.sid };
}

/** TwiML that connects the answered call to our media-stream WS. */
export function buildTwilioVoiceTwiml(phone: string): string {
  const wsBase = publicBaseUrl().replace(/^http/, "ws");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsBase}/api/calls/stream">
      <Parameter name="phone" value="${phone}" />
    </Stream>
  </Connect>
</Response>`;
}

/** Ends a live call from the server side (used by the hangup_call tool). */
export async function hangupTwilioCall(callSid: string): Promise<void> {
  await getClient().calls(callSid).update({ status: "completed" });
}
