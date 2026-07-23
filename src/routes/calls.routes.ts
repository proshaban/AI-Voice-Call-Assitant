import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { normalizePhone } from "../lib/phone.js";
import { setCallContext, linkCallId } from "../lib/callRegistry.js";
import { buildNewCallPrompt, buildFollowUpPrompt, buildInboundPrompt } from "../lib/prompt.js";
import { initiateOutboundCall } from "../lib/provider.js";
import {
  buildVobizAnswerXml,
  buildVobizHangupXml,
  handleVobizHangup,
} from "../lib/vobiz.js";
import { buildTwilioVoiceTwiml } from "../lib/twilio.js";

export const callsRouter = Router();

// =========================================================
// POST /api/calls/initiate
// Body: { leadId } — manually trigger a call to an existing lead
// (the dialer cron normally does this on its own)
// =========================================================
callsRouter.post("/initiate", async (req: Request, res: Response) => {
  try {
    const { leadId } = req.body as { leadId?: string };
    if (!leadId) {
      return res.status(400).json({ success: false, error: "`leadId` is required" });
    }

    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) {
      return res.status(404).json({ success: false, error: "Lead not found" });
    }
    if (lead.onCall) {
      return res.status(409).json({ success: false, error: "Lead is already on a call" });
    }

    const phone = normalizePhone(lead.phone);
    const hasHistory = Array.isArray(lead.summary) && lead.summary.length > 0;
    const systemPrompt = hasHistory ? buildFollowUpPrompt(lead) : buildNewCallPrompt(lead);

    setCallContext(phone, { systemPrompt, leadId: lead.id, name: lead.name });
    await prisma.lead.update({
      where: { id: lead.id },
      data: { onCall: true, callMade: true },
    });

    const { callId, provider } = await initiateOutboundCall(phone);

    return res.status(200).json({
      success: true,
      data: { callId, provider, phone, followUp: hasHistory },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/calls/initiate]", message);
    return res.status(500).json({ success: false, error: message });
  }
});

// =========================================================
// VOBIZ WEBHOOKS (default provider)
// =========================================================

// Answer webhook for OUTBOUND calls (set as answer_url when dialling).
// Returns Stream XML connecting the call audio to our WebSocket.
callsRouter.post("/vobiz/answer", (req: Request, res: Response) => {
  const phone =
    (req.query.phone as string) || req.body?.From || req.body?.from || "unknown";
  const callUuid =
    req.body?.CallUUID || req.body?.call_uuid || req.body?.RequestUUID || "unknown";
  console.log(`[vobiz] answer — phone: ${phone} uuid: ${callUuid}`);

  res.set("Content-Type", "text/xml");
  res.status(200).send(buildVobizAnswerXml(phone, callUuid));
});

// Answer webhook for INBOUND calls (set as answer_url on the Vobiz number).
// Looks the caller up (or creates a lead) while ringing, then returns the
// same Stream XML as outbound calls.
callsRouter.post("/vobiz/inbound", async (req: Request, res: Response) => {
  const rawPhone = req.body?.From || req.body?.from || "unknown";
  const callUuid =
    req.body?.CallUUID || req.body?.call_uuid || req.body?.RequestUUID || "unknown";
  console.log(`[vobiz] inbound — from: ${rawPhone} uuid: ${callUuid}`);

  res.set("Content-Type", "text/xml");
  try {
    const phone = await prepareInboundCall(rawPhone, callUuid);
    res.status(200).send(buildVobizAnswerXml(phone, callUuid));
  } catch (err) {
    console.error("[vobiz] inbound failed:", (err as Error).message);
    res.status(200).send(buildVobizHangupXml());
  }
});

// Hangup callback — retry bookkeeping for unanswered/failed calls.
callsRouter.post("/vobiz/hangup", async (req: Request, res: Response) => {
  const callUuid =
    req.body?.CallUUID ||
    req.body?.call_uuid ||
    req.body?.RequestUUID ||
    req.body?.request_uuid;
  const callStatus = (
    req.body?.CallStatus ||
    req.body?.call_status ||
    req.body?.HangupCause ||
    req.body?.hangup_cause ||
    ""
  ).toLowerCase();

  if (callUuid && callStatus) {
    console.log(`[vobiz] hangup — uuid: ${callUuid} status: ${callStatus}`);
    await handleVobizHangup(callUuid, callStatus);
  }
  res.status(204).send();
});

// =========================================================
// TWILIO WEBHOOKS (kept for future use — CALL_PROVIDER=twilio)
// =========================================================

callsRouter.post("/twilio/voice", (req: Request, res: Response) => {
  const phone = (req.query.phone as string) || "unknown";
  res.set("Content-Type", "text/xml");
  res.status(200).send(buildTwilioVoiceTwiml(phone));
});

callsRouter.post("/twilio/inbound", async (req: Request, res: Response) => {
  const rawPhone = req.body?.From || "unknown";
  const callSid = req.body?.CallSid || "unknown";
  console.log(`[twilio] inbound — from: ${rawPhone} sid: ${callSid}`);

  res.set("Content-Type", "text/xml");
  try {
    const phone = await prepareInboundCall(rawPhone, callSid);
    res.status(200).send(buildTwilioVoiceTwiml(phone));
  } catch (err) {
    console.error("[twilio] inbound failed:", (err as Error).message);
    res
      .status(200)
      .send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  }
});

callsRouter.post("/twilio/status", (req: Request, res: Response) => {
  console.log(`[twilio] status — sid=${req.body.CallSid} status=${req.body.CallStatus}`);
  res.status(204).send();
});

// =========================================================
// Shared inbound preparation: resolve (or create) the lead for the caller
// and register the call context so the media stream picks it up.
// =========================================================
async function prepareInboundCall(rawPhone: string, callId: string): Promise<string> {
  const phone = normalizePhone(rawPhone);
  const last10 = phone.replace(/\D/g, "").slice(-10);

  let lead =
    last10.length === 10
      ? await prisma.lead.findFirst({
          where: { phone: { endsWith: last10 } },
          orderBy: { updatedAt: "desc" },
        })
      : null;

  const known = Boolean(lead);
  if (!lead) {
    lead = await prisma.lead.create({
      data: { name: "Inbound Caller", phone, onCall: true },
    });
  } else {
    await prisma.lead.update({ where: { id: lead.id }, data: { onCall: true } });
  }

  const systemPrompt = buildInboundPrompt({
    id: lead.id,
    name: lead.name,
    phone,
    jobDescription: lead.jobDescription,
    status: lead.status,
    stage: lead.stage,
    summary: lead.summary,
    isKnown: known,
  });

  setCallContext(phone, { systemPrompt, leadId: lead.id, name: lead.name });
  linkCallId(callId, phone);
  console.log(`[inbound] ${phone} → ${known ? `known lead ${lead.id}` : `new lead ${lead.id}`}`);
  return phone;
}
