import Twilio from "twilio";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;
const publicBaseUrl = process.env.PUBLIC_BASE_URL; // e.g. https://your-domain.com (or ngrok URL)

if (!accountSid || !authToken || !fromNumber) {
  throw new Error(
    "Missing Twilio env vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER",
  );
}
if (!publicBaseUrl) {
  throw new Error("Missing PUBLIC_BASE_URL env var (must be a publicly reachable https URL)");
}

const client = Twilio(accountSid, authToken);

/**
 * Places an outbound call to `phone`. Twilio will hit our /webhook/voice
 * endpoint once the call is answered, which returns TwiML connecting the
 * call audio to our WebSocket media stream.
 */
export async function initiateOutboundCall(phone: string) {
  const call = await client.calls.create({
    to: phone,
    from: fromNumber!,
    url: `${publicBaseUrl}/api/calls/webhook/voice?phone=${encodeURIComponent(phone)}`,
    statusCallback: `${publicBaseUrl}/api/calls/webhook/status`,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    statusCallbackMethod: "POST",
  });

  return call;
}

/** Builds the TwiML that connects the answered call to our media-stream WS. */
export function buildVoiceTwiml(phone: string): string {
  const wsBase = publicBaseUrl!.replace(/^http/, "ws");
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsBase}/api/calls/stream">
      <Parameter name="phone" value="${phone}" />
    </Stream>
  </Connect>
</Response>`;
}
