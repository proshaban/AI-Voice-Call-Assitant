import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
  ThinkingLevel,
} from "@google/genai";

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

const ai = new GoogleGenAI({ apiKey });

// Same live model + voice as the TSK Backend calls module
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
const GEMINI_VOICE = process.env.GEMINI_VOICE || "Charon";
const TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || "gemini-2.0-flash";

export type LiveTurn = { role: "user" | "model"; text: string };

export type LiveSessionHandle = {
  sendAudioChunk: (pcm16kBase64: string) => void;
  /** Injects a text turn (e.g. "the line dropped — save the summary now"). */
  sendText: (text: string) => void;
  close: () => void;
};

type LiveSessionCallbacks = {
  onAudio: (pcm24kBase64: string) => void;
  /** Model was interrupted by the caller — flush any buffered playback. */
  onInterrupted: () => void;
  onTranscriptTurn: (turn: LiveTurn) => void;
  onClose: () => void;
  onError: (err: unknown) => void;
};

/**
 * A single Gemini Live function-calling tool: the declaration is what the
 * model sees (name/description/params), the handler is what actually runs
 * locally when the model decides to call it.
 */
export type LiveTool = {
  declaration: Record<string, unknown>;
  handler: (args: Record<string, any>) => Promise<Record<string, unknown>>;
};

/**
 * Opens a Gemini Live session for one phone call, wired up with
 * function-calling tools (save_call_summary / hangup_call).
 */
export async function startLiveSession(
  systemPrompt: string,
  callbacks: LiveSessionCallbacks,
  tools: LiveTool[] = [],
): Promise<LiveSessionHandle> {
  const toolHandlers = new Map(tools.map((t) => [t.declaration.name as string, t.handler]));

  let session: any;

  session = await ai.live.connect({
    model: LIVE_MODEL,
    // Mirrors the TSK Backend Gemini setup: Charon voice, minimal thinking,
    // and high-sensitivity voice-activity detection for snappy turn-taking.
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: systemPrompt,
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE } },
      },
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      realtimeInputConfig: {
        automaticActivityDetection: {
          disabled: false,
          startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
          prefixPaddingMs: 20,
          silenceDurationMs: 100,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      ...(tools.length
        ? { tools: [{ functionDeclarations: tools.map((t) => t.declaration) }] }
        : {}),
    },
    callbacks: {
      onmessage: async (message: any) => {
        try {
          // Caller spoke over the model — clear queued audio downstream
          if (message?.serverContent?.interrupted) {
            callbacks.onInterrupted();
          }

          // Audio output from the model
          const audioPart = message?.serverContent?.modelTurn?.parts?.find(
            (p: any) => p.inlineData?.mimeType?.startsWith("audio/"),
          );
          if (audioPart?.inlineData?.data) {
            callbacks.onAudio(audioPart.inlineData.data);
          }

          // Transcripts (used for the fallback post-call summary)
          const inputTranscript = message?.serverContent?.inputTranscription?.text;
          if (inputTranscript) {
            callbacks.onTranscriptTurn({ role: "user", text: inputTranscript });
          }
          const outputTranscript = message?.serverContent?.outputTranscription?.text;
          if (outputTranscript) {
            callbacks.onTranscriptTurn({ role: "model", text: outputTranscript });
          }

          // Tool calls — the model wants to run one of our functions
          const functionCalls = message?.toolCall?.functionCalls;
          if (functionCalls?.length) {
            const functionResponses = await Promise.all(
              functionCalls.map(async (fc: any) => {
                const handler = toolHandlers.get(fc.name);
                let response: Record<string, unknown>;
                if (!handler) {
                  response = { error: `Unknown tool: ${fc.name}` };
                } else {
                  try {
                    response = await handler(fc.args ?? {});
                  } catch (err) {
                    response = { error: (err as Error).message };
                  }
                }
                return { id: fc.id, name: fc.name, response };
              }),
            );
            session.sendToolResponse({ functionResponses });
          }
        } catch (err) {
          callbacks.onError(err);
        }
      },
      onclose: () => callbacks.onClose(),
      onerror: (err: unknown) => callbacks.onError(err),
    },
  });

  return {
    sendAudioChunk: (pcm16kBase64: string) => {
      session.sendRealtimeInput({
        audio: { data: pcm16kBase64, mimeType: "audio/pcm;rate=16000" },
      });
    },
    sendText: (text: string) => {
      try {
        session.sendClientContent({
          turns: [{ role: "user", parts: [{ text }] }],
          turnComplete: true,
        });
      } catch {
        // session already closed — ignore
      }
    },
    close: () => {
      try {
        session.close();
      } catch {
        // already closed — ignore
      }
    },
  };
}

/** Fallback: turns a raw transcript into a short call summary when the AI
 *  never managed to call save_call_summary itself. */
export async function generateCallSummary(turns: LiveTurn[]): Promise<string> {
  if (turns.length === 0) {
    return "The call connected but no meaningful conversation was recorded.";
  }

  const transcript = turns
    .map((t) => `${t.role === "user" ? "Client" : "Agent"}: ${t.text}`)
    .join("\n");

  const result = await ai.models.generateContent({
    model: TEXT_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Summarize this sales call for a software development service in 50-150 words of plain prose: what the client wants built, budget/timeline if mentioned, their interest level, and the agreed next step.\n\nTRANSCRIPT:\n${transcript}`,
          },
        ],
      },
    ],
  });

  return result.text?.trim() || "Summary could not be generated.";
}
