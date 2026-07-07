import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { normalizePhone } from "../lib/phone.js";
import { buildSystemPrompt } from "../lib/prompt.js";
import { setPendingCall } from "../lib/pendingCalls.js";
import { initiateOutboundCall, buildVoiceTwiml } from "../lib/twilio.js";

export const callsRouter = Router();

// =========================================================
// POST /api/calls/initiate
// Body: { phone: string, name?: string }
// =========================================================
callsRouter.post("/initiate", async (req: Request, res: Response) => {
  try {
    const { phone, name } = req.body as { phone?: string; name?: string };

    if (!phone) {
      return res.status(400).json({ success: false, error: "`phone` is required" });
    }

    const normalizedPhone = normalizePhone(phone);

    // Default values
    let lastCall: {
      name: string | null;
      summary: string | null;
    } | null = null;

    // Memory lookup should NEVER stop the call
    try {
      lastCall = await prisma.call.findFirst({
        where: { phone: normalizedPhone },
        orderBy: { createdAt: "desc" },
      });
    } catch (err) {
      console.error(
        "[POST /api/calls/initiate] Failed to fetch previous call history:",
        err
      );
    }

    const systemPrompt = buildSystemPrompt({
      name: name ?? lastCall?.name ?? undefined,
      phone: normalizedPhone,
      lastSummary: lastCall?.summary ?? null,
    });

    setPendingCall(normalizedPhone, { systemPrompt, name });

    const call = await initiateOutboundCall(normalizedPhone);

    return res.status(200).json({
      success: true,
      data: {
        callSid: call.sid,
        phone: normalizedPhone,
        usedPreviousSummary: Boolean(lastCall?.summary),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/calls/initiate]", message);
    return res.status(500).json({ success: false, error: message });
  }
});

callsRouter.post("/test-session", async (req, res) => {
  const { phone, name } = req.body;

  if (!phone) {
    return res.status(400).json({
      success: false,
      error: "phone is required",
    });
  }

  const normalizedPhone = normalizePhone(phone);

  let lastCall = null;

  // Optional memory lookup
  try {
    lastCall = await prisma.call.findFirst({
      where: { phone: normalizedPhone },
      orderBy: { createdAt: "desc" },
    });
  } catch (err) {
    console.error("[test-session] Failed to load previous call:", err);
  }

  const systemPrompt = buildSystemPrompt({
    phone: normalizedPhone,
    name: name ?? lastCall?.name ?? undefined,
    lastSummary: lastCall?.summary ?? null,
  });

  setPendingCall(normalizedPhone, {
    systemPrompt,
    name: name ?? lastCall?.name ?? undefined,
  });

  return res.json({
    success: true,
    data: {
      phone: normalizedPhone,
      usedPreviousSummary: !!lastCall?.summary,
    },
  });
});

// =========================================================
// POST /api/calls/webhook/voice?phone=...
// Twilio hits this once the call is answered -> returns TwiML
// =========================================================
callsRouter.post("/webhook/voice", (req: Request, res: Response) => {
  const phone = (req.query.phone as string) || "unknown";
  const twiml = buildVoiceTwiml(phone);
  res.set("Content-Type", "text/xml");
  res.status(200).send(twiml);
});

// =========================================================
// POST /api/calls/webhook/status
// Twilio call status callback (logs only — actual save happens
// in callSession.ts once the media stream's "stop" event fires)
// =========================================================
callsRouter.post("/webhook/status", (req: Request, res: Response) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  console.log(`[status webhook] sid=${callSid} status=${callStatus}`);
  res.status(204).send();
});

// =========================================================
// GET /api/calls?phone=...
// List saved call records, most recent first
// =========================================================
callsRouter.get("/", async (req: Request, res: Response) => {
  const phone = (req.query.phone as string) || undefined;

  const calls = await prisma.call.findMany({
    where: phone ? { phone } : undefined,
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  res.status(200).json({ success: true, data: calls });
});

// =========================================================
// GET /api/calls/:id
// =========================================================
callsRouter.get("/:id", async (req: Request, res: Response) => {
  const call = await prisma.call.findUnique({ where: { id: req.params.id } });

  if (!call) {
    return res.status(404).json({ success: false, error: "Call not found" });
  }

  res.status(200).json({ success: true, data: call });
});
