/**
 * Audio conversion between Twilio Media Streams (mulaw, 8kHz) and
 * Gemini Live (PCM16, input 16kHz / output 24kHz).
 */

function ulawDecode(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exp = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (mantissa << (exp + 3)) + (0x84 << exp);
  return sign ? -sample : sample;
}

function ulawEncode(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  if (sample < 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exp = 7;
  for (let m = 0x4000; (sample & m) === 0 && exp > 0; exp--, m >>= 1) {}
  const mantissa = (sample >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mantissa) & 0xff;
}

/** Gemini output (PCM 24kHz, base64) -> Twilio input (mulaw 8kHz, base64) */
export function geminiAudioToTwilio(pcm24kBase64: string): string {
  const pcmBuf = Buffer.from(pcm24kBase64, "base64");
  const samples = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.length / 2);
  const outLen = Math.floor(samples.length / 3); // 24kHz -> 8kHz
  const out = Buffer.alloc(outLen);
  for (let i = 0; i < outLen; i++) out[i] = ulawEncode(samples[i * 3]);
  return out.toString("base64");
}

/** Twilio input (mulaw 8kHz, base64) -> Gemini input (PCM 16kHz, base64) */
export function twilioAudioToGemini(mulawBase64: string): string {
  const mulawBuf = Buffer.from(mulawBase64, "base64");
  const pcm8k = new Int16Array(mulawBuf.length);
  for (let i = 0; i < mulawBuf.length; i++) pcm8k[i] = ulawDecode(mulawBuf[i]);

  const pcm16k = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    pcm16k[i * 2] = pcm8k[i];
    pcm16k[i * 2 + 1] = pcm8k[i];
  }
  return Buffer.from(pcm16k.buffer).toString("base64");
}
