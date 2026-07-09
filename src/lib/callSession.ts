import type WebSocket from "ws";
import { prisma } from "./prisma";
import { getPendingCall, deletePendingCall } from "./pendingCalls";
import { startLiveSession, generateCallSummary, LiveTurn, LiveSessionHandle } from "./gemini";
import { upsertCallSummary } from "./pinecone";
import { geminiAudioToTwilio, twilioAudioToGemini } from "./audio";
import { buildAppointmentSystemPrompt } from "./prompt";
import { appointmentTools } from "./appointment-tools";

/**
 * Handles ONE Twilio Media Stream WebSocket connection end-to-end:
 *   Twilio "start"  -> read phone from customParameters, open Gemini Live session
 *                       (with appointment-booking tools attached)
 *   Twilio "media"  -> forward caller audio to Gemini
 *   Gemini audio    -> forward back to Twilio
 *   Twilio "stop"   -> close Gemini session, summarize transcript, persist result
 *
 * Call exactly once per WS connection — don't attach a second listener on
 * the same socket, or you'll open duplicate Gemini sessions.
 */
export function handleTwilioStream(ws: WebSocket) {
  let streamSid: string | null = null;
  let phone: string | null = null;
  let name: string | undefined;
  let liveSession: LiveSessionHandle | null = null;
  const transcript: LiveTurn[] = [];
  let finished = false;

  ws.on("message", async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "connected": {
        break;
      }

      case "start": {
        streamSid = msg.start?.streamSid ?? null;
        phone = msg.start?.customParameters?.phone ?? null;

        if (!phone) {
          console.error("[callSession] No phone in start event, closing stream");
          ws.close();
          return;
        }

        const pending = getPendingCall(phone);
        name = pending?.name;
        const systemPrompt =
          pending?.systemPrompt ?? buildAppointmentSystemPrompt({ phone });
        deletePendingCall(phone);

        try {
          liveSession = await startLiveSession(
            systemPrompt,
            {
              onAudio: (pcm24kBase64) => {
                if (ws.readyState !== ws.OPEN || !streamSid) return;
                ws.send(
                  JSON.stringify({
                    event: "media",
                    streamSid,
                    media: { payload: geminiAudioToTwilio(pcm24kBase64) },
                  }),
                );
              },
              onTranscriptTurn: (turn) => transcript.push(turn),
              onClose: () => {
                finalizeCall();
              },
              onError: (err) => {
                console.error("[callSession] Gemini Live error:", err);
              },
            },
            appointmentTools,
          );
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
        await finalizeCall();
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", () => {
    finalizeCall();
  });

  async function finalizeCall() {
    if (finished) return;
    finished = true;

    liveSession?.close();

    if (!phone) return; // never got a valid start event — nothing to save

    try {
      const summary = await generateCallSummary(transcript);

      const call = await prisma.call.create({
        data: { phone, name: name ?? null, summary },
      });

      await upsertCallSummary({ callId: call.id, phone, name, summary });

      console.log(`[callSession] Call ${call.id} (${phone}) summarized and saved`);
    } catch (err) {
      console.error("[callSession] Failed to finalize call:", err);
    }
  }
}
