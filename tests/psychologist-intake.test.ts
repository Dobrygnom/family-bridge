import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PsychologistIntake } from "../electron/psychologist-intake.js";

test("psychologist intake persists every user turn before model or network execution and resumes one session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-intake-"));
  const file = path.join(directory, "intake.json");
  const calls: any[] = [];
  const intake = new PsychologistIntake(file, { run: async input => {
    calls.push(input);
    const saved = JSON.parse(await readFile(file, "utf8"));
    if (calls.length === 2) assert.equal(saved.messages.at(-1).text, "Меня зовут Анна, я хочу лучше говорить с Борисом");
    if (input.schema === "context-analysis") return { value: { people: [{ key: "owner", label: "Анна", relationship: "self", aliases: [] }, { key: "boris", label: "Борис", relationship: "муж", aliases: [] }], portraits: [], topics: [] }, sessionId: "thread-1" };
    return { value: { message: calls.length === 1 ? "Расскажите, что сейчас происходит?" : "Что в этом для вас самое трудное?", ready: calls.length > 1 }, sessionId: "thread-1" };
  } });
  try {
    let state = await intake.start("trusted", "ru");
    assert.equal(state.sessionId, "thread-1");
    state = await intake.send("Меня зовут Анна, я хочу лучше говорить с Борисом");
    assert.equal(state.status, "ready");
    assert.equal(calls[1].sessionId, "thread-1");
    const raw = await intake.finalize() as any;
    assert.equal(raw.people[1].label, "Борис");
    assert.equal(calls[2].sessionId, "thread-1");
    assert.equal(intake.snapshot().status, "complete");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed intake delivery keeps the exact pending message for retry after restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-intake-failure-"));
  const file = path.join(directory, "intake.json");
  let calls = 0;
  const executor = { run: async () => {
    calls += 1;
    if (calls === 1) return { value: { message: "Что происходит?", ready: false }, sessionId: "thread-2" };
    throw new Error("offline");
  } };
  try {
    const intake = new PsychologistIntake(file, executor);
    await intake.start("trusted");
    await assert.rejects(intake.send("Точный текст, который нельзя потерять"), /offline/);
    const restored = new PsychologistIntake(file, executor).snapshot();
    assert.equal(restored.status, "error");
    assert.equal(restored.messages.at(-1)?.text, "Точный текст, который нельзя потерять");
    assert.equal(restored.pendingMessageId, restored.messages.at(-1)?.id);
    await assert.rejects(intake.finalize(), /повторите отправку/);
    assert.equal((await readFile(file, "utf8")).includes("Точный текст, который нельзя потерять"), true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("corrupt saved intake is never treated as a new conversation or overwritten", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-intake-corrupt-"));
  const file = path.join(directory, "intake.json");
  const original = "{\"version\":1,\"messages\":[";
  try {
    await writeFile(file, original);
    assert.throws(() => new PsychologistIntake(file, { run: async () => { throw new Error("must not run"); } }), /Данные не сброшены/);
    assert.equal(await readFile(file, "utf8"), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("automatic recovery reuses the pending saved turn after a restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-intake-auto-retry-"));
  const file = path.join(directory, "intake.json");
  const keys: string[] = [];
  try {
    const first = new PsychologistIntake(file, { run: async input => {
      keys.push(input.key);
      if (keys.length === 1) return { value: { message: "Что случилось?", ready: false }, sessionId: "thread-auto" };
      throw new Error("offline");
    } });
    await first.start("trusted");
    await assert.rejects(first.send("Сохранённая реплика"), /offline/);
    const recovered = new PsychologistIntake(file, { run: async input => {
      keys.push(input.key);
      assert.equal(input.sessionId, "thread-auto");
      return { value: { message: "Расскажите подробнее", ready: false }, sessionId: "thread-auto" };
    } });
    const result = await recovered.resumePending();
    assert.equal(keys[1], keys[2], "Recovery must reuse the exact compute job");
    assert.deepEqual(result.messages.map(message => message.role), ["assistant", "user", "assistant"]);
    assert.equal(result.messages[1].text, "Сохранённая реплика");
    assert.equal(result.pendingMessageId, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a second send cannot alter a turn while its model reply is in flight", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-intake-concurrent-"));
  const file = path.join(directory, "intake.json");
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  try {
    const intake = new PsychologistIntake(file, { run: async () => {
      calls += 1;
      if (calls === 2) await blocked;
      return { value: { message: "Ответ", ready: false }, sessionId: "thread-concurrent" };
    } });
    await intake.start("trusted");
    const first = intake.send("Первая реплика");
    await assert.rejects(intake.send("Подмена"), /Разговор сейчас занят/);
    release();
    const result = await first;
    assert.deepEqual(result.messages.filter(message => message.role === "user").map(message => message.text), ["Первая реплика"]);
  } finally { release(); await rm(directory, { recursive: true, force: true }); }
});

test("retry edits the one pending turn and a completed analysis resumes from disk without another model call", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "family-bridge-intake-resume-"));
  const file = path.join(directory, "intake.json");
  let calls = 0;
  const executor = { run: async (input: any) => {
    calls += 1;
    if (calls === 1) return { value: { message: "Что происходит?", ready: false }, sessionId: "thread-3" };
    if (calls === 2) throw new Error("offline");
    if (input.schema === "context-analysis") return { value: { people: [], portraits: [], topics: [] }, sessionId: "thread-3" };
    return { value: { message: "Контекста достаточно", ready: true }, sessionId: "thread-3" };
  } };
  try {
    const intake = new PsychologistIntake(file, executor);
    await intake.start("trusted");
    await assert.rejects(intake.send("первый вариант"), /offline/);
    const retried = await intake.send("исправленный вариант");
    assert.equal(retried.messages.filter(message => message.role === "user").length, 1);
    assert.equal(retried.messages.find(message => message.role === "user")?.text, "исправленный вариант");
    assert.equal(retried.pendingMessageId, undefined);

    const analysis = await intake.finalize();
    const callsAfterFinalize = calls;
    const restored = new PsychologistIntake(file, { run: async () => { throw new Error("must not run"); } });
    assert.deepEqual(await restored.finalize(), analysis);
    assert.equal(calls, callsAfterFinalize);
    assert.equal((restored.snapshot() as any).analysis, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
