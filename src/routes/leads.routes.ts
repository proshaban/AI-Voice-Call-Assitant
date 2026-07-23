import { Router, Request, Response } from "express";
import { prisma } from "../lib/prisma.js";
import { normalizePhone } from "../lib/phone.js";

export const leadsRouter = Router();

const STATUSES = ["active", "pending", "ongoing", "completed"];
const STAGES = ["first_meet", "designing", "development", "testing", "debugging", "delivery"];

// =========================================================
// POST /api/leads
// Body: { name, phone, jobDescription?, budget?, timeline?, nextDate? }
// New leads are picked up by the dialer cron automatically.
// =========================================================
leadsRouter.post("/", async (req: Request, res: Response) => {
  try {
    const { name, phone, jobDescription, budget, timeline, nextDate } = req.body ?? {};
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: "`name` and `phone` are required" });
    }

    const lead = await prisma.lead.create({
      data: {
        name,
        phone: normalizePhone(String(phone)),
        jobDescription: jobDescription ?? null,
        budget: budget ?? null,
        timeline: timeline ?? null,
        nextDate: nextDate ? new Date(nextDate) : null,
      },
    });

    return res.status(201).json({ success: true, data: lead });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/leads]", message);
    return res.status(500).json({ success: false, error: message });
  }
});

// =========================================================
// GET /api/leads?status=&stage=&phone=
// =========================================================
leadsRouter.get("/", async (req: Request, res: Response) => {
  const { status, stage, phone } = req.query as Record<string, string | undefined>;

  const leads = await prisma.lead.findMany({
    where: {
      ...(status && STATUSES.includes(status) ? { status: status as any } : {}),
      ...(stage && STAGES.includes(stage) ? { stage: stage as any } : {}),
      ...(phone ? { phone: { contains: phone.replace(/\D/g, "").slice(-10) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  res.status(200).json({ success: true, data: leads });
});

// =========================================================
// GET /api/leads/:id
// =========================================================
leadsRouter.get("/:id", async (req: Request, res: Response) => {
  const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
  if (!lead) return res.status(404).json({ success: false, error: "Lead not found" });
  res.status(200).json({ success: true, data: lead });
});

// =========================================================
// PATCH /api/leads/:id
// =========================================================
leadsRouter.patch("/:id", async (req: Request, res: Response) => {
  try {
    const { name, phone, jobDescription, budget, timeline, nextDate, status, stage } =
      req.body ?? {};

    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(phone !== undefined ? { phone: normalizePhone(String(phone)) } : {}),
        ...(jobDescription !== undefined ? { jobDescription } : {}),
        ...(budget !== undefined ? { budget } : {}),
        ...(timeline !== undefined ? { timeline } : {}),
        ...(nextDate !== undefined ? { nextDate: nextDate ? new Date(nextDate) : null } : {}),
        ...(status && STATUSES.includes(status) ? { status: status as any } : {}),
        ...(stage && STAGES.includes(stage) ? { stage: stage as any } : {}),
      },
    });

    res.status(200).json({ success: true, data: lead });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ success: false, error: message });
  }
});

// =========================================================
// DELETE /api/leads/:id
// =========================================================
leadsRouter.delete("/:id", async (req: Request, res: Response) => {
  try {
    await prisma.lead.delete({ where: { id: req.params.id } });
    res.status(200).json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ success: false, error: message });
  }
});
