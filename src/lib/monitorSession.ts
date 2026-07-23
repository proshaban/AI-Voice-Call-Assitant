import type WebSocket from "ws";
import { prisma } from "./prisma.js";
import { startLiveSession, generateCallSummary, LiveTurn, LiveSessionHandle } from "./gemini.js";
import { buildCallTools, CallToolsState } from "./lead-tools.js";
import { buildNewCallPrompt, buildFollowUpPrompt } from "./prompt.js";

/**
 * Local browser test session (ported from TSK Backend's monitor stream):
 * browser mic ↔ Gemini Live with the SAME prompts and tools as a real call —
 * no Vobiz/Twilio, no public URL needed. Audio protocol with the browser:
 *   browser → server: binary PCM16 @ 16kHz frames
 *   server → browser: binary PCM16 @ 24kHz frames + JSON events
 *     { type: "ready" | "interrupted" | "closed" | "error", ... }
 *     { type: "transcript", role: "user" | "model", text }
 * The lead's summary/status really are written to Postgres, so this tests
 * the full save_call_summary loop end-to-end.
 */
export async function handleMonitorStream(ws: WebSocket, leadId: string) {
  function sendJson(obj: object) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) {
    sendJson({ type: "error", message: `Lead ${leadId} not found` });
    ws.close();
    return;
  }

  const hasHistory = Array.isArray(lead.summary) && lead.summary.length > 0;
  const systemPrompt = hasHistory ? buildFollowUpPrompt(lead) : buildNewCallPrompt(lead);

  let liveSession: LiveSessionHandle | null = null;
  let toolState: CallToolsState | null = null;
  const transcript: LiveTurn[] = [];
  let finished = false;

  // hangup_call in a test session just ends the browser session (small delay
  // so the goodbye audio finishes streaming to the browser first).
  function onHangupRequested() {
    setTimeout(() => finalize(), 2000);
  }

  // Lock the lead so the dialer doesn't call them mid-test
  await prisma.lead
    .update({ where: { id: leadId }, data: { onCall: true, callMade: true } })
    .catch(() => {});

  const { tools, state } = buildCallTools({ leadId, onHangupRequested });
  toolState = state;

  try {
    liveSession = await startLiveSession(
      systemPrompt,
      {
        onAudio: (pcm24kBase64) => {
          if (ws.readyState === ws.OPEN) ws.send(Buffer.from(pcm24kBase64, "base64"));
        },
        onInterrupted: () => sendJson({ type: "interrupted" }),
        onTranscriptTurn: (turn) => {
          transcript.push(turn);
          sendJson({ type: "transcript", role: turn.role, text: turn.text });
        },
        onClose: () => finalize(),
        onError: (err) => {
          console.error("[monitor] Gemini Live error:", err);
          sendJson({ type: "error", message: (err as Error)?.message ?? "Gemini error" });
        },
      },
      tools,
    );
  } catch (err) {
    console.error("[monitor] Failed to start Gemini session:", err);
    sendJson({ type: "error", message: (err as Error).message });
    ws.close();
    await prisma.lead.update({ where: { id: leadId }, data: { onCall: false } }).catch(() => {});
    return;
  }

  console.log(
    `[monitor] Test session started — lead ${leadId} (${lead.phone}), ${hasHistory ? "follow-up" : "new"} prompt`,
  );
  sendJson({ type: "ready", followUp: hasHistory, lead: { name: lead.name, phone: lead.phone } });
  // Kick off the conversation — the agent speaks first, like on a real call.
  liveSession.sendText("The call just connected. Begin the conversation now.");

  ws.on("message", (raw, isBinary) => {
    if (!isBinary || !liveSession) return;
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    liveSession.sendAudioChunk(buf.toString("base64"));
  });

  ws.on("close", () => finalize());

  async function finalize() {
    if (finished) return;
    finished = true;

    liveSession?.close();
    sendJson({ type: "closed" });
    if (ws.readyState === ws.OPEN) ws.close();

    try {
      if (toolState?.summarySaved) {
        console.log(`[monitor] Test call for lead ${leadId} saved by the agent`);
        return;
      }

      // Test sessions shouldn't queue dialer retries — just unlock the lead
      // and, if there was a real conversation, save a fallback summary.
      const spoken = transcript.some((t) => t.text.trim().length > 0);
      if (!spoken) {
        await prisma.lead.update({ where: { id: leadId }, data: { onCall: false } });
        return;
      }

      const summary = await generateCallSummary(transcript);
      const fresh = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { summary: true },
      });
      const existing = Array.isArray(fresh?.summary) ? fresh!.summary : [];
      await prisma.lead.update({
        where: { id: leadId },
        data: {
          summary: [
            ...existing,
            { text: `[test call] ${summary}`, createdAt: new Date().toISOString() },
          ] as any,
          onCall: false,
        },
      });
      console.log(`[monitor] Lead ${leadId}: fallback test summary saved`);
    } catch (err) {
      console.error("[monitor] Finalize failed:", (err as Error).message);
    }
  }
}
