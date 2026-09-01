import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildInitialPrompt, buildResumeInvocation, buildStartInvocation, CodexCliAgent, hasRoleVoiceViolation } from "../src/core/codex-runtime.js";

test("agent prompt carries the selected language and lets the app infer style from chat samples", () => {
  const prompt = buildInitialPrompt({
    id: "katya",
    displayName: "Alex",
    ownerName: "Alex",
    peerName: "Sam",
    perspective: "Локальный контекст",
    communicationExamples: '{"message_id":"1","text":"быстро. два вопроса"}',
    language: "cs",
    workspace: "unused",
    schemaPath: "unused",
  }, "Начальное сообщение");

  assert.match(prompt, /Язык сессии: чешском/);
  assert.match(prompt, /говоришь от первого лица как Alex/);
  assert.match(prompt, /к Sam обращайся напрямую/);
  assert.match(prompt, /быстро\. два вопроса/);
  assert.match(prompt, /Самостоятельно определи/);
  assert.match(prompt, /Примеры задают только форму речи/);
  assert.match(prompt, /результат должен звучать так, чтобы владелец узнал свою манеру/);
  assert.match(prompt, /shared_summary: максимум 240 символов/);
  assert.match(prompt, /comparison_summary видит только интерфейс/);
  assert.match(prompt, /не изобрести регламент/);
  assert.match(prompt, /всегда говори о нём от первого лица/);
  assert.match(prompt, /к Sam обращайся напрямую на «ты»/);
  assert.match(prompt, /owner_question/);
  assert.match(prompt, /не хватает важного факта/);
});

test("third-person mediator speech is rejected while direct role speech is accepted", () => {
  const base = { status: "continue" as const, owner_question: "", topics: [], private_report: "", shared_summary: "" };
  assert.equal(hasRoleVoiceViolation({ ...base, message_to_peer: "Катя и Дмитрий могут выбрать общий ритм. Это содержательный общий результат." }, "Дмитрий", "Катя"), true);
  assert.equal(hasRoleVoiceViolation({ ...base, message_to_peer: "Агент Катя, предлагаю обсудить правила." }, "Дмитрий", "Катя"), true);
  assert.equal(hasRoleVoiceViolation({ ...base, message_to_peer: "Мне важно понять, чего ты хочешь до своего возвращения. Скажи прямо?" }, "Дмитрий", "Катя"), false);
});

test("large agent context is piped through stdin instead of the Windows command line", () => {
  const longContext = "контекст ".repeat(20_000);
  const options = {
    id: "dima" as const,
    displayName: "Dmitrii",
    perspective: longContext,
    communicationExamples: longContext,
    workspace: "C:\\family-bridge\\agent",
    schemaPath: "C:\\family-bridge\\agent-response.schema.json",
  };

  const start = buildStartInvocation(options, "Обсудить тему");
  assert.equal(start.args.at(-1), "-");
  assert.ok(start.stdin.length > 300_000);
  assert.ok(start.args.every((argument) => !argument.includes(longContext.slice(0, 100))));
  assert.ok(start.args.join(" ").length < 1_000);

  const resume = buildResumeInvocation(options, "session-id", longContext);
  assert.equal(resume.args.at(-1), "-");
  assert.equal(resume.stdin, longContext);
  assert.ok(resume.args.join(" ").length < 1_000);
});

test("Windows agent process receives a large context without ENAMETOOLONG", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "family-bridge-stdin-"));
  try {
    const fakeRuntime = path.join(root, "fake-codex.mjs");
    const command = path.join(root, "codex.cmd");
    await writeFile(fakeRuntime, `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  if (input.length < 300000) process.exit(2);
  console.log(JSON.stringify({ type: "thread.started", thread_id: "stdin-test-session" }));
  const response = JSON.stringify({ message_to_peer: "ok", status: "continue", owner_question: "", topics: [], private_report: "", shared_summary: "" });
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: response } }));
});
`, "utf8");
    await writeFile(command, `@echo off\r\n"${process.execPath}" "${fakeRuntime}" %*\r\n`, "utf8");
    const longContext = "личная память ".repeat(30_000);
    const agent = new CodexCliAgent({
      id: "dima",
      displayName: "Dmitrii",
      perspective: longContext,
      communicationExamples: longContext,
      workspace: path.join(root, "workspace"),
      schemaPath: path.join(root, "schema.json"),
      codexCommand: command,
    });

    const response = await agent.start("Обсудить тему");
    assert.equal(response.message_to_peer, "ok");
    assert.equal(agent.currentSessionId, "stdin-test-session");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
