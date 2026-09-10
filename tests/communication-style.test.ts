import assert from "node:assert/strict";
import test from "node:test";
import { selectCommunicationExamples } from "../src/core/communication-style.js";
import { naturalDialogueStyleRules } from "../src/core/agent-context-rules.js";
import { buildInitialPrompt, buildResumeInvocation } from "../src/core/codex-runtime.js";

test("style sampling spans the archive, preserves complete messages, and never rewrites source", () => {
  const messages = Array.from({ length: 120 }, (_, i) => ({ text: `Сообщение ${i}: Мне важно объяснить, что я имею в виду, и понять твой ответ.` }));
  const source = messages.map(m => JSON.stringify(m)).join("\n");
  const selected = selectCommunicationExamples(source).split("\n").map(l => JSON.parse(l).text);
  assert.equal(selected.length, 24);
  assert.ok(selected.some(t => t.includes("Сообщение 2:")));
  assert.ok(selected.some(t => t.includes("Сообщение 117:")));
  assert.equal(new Set(selected).size, selected.length);
  assert.ok(selected.every(text => messages.some(m => m.text === text)));
  assert.equal(source, messages.map(m => JSON.stringify(m)).join("\n"));
});

test("broken lines, quoted speakers and code do not become speech examples", () => {
  const own = "Мне важно, чтобы мы могли объяснить друг другу, что чувствуем.";
  const lines = ['{"text":', JSON.stringify({text: `> Чужая цитата — это не стиль владельца.\n${own}`}), JSON.stringify({text: own}), JSON.stringify({text: "```\nconst secret = 'not human speech';\n```"}), JSON.stringify({text: "[9/9/2026 10:00] Другой человек: Чужая длинная реплика в переписке."})];
  assert.deepEqual(selectCommunicationExamples(lines.join("\n")).split("\n").map(l=>JSON.parse(l)), [{text:own}]);
  assert.match(selectCommunicationExamples("garbage"), /Примеры отсутствуют/);
});

test("initial and resumed turns carry the same non-caricature style policy", () => {
  const options={id:"dima" as const,displayName:"A",ownerName:"A",peerName:"B",perspective:"",workspace:"unused",schemaPath:"unused"};
  assert.ok(buildInitialPrompt(options,"Question").includes(naturalDialogueStyleRules));
  assert.ok(buildResumeInvocation(options,"session","New reply").stdin.includes(naturalDialogueStyleRules));
  assert.match(naturalDialogueStyleRules,/не добавляй «блин»/);
  assert.match(naturalDialogueStyleRules,/не эталон стиля/);
  assert.match(naturalDialogueStyleRules,/не делай речь стерильной/);
});
