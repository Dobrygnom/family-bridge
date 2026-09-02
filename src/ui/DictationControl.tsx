import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mic, Square, X } from "lucide-react";
import { encodeDictationWav, MAX_DICTATION_SECONDS, type DictationError } from "../core/dictation.js";
import type { Language } from "./i18n.js";
import { dictationText } from "./dictation-text.js";

type Phase = "idle" | "requesting" | "recording" | "processing" | "done" | "error";
let microphoneOwner: symbol | undefined;

export function DictationControl({ language, disabled, onText, onBusyChange }: {
  language: Language; disabled?: boolean; onText: (text: string) => void; onBusyChange: (busy: boolean) => void;
}) {
  const api = window.familyBridge;
  const copy = dictationText[language];
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<DictationError>("network");
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [retryable, setRetryable] = useState(false);
  const refs = useRef({ generation: 0, mounted: true, lease: Symbol(), stream: undefined as MediaStream | undefined, recorder: undefined as MediaRecorder | undefined, context: undefined as AudioContext | undefined, timer: undefined as ReturnType<typeof setInterval> | undefined, audio: undefined as Uint8Array | undefined, requestId: "" });
  const callbacks = useRef({ onText, onBusyChange });
  callbacks.current = { onText, onBusyChange };
  const busy = ["requesting", "recording", "processing"].includes(phase);
  const alive = (generation: number) => refs.current.mounted && generation === refs.current.generation;

  function releaseMicrophone() {
    const current = refs.current;
    clearInterval(current.timer);
    current.stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    current.stream = undefined;
    if (current.context) void current.context.close().catch(() => {});
    current.context = undefined;
  }
  function releaseLease() { if (microphoneOwner === refs.current.lease) microphoneOwner = undefined; }
  function cancel(update = true) {
    const current = refs.current;
    current.generation++;
    if (current.requestId) void api?.cancelDictation(current.requestId).catch(() => {});
    current.requestId = "";
    if (current.recorder) {
      current.recorder.onstop = null; current.recorder.onerror = null; current.recorder.ondataavailable = null;
      if (current.recorder.state !== "inactive") current.recorder.stop();
      current.recorder = undefined;
    }
    releaseMicrophone(); releaseLease(); current.audio = undefined;
    if (update && current.mounted) { setPhase("idle"); setRetryable(false); setLevel(0); }
  }
  function fail(code: DictationError, generation: number) {
    if (!alive(generation)) return;
    releaseMicrophone(); releaseLease(); setError(code); setPhase("error"); setLevel(0);
    setRetryable(Boolean(refs.current.audio) && !["empty", "invalid_audio", "permission", "microphone"].includes(code));
  }
  useEffect(() => { callbacks.current.onBusyChange(busy); }, [busy]);
  useEffect(() => {
    refs.current.mounted = true;
    const unsubscribe = api?.onEvent((event) => { if ((event as { type?: string }).type === "dictation-cancelled") cancel(); });
    const onUnload = () => cancel(false);
    window.addEventListener("beforeunload", onUnload);
    return () => { refs.current.mounted = false; cancel(false); callbacks.current.onBusyChange(false); unsubscribe?.(); window.removeEventListener("beforeunload", onUnload); };
  }, [api]);

  async function transcribe(generation: number) {
    if (!api || !refs.current.audio || !alive(generation)) return;
    setPhase("processing");
    const id = crypto.randomUUID(); refs.current.requestId = id;
    try {
      const result = await api.transcribeAudio({ id, audio: refs.current.audio });
      if (!alive(generation)) return;
      if (!result.ok) { fail(result.code, generation); return; }
      callbacks.current.onText(result.text);
      refs.current.audio = undefined; setRetryable(false); setPhase("done"); releaseLease();
    } catch { fail("network", generation); }
    finally { if (refs.current.requestId === id) refs.current.requestId = ""; }
  }
  async function finish(chunks: Blob[], mimeType: string, generation: number) {
    if (!alive(generation)) return;
    releaseMicrophone();
    setPhase("processing"); setLevel(0);
    let decoder: AudioContext | undefined;
    try {
      decoder = new AudioContext();
      const audio = await decoder.decodeAudioData(await new Blob(chunks, { type: mimeType }).arrayBuffer());
      if (!alive(generation)) return;
      refs.current.audio = encodeDictationWav(Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i)), audio.sampleRate);
    } catch { fail("invalid_audio", generation); return; }
    finally { if (decoder) await decoder.close().catch(() => {}); }
    await transcribe(generation);
  }
  function stop() {
    if (refs.current.recorder?.state === "recording") { setPhase("processing"); refs.current.recorder.stop(); releaseMicrophone(); }
  }
  async function start() {
    if (disabled || !api) return;
    if (microphoneOwner && microphoneOwner !== refs.current.lease) { setError("busy"); setPhase("error"); return; }
    cancel(); microphoneOwner = refs.current.lease;
    const generation = refs.current.generation;
    setPhase("requesting"); setSeconds(0);
    try {
      if (!await api.requestMicrophone()) { fail("permission", generation); return; }
      if (!alive(generation)) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!alive(generation)) { stream.getTracks().forEach((track) => track.stop()); return; }
      refs.current.stream = stream;
      const context = new AudioContext(); refs.current.context = context; await context.resume();
      if (!alive(generation)) return;
      const analyser = context.createAnalyser(); analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      refs.current.recorder = recorder;
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => { if (event.data.size && alive(generation)) chunks.push(event.data); };
      recorder.onstop = () => { if (!alive(generation)) return; refs.current.recorder = undefined; void finish(chunks, recorder.mimeType, generation); };
      recorder.onerror = () => { cancel(); fail("microphone", refs.current.generation); };
      stream.getAudioTracks().forEach((track) => { track.onended = () => { cancel(); fail("microphone", refs.current.generation); }; });
      recorder.start(250); setPhase("recording");
      const startedAt = Date.now(); const samples = new Float32Array(analyser.fftSize);
      refs.current.timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000); setSeconds(elapsed);
        analyser.getFloatTimeDomainData(samples);
        setLevel(Math.min(1, Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length) * 5));
        if (elapsed >= MAX_DICTATION_SECONDS) stop();
      }, 100);
    } catch (reason) { fail(reason instanceof DOMException && reason.name === "NotAllowedError" ? "permission" : "microphone", generation); }
  }
  function retry() {
    if (disabled || microphoneOwner && microphoneOwner !== refs.current.lease) return;
    microphoneOwner = refs.current.lease;
    const generation = ++refs.current.generation;
    void transcribe(generation);
  }
  if (!api) return null;
  return <div className="dictation-control">
    <div className="dictation-toolbar">
      {!busy && <button type="button" className="ghost" disabled={disabled} onClick={() => void start()}><Mic size={16} />{copy.dictate}</button>}
      {phase === "recording" && <><span className="recording-dot" /><span>{copy.recording} · {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")} / 2:00</span><meter min="0" max="1" value={level} aria-label={copy.level} /><button type="button" onClick={stop}><Square size={14} />{copy.stop}</button></>}
      {(phase === "requesting" || phase === "processing") && <span role="status"><LoaderCircle size={16} className="spin" />{phase === "requesting" ? copy.requesting : copy.processing}</span>}
      {busy && <button type="button" className="ghost" onClick={() => cancel()}><X size={14} />{copy.cancel}</button>}
      {phase === "error" && retryable && <button type="button" className="ghost" disabled={disabled} onClick={retry}>{copy.retry}</button>}
    </div>
    {phase === "error" ? <p className="dictation-error" role="alert">{copy.errors[error]}</p> : <p className="dictation-hint" role={phase === "done" ? "status" : undefined}>{phase === "done" ? copy.done : copy.privacy}</p>}
  </div>;
}
