import { Type } from "@google/genai";
import { prisma } from "./prisma.js";
import type { LiveTool } from "./gemini.js";

/**
 * Appointment booking tools, exposed to Gemini Live as function-calling
 * tools during the live phone call. Each entry pairs a Gemini
 * FunctionDeclaration (what the model sees) with the actual handler that
 * runs against Postgres (what actually happens).
 *
 * Clinic rules (hard-coded here, referenced in the declarations so the
 * model knows them too):
 *   - Open 7 days a week
 *   - 10:00 - 19:00, in 30-minute slots (last bookable slot is 18:30)
 *   - One booking per specialist per slot
 */

const VALID_SPECIALISTS = ["ortho", "gyno", "cardio", "general"] as const;
type SpecialistValue = (typeof VALID_SPECIALISTS)[number];

const ACTIVE_STATUSES = ["active", "pending", "ongoing"] as const;

const OPEN_HOUR = 10; // 10:00
const CLOSE_HOUR = 19; // 19:00 (exclusive — last slot starts 18:30)
const SLOT_MINUTES = 30;

// India-only assumption (fixed UTC+05:30 offset, no DST) — override via env
// if the clinic is elsewhere.
const CLINIC_UTC_OFFSET = process.env.CLINIC_UTC_OFFSET || "+05:30";
const CLINIC_TIMEZONE = process.env.CLINIC_TIMEZONE || "Asia/Kolkata";

/** All valid slot start times for a day, e.g. ["10:00", "10:30", ..., "18:30"]. */
function generateDaySlots(): string[] {
  const slots: string[] = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
    for (let m = 0; m < 60; m += SLOT_MINUTES) {
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return slots;
}

/** Combines a clinic-local date + time into a real UTC Date instant. */
function toClinicDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time}:00${CLINIC_UTC_OFFSET}`);
}

/** Formats a UTC Date back into clinic-local "HH:mm" for comparison against slots. */
function formatClinicTime(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: CLINIC_TIMEZONE,
  }).format(d);
}

function isValidDateString(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

// ─────────────────────────────────────────────────────────────────────────
// Tool 1 — has this caller already got an appointment on the books?
// ─────────────────────────────────────────────────────────────────────────

async function checkExistingAppointment(args: { phone: string }) {
  const { phone } = args;
  if (!phone) return { error: "phone is required" };

  const appointment = await prisma.appointment.findFirst({
    where: {
      phone,
      status: { in: [...ACTIVE_STATUSES] as any },
      dateTime: { gte: new Date() },
    },
    orderBy: { dateTime: "asc" },
  });

  if (!appointment) {
    return { hasUpcomingAppointment: false };
  }

  return {
    hasUpcomingAppointment: true,
    appointment: {
      id: appointment.id,
      name: appointment.name,
      specialist: appointment.specialist,
      dateTime: appointment.dateTime.toISOString(),
      localTime: formatClinicTime(appointment.dateTime),
      status: appointment.status,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tool 2 — what's free on a given day?
// ─────────────────────────────────────────────────────────────────────────

async function checkDayAvailability(args: { date: string; specialist?: string }) {
  const { date, specialist } = args;

  if (!isValidDateString(date)) {
    return { error: "date must be in YYYY-MM-DD format" };
  }
  if (specialist && !VALID_SPECIALISTS.includes(specialist as SpecialistValue)) {
    return { error: `specialist must be one of: ${VALID_SPECIALISTS.join(", ")}` };
  }

  const dayStart = toClinicDateTime(date, "00:00");
  const dayEnd = toClinicDateTime(date, "23:59");

  const booked = await prisma.appointment.findMany({
    where: {
      dateTime: { gte: dayStart, lte: dayEnd },
      status: { in: [...ACTIVE_STATUSES] as any },
      ...(specialist ? { specialist: specialist as SpecialistValue } : {}),
    },
    select: { dateTime: true },
  });

  const bookedSlots = booked.map((b) => formatClinicTime(b.dateTime));
  const bookedSet = new Set(bookedSlots);
  const availableSlots = generateDaySlots().filter((slot) => !bookedSet.has(slot));

  return {
    date,
    specialist: specialist ?? "all",
    bookedSlots,
    availableSlots,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tool 3 — book it
// ─────────────────────────────────────────────────────────────────────────

async function bookAppointment(args: {
  name: string;
  phone: string;
  age?: number;
  specialist: string;
  date: string;
  time: string;
}) {
  const { name, phone, age, specialist, date, time } = args;

  if (!name || !phone) return { success: false, error: "name and phone are required" };
  if (!VALID_SPECIALISTS.includes(specialist as SpecialistValue)) {
    return { success: false, error: `specialist must be one of: ${VALID_SPECIALISTS.join(", ")}` };
  }
  if (!isValidDateString(date)) {
    return { success: false, error: "date must be in YYYY-MM-DD format" };
  }
  if (!generateDaySlots().includes(time)) {
    return {
      success: false,
      error: "Invalid time slot. Clinic hours are 10:00-19:00, 30-minute slots (last slot 18:30).",
    };
  }

  const dateTime = toClinicDateTime(date, time);
  if (dateTime.getTime() < Date.now()) {
    return { success: false, error: "Cannot book an appointment in the past." };
  }

  const conflict = await prisma.appointment.findFirst({
    where: {
      dateTime,
      specialist: specialist as SpecialistValue,
      status: { in: [...ACTIVE_STATUSES] as any },
    },
  });
  if (conflict) {
    return { success: false, error: "That slot is already taken for this specialist. Offer a different time." };
  }

  const appointment = await prisma.appointment.create({
    data: {
      name,
      phone,
      age: age ?? null,
      specialist: specialist as SpecialistValue,
      dateTime,
      status: "active",
    },
  });

  return {
    success: true,
    appointment: {
      id: appointment.id,
      name: appointment.name,
      phone: appointment.phone,
      specialist: appointment.specialist,
      dateTime: appointment.dateTime.toISOString(),
      localTime: formatClinicTime(appointment.dateTime),
      status: appointment.status,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Exported tool bundle — pass this straight into startLiveSession()
// ─────────────────────────────────────────────────────────────────────────

export const appointmentTools: LiveTool[] = [
  {
    declaration: {
      name: "check_existing_appointment",
      description:
        "Check whether this caller's phone number already has an upcoming (active/pending/ongoing) appointment. " +
        "Call this early in the conversation, and again whenever the caller asks about an existing booking.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          phone: { type: Type.STRING, description: "Caller's phone number, E.164 format (e.g. +919876543210)" },
        },
        required: ["phone"],
      },
    },
    handler: checkExistingAppointment,
  },
  {
    declaration: {
      name: "check_day_availability",
      description:
        "Get booked and available time slots for a given date. Clinic hours are 10:00-19:00, 7 days a week, " +
        "in 30-minute slots. Always call this BEFORE offering the caller a specific time, so you only offer slots that are actually free.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          date: { type: Type.STRING, description: "Date to check, in YYYY-MM-DD format" },
          specialist: {
            type: Type.STRING,
            description: "Optional — one of: ortho, gyno, cardio, general. Omit to see availability across all specialists.",
          },
        },
        required: ["date"],
      },
    },
    handler: checkDayAvailability,
  },
  {
    declaration: {
      name: "book_appointment",
      description:
        "Books a new appointment. Only call this AFTER you have verbally confirmed the patient's name, age, " +
        "desired specialist, and a specific date/time with the caller — and after check_day_availability confirmed that slot is free.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: "Patient's full name" },
          phone: { type: Type.STRING, description: "Patient's phone number, E.164 format" },
          age: { type: Type.NUMBER, description: "Patient's age" },
          specialist: { type: Type.STRING, description: "One of: ortho, gyno, cardio, general" },
          date: { type: Type.STRING, description: "Date in YYYY-MM-DD format" },
          time: { type: Type.STRING, description: "Time in 24-hour HH:mm format, must be a valid slot (10:00-18:30, 30-min steps)" },
        },
        required: ["name", "phone", "specialist", "date", "time"],
      },
    },
    handler: bookAppointment,
  },
];
