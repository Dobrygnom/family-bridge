import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.env.FAMILY_BRIDGE_LIVE_E2E !== "1") throw new Error("Set FAMILY_BRIDGE_LIVE_E2E=1 to run this ChatGPT-backed test.");
const executable = path.resolve(process.argv[2] || "release/win-unpacked/Family Bridge.exe");
assert.ok(existsSync(executable), `Packaged application not found: ${executable}`);
const profile = await mkdtemp(path.join(os.tmpdir(), "family-bridge-local-intake-"));
const port = 9331;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const child = spawn(executable, [`--remote-debugging-port=${port}`], {
  env: { ...process.env, FAMILY_BRIDGE_E2E_ALLOW_SECOND_INSTANCE: "1", FAMILY_BRIDGE_E2E_USER_DATA: profile },
  windowsHide: true,
  stdio: "ignore",
});
let socket: WebSocket | undefined;
try {
  let endpoint: string | undefined;
  for (let attempt = 0; attempt < 120 && !endpoint; attempt += 1) {
    try {
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
      endpoint = pages.find(page => page.type === "page")?.webSocketDebuggerUrl;
    } catch { /* Starting. */ }
    if (!endpoint) await delay(250);
  }
  assert.ok(endpoint, "Fresh renderer did not start");
  socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    socket!.addEventListener("open", () => resolve(), { once: true });
    socket!.addEventListener("error", () => reject(new Error("CDP connection failed")), { once: true });
  });
  let nextId = 1;
  const evaluate = <T>(expression: string) => new Promise<T>((resolve, reject) => {
    const id = nextId++;
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }; error?: { message?: string } };
      if (message.id !== id) return;
      socket!.removeEventListener("message", listener);
      const problem = message.error?.message ?? message.result?.exceptionDetails?.exception?.description ?? message.result?.exceptionDetails?.text;
      if (problem) reject(new Error(problem));
      else resolve(message.result?.result?.value as T);
    };
    socket!.addEventListener("message", listener);
    socket!.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await evaluate<boolean>("typeof window.familyBridge?.startPsychologistIntake === 'function'").catch(() => false)) break;
    if (attempt === 119) throw new Error("Preload did not initialize");
    await delay(250);
  }
  const selected = await evaluate<{ processingMode?: string }>("window.familyBridge.setProcessingMode('local').then(state => ({ processingMode: state.processingMode }))");
  assert.equal(selected.processingMode, "local");
  let intake = await evaluate<{ sessionId?: string; status: string; messages: Array<{ role: string }> }>("window.familyBridge.startPsychologistIntake().then(state => state.intake)");
  assert.match(intake.sessionId ?? "", /^[A-Za-z0-9-]{20,}$/);
  assert.equal(intake.messages.filter(message => message.role === "assistant").length, 1);
  const answers = [
    "Меня зовут Анна, моего партнёра зовут Борис. После переезда мы часто спорим о домашних делах и потом замолкаем. Я хочу спокойно договориться о распределении обязанностей и о том, как возвращаться к разговору после паузы.",
    "Мне важно не обвинять Бориса, но я устаю от неопределённости. Ему трудно обещать точное время для дел. Мы оба хотим сохранить близость и придумать реалистичный общий порядок.",
    "Больше всего мне помогло бы договориться о двух конкретных обязанностях каждого и о коротком разговоре раз в неделю. Когда один из нас перегружен, мы можем прямо об этом сказать и назначить время вернуться к теме.",
    "Да, это основной контекст. Борис — человек, с которым я хочу обсудить эти договорённости; других важных участников сейчас нет.",
  ];
  for (const answer of answers) {
    if (intake.status === "ready") break;
    intake = await evaluate(`window.familyBridge.sendPsychologistIntake(${JSON.stringify(answer)}).then(state => state.intake)`);
  }
  assert.equal(intake.status, "ready", "The natural first conversation never reached the review step");
  const result = await evaluate<{ context?: { source?: string; status?: string }; analysisStatus?: string; people?: number; topics?: number }>(
    "window.familyBridge.finalizePsychologistIntake().then(state => ({ context: state.context, analysisStatus: state.contextAnalysis?.status, people: state.contextAnalysis?.people?.length, topics: state.contextAnalysis?.topics?.length }))",
  );
  assert.equal(result.context?.source, "interview");
  assert.equal(result.context?.status, "ready");
  assert.equal(result.analysisStatus, "ready");
  // contextAnalysis.people deliberately excludes the owner; her portrait is separate.
  assert.ok((result.people ?? 0) >= 1, "The partner was not identified");
  assert.ok((result.topics ?? 0) >= 1, "No conversation topic was prepared");
  console.log(JSON.stringify({ localIntake: true, sessionId: intake.sessionId, turns: intake.messages.length, people: result.people, topics: result.topics }));
} finally {
  socket?.close();
  if (child.exitCode === null) {
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill();
    await Promise.race([exited, delay(5_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
