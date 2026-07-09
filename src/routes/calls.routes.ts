import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { normalizePhone } from "../lib/phone.js";
import { buildAppointmentSystemPrompt } from "../lib/prompt.js";
import { setPendingCall } from "../lib/pendingCalls.js";
import { initiateOutboundCall, buildVoiceTwiml } from "../lib/twilio.js";

export const callsRouter = Router();

// =========================================================
// POST /api/calls/initiate
// Body: { phone: string, name?: string }
//
// Before dialing: checks Postgres for (a) an existing upcoming
// appointment and (b) the last call summary for this phone number,
// and folds whatever it finds into the system prompt so the agent
// has full context the moment the call connects.
// =========================================================
callsRouter.post("/initiate", async (req: Request, res: Response) => {
  try {
    const { phone, name } = req.body as { phone?: string; name?: string };

    if (!phone) {
      return res.status(400).json({ success: false, error: "`phone` is required" });
    }

    const normalizedPhone = normalizePhone(phone);

    const [existingAppointment, lastCall] = await Promise.all([
      prisma.appointment.findFirst({
        where: {
          phone: normalizedPhone,
          status: { in: ["active", "pending", "ongoing"] },
          dateTime: { gte: new Date() },
        },
        orderBy: { dateTime: "asc" },
      }),
      prisma.call.findFirst({
        where: { phone: normalizedPhone },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const systemPrompt = buildAppointmentSystemPrompt({
      phone: normalizedPhone,
      lastCallSummary: lastCall?.summary ?? null,
      existingAppointment: existingAppointment
        ? {
            name: existingAppointment.name,
            specialist: existingAppointment.specialist,
            localTime: new Intl.DateTimeFormat("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
              timeZone: process.env.CLINIC_TIMEZONE || "Asia/Kolkata",
            }).format(existingAppointment.dateTime),
            dateTime: existingAppointment.dateTime.toISOString(),
          }
        : null,
    });

    setPendingCall(normalizedPhone, { systemPrompt, name: name ?? existingAppointment?.name });

    const call = await initiateOutboundCall(normalizedPhone);

    return res.status(200).json({
      success: true,
      data: {
        callSid: call.sid,
        phone: normalizedPhone,
        hasExistingAppointment: Boolean(existingAppointment),
        usedPreviousSummary: Boolean(lastCall?.summary),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/calls/initiate]", message);
    return res.status(500).json({ success: false, error: message });
  }
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

// =========================================================
// GET /api/calls/appointments?phone=...
// List saved appointments, soonest first (optional ?phone= filter)
// =========================================================
callsRouter.get("/appointments/list", async (req: Request, res: Response) => {
  const phone = (req.query.phone as string) || undefined;

  const appointments = await prisma.appointment.findMany({
    where: phone ? { phone } : undefined,
    orderBy: { dateTime: "asc" },
    take: 100,
  });

  res.status(200).json({ success: true, data: appointments });
});
