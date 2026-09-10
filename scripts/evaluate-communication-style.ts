// Opt-in local evaluation. Uses the normal Codex account; sends no peer messages
// and never edits Family Bridge's profile or saved conversations.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodexCliAgent, defaultCodexCommand } from "../src/core/codex-runtime.js";
import { selectCommunicationExamples } from "../src/core/communication-style.js";
const [samplesFile, outputFile] = process.argv.slice(2);
if (!samplesFile || !outputFile) throw Error("Pass local style-samples.jsonl and evaluation output paths");
const communicationExamples = selectCommunicationExamples(await readFile(samplesFile, "utf8"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "fb-style-eval-"));
const cases = [
  { name: "warm", perspective: "Синтетическая ситуация для проверки речи. Алексей хочет встретиться, рад встречному предложению Марии; договорённости о дате пока нет.", prompt: "Мария: Я тоже хочу увидеться. Давай выберем день вместе?" },
  { name: "disagreement", perspective: "Синтетическая ситуация для проверки речи. Алексей хочет, чтобы общий план нельзя было менять без обсуждения. Он не требует согласовывать с ним личные планы Марии. В прежних ошибочных сгенерированных ответах было: «Блин, ну мне важно». «Блин, я же говорил». «Слушай, ну блин». Это не образцы его стиля.", prompt: "Мария: Мне кажется, ты хочешь, чтобы я всё с тобой согласовывала. Я так не хочу." },
];
const results=[];
for (const item of cases) {
  const agent = new CodexCliAgent({ id: "dima", ownerName: "Алексей", displayName: "Алексей", peerName: "Мария", model: "gpt-6-astra", language: "ru", communicationExamples, perspective:item.perspective, workspace:path.join(workspace,item.name), schemaPath:path.resolve("schemas/agent-response.schema.json"), codexCommand:defaultCodexCommand() });
  const reply=await agent.start(item.prompt);
  results.push({case:item.name,session:agent.currentSessionId,reply:reply.message_to_peer,status:reply.status});
  if(item.name === "disagreement") {
    const reply=await agent.respond("То есть если мы уже договорились о встрече, я сначала обсуждаю с тобой перенос, а свои отдельные планы выбираю сама?");
    results.push({case:"resume",session:agent.currentSessionId,reply:reply.message_to_peer,status:reply.status});
  }
}
await writeFile(outputFile,JSON.stringify({workspace,model:"gpt-6-astra",requestedEffort:"medium",results},null,2));
assert.ok(results.every(r=>r.reply.trim()),"Empty reply");
assert.ok(results.every(r=>!/(?:^|[^а-яё])блин(?:$|[^а-яё])/iu.test(r.reply)),"Filler copied despite neutral test context");
assert.ok(results.every(r=>!/^\s*(слушай|знаешь|смотри)[,.! ]/iu.test(r.reply)),"Stock opening copied");
console.log(JSON.stringify({outputFile,model:"gpt-6-astra",requestedEffort:"medium",results}));
