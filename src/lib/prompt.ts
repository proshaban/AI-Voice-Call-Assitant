type BuildPromptArgs = {
  name?: string | null;
  phone: string;
  lastSummary?: string | null;
};

/**
 * Builds the Gemini Live system prompt for an outbound call.
 * If a previous call summary exists for this phone number, it's appended
 * so the AI has continuity ("last time we spoke about...").
 */
export function buildSystemPrompt({ name, phone, lastSummary }: BuildPromptArgs): string {
  const base = `You are a friendly, professional AI voice assistant making an outbound phone call.
You are going to talk in Hinglish (Hindi+english).
You are speaking with ${name ? name : "the person at " + phone}.
Keep your responses short, natural, and conversational — this is a real-time voice call, not a chat.
Let the person speak, listen actively, and don't talk over them.
Stay on topic, be polite, and end the call gracefully once the conversation has reached a natural conclusion.`;

  if (!lastSummary) {
    return `${base}

This is the first time you are calling this number — there is no prior call history.`;
  }

  return `${base}

CONTEXT FROM THE PREVIOUS CALL WITH THIS PERSON:
"""
${lastSummary}
"""

Use this context naturally (e.g. reference what was discussed last time) but don't read it out verbatim.`;
}
