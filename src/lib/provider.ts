import { initiateVobizCall, hangupVobizCall } from "./vobiz.js";
import { initiateTwilioCall, hangupTwilioCall } from "./twilio.js";

/**
 * Provider switch. Vobiz is the default; set CALL_PROVIDER=twilio to flip.
 * The media-stream handler detects the provider per-call from the start
 * event, so this only decides which provider DIALS outbound calls.
 */

export type CallProvider = "vobiz" | "twilio";

export function activeProvider(): CallProvider {
  return process.env.CALL_PROVIDER === "twilio" ? "twilio" : "vobiz";
}

/** Dials `phone` via the active provider. Returns the provider call id. */
export async function initiateOutboundCall(phone: string): Promise<{ callId: string; provider: CallProvider }> {
  const provider = activeProvider();
  if (provider === "twilio") {
    const { callSid } = await initiateTwilioCall(phone);
    return { callId: callSid, provider };
  }
  const { callUuid } = await initiateVobizCall(phone);
  return { callId: callUuid, provider };
}

/** Hangs up a live call on whichever provider carries it. */
export async function hangupCall(callId: string, provider: CallProvider): Promise<void> {
  if (provider === "twilio") return hangupTwilioCall(callId);
  return hangupVobizCall(callId);
}
