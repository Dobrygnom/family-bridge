// Opt-in, real-model regression scenarios. Synthetic data only; no app profile,
// pairing or transport. Persist output for manual semantic review, not just regex.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexContextAnalyzer, contextSourceHash } from "../src/core/context-analysis.js";
import { CodexCliAgent, defaultCodexCommand } from "../src/core/codex-runtime.js";
import { conversationOpeningPrompt, shareableTopicBrief } from "../src/core/conversation-quality.js";
import { CodexTopicRefiner } from "../src/core/topic-refinement.js";
import { preferredCodexModel } from "../src/core/codex-model.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "fb-agent-context-eval-"));
const command = defaultCodexCommand();
const model = await preferredCodexModel(command);
assert.equal(model, "gpt-6-astra", "Run the quality check on the client's available Astra");
console.log(JSON.stringify({ workspace, model }));
const persist = async (name: string, value: unknown) => {
  await writeFile(path.join(workspace, `${name}.json`), JSON.stringify(value, null, 2));
  console.log(JSON.stringify({ stage: name, result: value }));
};
const messages = [
  { created_at: "2026-08-15T08:00:00Z", text: "Меня зовут Олег, мою жену Нина. Нина давно и прямо говорит, что детей не хочет; я тоже не хочу. Мы это прояснили, вопроса сейчас нет." },
  { created_at: "2026-09-06T08:00:00Z", text: "Нина написала, что свободна со среды. Но мне не нужна расшифровка даты. Мне хочется, чтобы она сама искала возможность увидеться. Я часто предлагаю встречи и забочусь, а она тепло отвечает, но редко предлагает что-то сама. Я чувствую, что мои усилия удобны, а я сам не особенно нужен. Это моё ощущение, не знание её мотивов. Почему у нас такое разное понимание встречной инициативы?" },
  { created_at: "2026-09-06T09:00:00Z", text: "Нина говорила, что не хочет жить за городом. Я это знаю и не хочу спрашивать снова. Но мы продолжали строить дом, а теперь за провал строительства я чувствую всю ответственность на себе. Я признаю свои ошибки, но мне важно понять, как мы каждый видим свой вклад в общий выбор. Проект теперь закрыт, продажа согласована." },
  { created_at: "2026-09-06T10:00:00Z", text: "Ещё чисто бытовое: я не помню время получения посылки, нужно посмотреть SMS. Никакого конфликта или отдельной проблемы за этим нет." },
];
if (!process.argv.includes("--dialogue-only")) {
  const analysis = await new CodexContextAnalyzer(command, path.join(workspace, "analysis"), path.resolve("schemas/context-analysis.schema.json")).analyze({
    sourceId: "synthetic-separate-contexts", sourceHash: contextSourceHash(messages), ownerName: "Олег", language: "ru", messages,
  });
  await persist("discovery", analysis);
  assert.ok(analysis.topics.length >= 1 && analysis.topics.length <= 3, "Expected grounded relationship questions, not a catalogue of every fact");
  assert.ok(analysis.topics.every(t => !t.approved && shareableTopicBrief(t)?.openingQuestion));
  assert.ok(!analysis.topics.some(t => /дет|посыл|какую сред|какая сред|какого числа|хотела.*дом/i.test(t.title)), "A resolved position or bare factual lookup became a topic");
  for (const topic of analysis.topics) assert.doesNotMatch(topic.reason, /в рассказе от|06\.09\.2026|31-го/i, "Archive timestamps are not shared conversational context");

  const refiner = new CodexTopicRefiner(command, path.join(workspace, "refinement"), path.resolve("schemas/topic-refinement.schema.json"));
  const refined = await refiner.refine({ title: "Какую среду ты имела в виду?", brief: { context: "Нина написала про среду, дата неясна", openingQuestion: "Ты помнишь, что писала 31-го?" }, instruction: "Понятнее сформулируй, что здесь важно, учитывая мой контекст", privateContext: messages[1].text, language: "ru", ownerName: "Олег", recipientName: "Нина" });
  await persist("refinement", refined);
  assert.doesNotMatch(refined.openingQuestion!, /31|сред[уаы]|какую дату|помнишь/i);
}

const agent = (id: "dima" | "katya", perspective: string, suffix: string) => new CodexCliAgent({ id, displayName: id === "dima" ? "Олег" : "Нина", ownerName: id === "dima" ? "Олег" : "Нина", peerName: id === "dima" ? "Нина" : "Олег", language: "ru", perspective, communicationExamples: "Я говорю просто, короткими фразами. Без психологического жаргона.", workspace: path.join(workspace, suffix), schemaPath: path.resolve("schemas/agent-response.schema.json"), codexCommand: command, model });
const initiator = agent("dima", messages[1].text, "initiator");
// Exercise a saved, stale opening rather than only the newly generated one.
const opening = await initiator.start(conversationOpeningPrompt("Олег", "Какую среду ты имела в виду?", { context: "Не хватает встречной инициативы, хотя на предложения отвечают тепло", goal: "Понять различие в том, как мы проявляем желание быть вместе", openingQuestion: "Ты помнишь, что писала 31-го про среду?" }));
await persist("legacy-opening", opening);
assert.equal(opening.status, "continue");
assert.doesNotMatch(opening.message_to_peer, /31|какую сред|какую дату|помнишь/i);

const responder = agent("katya", "Я люблю близость с Олегом. Мне проще откликаться на предложения, чем самой планировать встречи. Я раньше прямо говорила, что могу хотеть быть рядом и при этом редко предлагать встречу первой. Конкретной переписки о среде в моём контексте нет. Я не знаю, какая дата обсуждалась и почему я тогда не предложила встречу. Других объяснений в контексте нет.", "responder");
const answer = await responder.start(opening.message_to_peer);
await persist("answer-without-shared-memory", answer);
assert.equal(answer.status, "continue");
assert.equal(answer.owner_question, "");
assert.doesNotMatch(answer.message_to_peer, /помню|забыла|в ту среду|я тогда была|31-го/i);
const followup = await responder.respond("Но почему ты тогда написала именно про среду? Какая точная дата была у тебя в голове? Без неё мы не можем договориться о встрече.");
await persist("unknown-detail-in-emotional-topic", followup);
// The original issue can still be discussed without its calendar detail. A
// truthful limit is acceptable; do not reward needless questions to the human.
assert.ok(["continue", "paused"].includes(followup.status));
assert.doesNotMatch(followup.message_to_peer, /\b(?:[1-9]|[12][0-9]|3[01])\b.*(?:сентябр|октябр)/i);
const factualResponder = agent("katya", "Нина подтвердила, что уже купила билет на поезд. Даты поездки и билета в локальном контексте нет. Никаких сведений о ней получить из других фактов невозможно. Она не разрешала выбирать дату вместо неё.", "factual-responder");
const factualAnswer = await factualResponder.start("Мы обсуждаем только встречу на вокзале по уже купленному тобой билету, а не наши отношения. Мне нужно заказать машину к твоему приезду. Какого числа у тебя поезд? Без даты билета я не могу организовать встречу; выбрать другой день или угадать дату нельзя.");
await persist("missing-critical-fact", factualAnswer);
assert.equal(factualAnswer.status, "paused", "A necessary personal fact must not be guessed by the autonomy review");
assert.ok(factualAnswer.owner_question.trim());
console.log(JSON.stringify({ checks: "passed", semanticReviewRequired: true, workspace }));
