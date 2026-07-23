import { Type } from "@google/genai";
import { prisma } from "./prisma.js";
import type { LiveTool } from "./gemini.js";

/**
 * Minimal Gemini Live tools for the lead-gen agent — just two:
 *   save_call_summary — persists the call outcome onto the Lead row
 *   hangup_call       — ends the call (provider hangup handled by callSession)
 */

const VALID_STATUSES = ["active", "pending", "ongoing", "completed"] as const;
const VALID_STAGES = [
  "first_meet",
  "designing",
  "development",
  "testing",
  "debugging",
  "delivery",
] as const;

// "YYYY-MM-DD HH:mm" (IST) → UTC Date. Invalid input → null.
function istToDate(s: string): Date | null {
  const m = s.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:00+05:30`);
  return isNaN(d.getTime()) ? null : d;
}

export type CallToolsState = {
  summarySaved: boolean;
  hangupRequested: boolean;
};

export function buildCallTools(opts: {
  leadId: string;
  onHangupRequested: () => void;
}): { tools: LiveTool[]; state: CallToolsState } {
  const state: CallToolsState = { summarySaved: false, hangupRequested: false };

  async function saveCallSummary(args: Record<string, any>) {
    const { summary, status, stage, nextDate, name, budget, timeline, jobDescription } = args;
    if (!summary) return { success: false, error: "summary is required" };

    const lead = await prisma.lead.findUnique({
      where: { id: opts.leadId },
      select: { summary: true },
    });
    if (!lead) return { success: false, error: `Lead ${opts.leadId} not found` };

    const existing = Array.isArray(lead.summary) ? lead.summary : [];
    const parsedNextDate = typeof nextDate === "string" ? istToDate(nextDate) : null;

    await prisma.lead.update({
      where: { id: opts.leadId },
      data: {
        summary: [...existing, { text: summary, createdAt: new Date().toISOString() }] as any,
        status: VALID_STATUSES.includes(status) ? status : undefined,
        stage: VALID_STAGES.includes(stage) ? stage : undefined,
        // A saved call always clears the live-call lock and resets retries;
        // nextDate is whatever the AI agreed on (or null = nothing scheduled).
        nextDate: parsedNextDate,
        callMade: true,
        onCall: false,
        retry: 0,
        ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
        ...(typeof budget === "string" && budget.trim() ? { budget: budget.trim() } : {}),
        ...(typeof timeline === "string" && timeline.trim() ? { timeline: timeline.trim() } : {}),
        ...(typeof jobDescription === "string" && jobDescription.trim()
          ? { jobDescription: jobDescription.trim() }
          : {}),
      },
    });

    state.summarySaved = true;
    console.log(
      `[lead-tools] Summary saved for lead ${opts.leadId} (status=${status ?? "-"} stage=${stage ?? "-"} nextDate=${nextDate ?? "-"})`,
    );
    return { success: true, message: "Call summary saved." };
  }

  const tools: LiveTool[] = [
    {
      declaration: {
        name: "save_call_summary",
        description:
          "MUST be called once at the end of every call, before hangup_call. " +
          "Saves this call's outcome onto the lead record.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            summary: {
              type: Type.STRING,
              description: "Concise summary of this call — requirement, key points, outcome. 50-150 words.",
            },
            status: {
              type: Type.STRING,
              description: "Lead status: active | pending | ongoing | completed",
            },
            stage: {
              type: Type.STRING,
              description:
                "Project stage: first_meet | designing | development | testing | debugging | delivery",
            },
            nextDate: {
              type: Type.STRING,
              description:
                'Next call/meeting datetime "YYYY-MM-DD HH:mm" (IST). Omit only if nothing was scheduled.',
            },
            name: { type: Type.STRING, description: "Client's name, if learned on this call" },
            budget: { type: Type.STRING, description: "Budget, if discussed (e.g. \"50k-1L INR\")" },
            timeline: { type: Type.STRING, description: "Timeline, if discussed (e.g. \"1 month\")" },
            jobDescription: {
              type: Type.STRING,
              description: "What the client wants built, if learned/updated on this call",
            },
          },
          required: ["summary"],
        },
      },
      handler: saveCallSummary,
    },
    {
      declaration: {
        name: "hangup_call",
        description:
          "End the phone call. Call ONLY after saying goodbye AND after save_call_summary succeeded.",
        parameters: { type: Type.OBJECT, properties: {} },
      },
      handler: async () => {
        state.hangupRequested = true;
        opts.onHangupRequested();
        return { success: true, message: "Ending the call now." };
      },
    },
  ];

  return { tools, state };
}
