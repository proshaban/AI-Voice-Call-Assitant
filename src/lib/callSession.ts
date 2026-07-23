import type WebSocket from "ws";
import { prisma } from "./prisma.js";
import {
  getCallContext,
  deleteCallContext,
  phoneForCallId,
  unlinkCallId,
} from "./callRegistry.js";
import { startLiveSession, generateCallSummary, LiveTurn, LiveSessionHandle } from "./gemini.js";
import { geminiAudioToTwilio, twilioAudioToGemini } from "./audio.js";
import { buildCallTools, CallToolsState } from "./lead-tools.js";
import { hangupCall, CallProvider } from "./provider.js";

// After the AI calls hangup_call, wait this long before tearing the call down
// so its goodbye audio finishes playing out.
const HANGUP_FLUSH_MS = 3000;
// When the REMOTE side hangs up first, give the AI this long to call
// save_call_summary before force-closing the Gemini session.
const CALL_END_GRACE_MS = 5000;

/**
 * Handles ONE media-stream WebSocket connection end-to-end. Vobiz (default)
 * and Twilio speak near-identical protocols but differ in the start-event
 * fields and the outbound audio envelope — the provider is detected from the
 * start event (Vobiz sends streamId/callId, Twilio streamSid).
 *
 * Call exactly once per WS connection.
 */
export function handleMediaStream(ws: WebSocket) {
  let provider: CallProvider = "vobiz";
  let streamSid = ""; // Twilio streamSid or Vobiz streamId
  let callId = ""; // Twilio callSid or Vobiz callUuid
  let phone: string | null = null;
  let leadId: string | null = null;
  let liveSession: LiveSessionHandle | null = null;
  let toolState: CallToolsState | null = null;
  const transcript: LiveTurn[] = [];
  let aiEndedCall = false;
  let finished = false;

  function sendAudioToCaller(mulawB64: string) {
    if (ws.readyState !== ws.OPEN || !streamSid) return;
    if (provider === "vobiz") {
      ws.send(
        JSON.stringify({
          event: "playAudio",
          streamId: streamSid,
          media: { contentType: "audio/x-mulaw", sampleRate: 8000, payload: mulawB64 },
        }),
      );
    } else {
      ws.send(
        JSON.stringify({ event: "media", streamSid, media: { payload: mulawB64 } }),
      );
    }
  }

  function clearCallerBuffer() {
    if (ws.readyState !== ws.OPEN || !streamSid) return;
    if (provider === "vobiz") {
      ws.send(JSON.stringify({ event: "clearAudio", streamId: streamSid }));
    } else {
      ws.send(JSON.stringify({ event: "clear", streamSid }));
    }
  }

  // The AI called hangup_call: let the goodbye audio flush, then hang up via
  // the provider REST API (required for Vobiz — keepCallAlive="true" means
  // closing the WS does NOT end the call) and finalize.
  function onHangupRequested() {
    aiEndedCall = true;
    setTimeout(async () => {
      try {
        if (callId) await hangupCall(callId, provider);
      } catch (err) {
        console.error("[callSession] Provider hangup failed:", (err as Error).message);
      }
      await finalizeCall();
    }, HANGUP_FLUSH_MS);
  }

  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start": {
        if (msg.start?.streamId && !msg.start?.streamSid) {
          // Vobiz (Plivo-style): streamId + callId; phone/callUuid arrive via
          // the extraHeaders set on the <Stream> answer XML
          provider = "vobiz";
          streamSid = msg.start.streamId;
          callId = msg.start.callId ?? "";
          const extra = String(msg.start.extraHeaders ?? "");
          const phoneMatch = extra.match(/phone=([^,]+)/);
          if (phoneMatch) phone = decodeURIComponent(phoneMatch[1]);
          const uuidMatch = extra.match(/callUuid=([^,]+)/);
          if (uuidMatch) callId = uuidMatch[1];
          // extraHeaders don't reliably arrive — fall back to the phone
          // remembered at initiate/inbound time
          if (!phone && callId) phone = phoneForCallId(callId) ?? null;
        } else {
          provider = "twilio";
          streamSid = msg.start?.streamSid ?? "";
          callId = msg.start?.callSid ?? "";
          phone = msg.start?.customParameters?.phone ?? null;
          if (!phone && callId) phone = phoneForCallId(callId) ?? null;
        }

        console.log(
          `[callSession] ${provider} stream started — call: ${callId} phone: ${phone}`,
        );

        if (!phone) {
          console.error("[callSession] No phone resolved from start event, closing");
          ws.close();
          return;
        }

        const ctx = getCallContext(phone);
        if (!ctx) {
          console.error(`[callSession] No call context for ${phone}, closing`);
          ws.close();
          return;
        }
        leadId = ctx.leadId;

        // Lock the lead while the call is live so the dialer can't re-dial
        await prisma.lead
          .update({ where: { id: leadId }, data: { onCall: true, callMade: true } })
          .catch((err) =>
            console.error("[callSession] Failed to lock lead:", (err as Error).message),
          );

        const { tools, state } = buildCallTools({ leadId, onHangupRequested });
        toolState = state;

        try {
          liveSession = await startLiveSession(
            ctx.systemPrompt,
            {
              onAudio: (pcm24kBase64) => sendAudioToCaller(geminiAudioToTwilio(pcm24kBase64)),
              onInterrupted: () => clearCallerBuffer(),
              onTranscriptTurn: (turn) => transcript.push(turn),
              onClose: () => {
                finalizeCall();
              },
              onError: (err) => {
                console.error("[callSession] Gemini Live error:", err);
              },
            },
            tools,
          );
          // Kick off the conversation — the agent speaks first on a call.
          liveSession.sendText("The call just connected. Begin the conversation now.");
        } catch (err) {
          console.error("[callSession] Failed to start Gemini Live session:", err);
          ws.close();
        }
        break;
      }

      case "media": {
        if (liveSession && msg.media?.payload) {
          liveSession.sendAudioChunk(twilioAudioToGemini(msg.media.payload));
        }
        break;
      }

      case "stop": {
        onRemoteEnded();
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", () => onRemoteEnded());

  // The remote party (or provider) ended the stream. If the AI already saved
  // the summary (or ended the call itself) finalize immediately; otherwise
  // nudge it to save now and give it a short grace period.
  function onRemoteEnded() {
    if (finished || aiEndedCall) {
      finalizeCall();
      return;
    }
    if (liveSession && leadId && !toolState?.summarySaved) {
      console.log(`[callSession] Remote ended call — ${CALL_END_GRACE_MS}ms grace for save_call_summary`);
      liveSession.sendText(
        "The call has just ended — the line is disconnected and the customer can no longer hear you. Do not say anything further. Immediately call save_call_summary now with your best assessment of the conversation so far.",
      );
      setTimeout(() => finalizeCall(), CALL_END_GRACE_MS);
    } else {
      finalizeCall();
    }
  }

  async function finalizeCall() {
    if (finished) return;
    finished = true;

    liveSession?.close();
    if (ws.readyState === ws.OPEN) ws.close();

    if (phone) deleteCallContext(phone);
    if (callId) unlinkCallId(callId);

    if (!leadId) return; // never got a valid start event — nothing to save

    try {
      if (toolState?.summarySaved) {
        console.log(`[callSession] Call for lead ${leadId} saved by the agent`);
        return;
      }

      const spoken = transcript.some((t) => t.text.trim().length > 0);
      if (!spoken) {
        // Connected but nobody really spoke — treat as a failed attempt so the
        // dialer retries (mirrors the TSK Backend cleanup contract).
        await prisma.lead.update({
          where: { id: leadId },
          data: { onCall: false, callMade: false, retry: { increment: 1 } },
        });
        console.log(`[callSession] Lead ${leadId}: empty call, queued for retry`);
        return;
      }

      // The agent never called save_call_summary — build a fallback summary
      // from the transcript so the call is still recorded.
      const summary = await generateCallSummary(transcript);
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { summary: true },
      });
      const existing = Array.isArray(lead?.summary) ? lead!.summary : [];
      await prisma.lead.update({
        where: { id: leadId },
        data: {
          summary: [...existing, { text: summary, createdAt: new Date().toISOString() }] as any,
          onCall: false,
          callMade: true,
          retry: 0,
        },
      });
      console.log(`[callSession] Lead ${leadId}: fallback summary saved`);
    } catch (err) {
      console.error("[callSession] Failed to finalize call:", err);
    }
  }
}
