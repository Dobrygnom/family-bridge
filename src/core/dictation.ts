export const MAX_DICTATION_SECONDS = 120;
export const MAX_DICTATION_BYTES = 24 * 1024 * 1024;

export type DictationError = "auth" | "permission" | "microphone" | "busy" | "invalid_audio" | "empty" | "network" | "timeout" | "unavailable" | "limit" | "cancelled";
export type DictationResult = { ok: true; text: string } | { ok: false; code: DictationError };

export function appendDictation(draft: string, transcript: string): string {
  const text = transcript.trim();
  return text ? `${draft}${draft && !/\s$/.test(draft) ? " " : ""}${text}` : draft;
}

/** PCM16 mono WAV. Encoding only: speech recognition happens on OpenAI servers. */
export function encodeDictationWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const frames = channels[0]?.length ?? 0;
  if (!frames || channels.some((channel) => channel.length !== frames) || !Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000 || frames / sampleRate > MAX_DICTATION_SECONDS + 5) throw new Error("invalid_audio");
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => [...value].forEach((letter, index) => view.setUint8(offset + index, letter.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const average = channels.reduce((sum, channel) => sum + channel[i], 0) / channels.length;
    const sample = Math.max(-1, Math.min(1, Number.isFinite(average) ? average : 0));
    view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new Uint8Array(buffer);
}
