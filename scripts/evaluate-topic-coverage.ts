// Real-model opt-in evaluation. Synthetic data only; no app profile or transport.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodexContextAnalyzer, contextSourceHash } from "../src/core/context-analysis.js";
import { defaultCodexCommand } from "../src/core/codex-runtime.js";
import { shareableTopicBrief } from "../src/core/conversation-quality.js";
const workspace = await mkdtemp(path.join(os.tmpdir(), "fb-coverage-eval-"));
const messages = [
  { created_at: "2026-01-03T10:00:00Z", text: "Меня зовут Олег, жена Нина. В споре о фильме я подробно обосновывал мнение, а она чувствовала, что должна защищаться. Мне непонятно, почему обмен мнениями стал спором. Мы это так и не разобрали." },
  { created_at: "2026-09-01T10:00:00Z", text: "Детей мы оба не хотим, этот вопрос закрыт. Не хочу обсуждать с Ниной мои игры или мои игровые навыки — это явная граница, не предлагай обходную тему про увлечения." },
  { created_at: "2026-09-02T10:00:00Z", text: "Меня задевает, что я почти всегда предлагаю встречи. Она тепло отвечает, но мне хочется её собственной инициативы. Не нужна точная дата: она написала про среду, а задевает именно разница в желании искать контакт. Похожие чувства бывают, когда я первым пишу про свой день." },
  { created_at: "2026-09-03T10:00:00Z", text: "Ещё мне непонятна разница между приватностью и скрытностью. Мне хочется, чтобы мы могли спокойно созваниваться при других людях, не читая друг у друга личные сообщения. Не утверждаю, что она что-то скрывает." },
  { created_at: "2026-09-04T10:00:00Z", text: "Нина советует стараться ещё, когда мои усилия не дают облегчения. Я чувствую, будто сделанное не считается. Хочу понять её взгляд на поддержку. В другом эпизоде она ругала меня, когда я плохо себя чувствовал, и назвала это заботой. Мне не хватает сочувствия. Хватит предлагать мне ещё занятия для улучшения настроения, я хочу понимания, не новых советов." },
  { created_at: "2026-09-05T10:00:00Z", text: "Есть ещё вопрос к маме: она пересказывает новости о моей бывшей работе, а мне больно их слышать. Её понимание такой помощи мне неизвестно; Нину это не касается. Это другой человек. И техническое: время выдачи посылки надо посмотреть в SMS, конфликта тут нет." },
];
console.log(JSON.stringify({ workspace, stage: "starting-production-pipeline" }));
const result = await new CodexContextAnalyzer(defaultCodexCommand(), workspace, path.resolve("schemas/context-analysis.schema.json")).analyze({ sourceId: "coverage-synthetic", sourceHash: contextSourceHash(messages), ownerName: "Олег", language: "ru", messages, onProgress: p => console.log(JSON.stringify(p)) });
await writeFile(path.join(workspace, "result.json"), JSON.stringify(result, null, 2));
assert.equal(result.model, "gpt-6-astra");
assert.ok(result.topics.every(topic => !topic.approved && shareableTopicBrief(topic)?.openingQuestion));
assert.ok(result.topics.some(topic => /спор|мнени|защищ/i.test(topic.title + topic.reason)), "An old explicitly unresolved issue was dropped");
assert.ok(result.topics.some(topic => /приват|скрыт|открыт/i.test(topic.title + topic.reason)), "Separate openness question was lost");
assert.ok(result.topics.some(topic => /инициатив|встречн|контакт/i.test(topic.title + topic.reason)));
assert.ok(!result.topics.some(topic => /детей|игров|игры|посыл|какую сред/i.test(topic.title)), "Resolved, refused or bare-fact question reappeared");
assert.ok(new Set(result.topics.map(topic => topic.discussWithPersonId)).size >= 2, "Different recipients were merged");
assert.ok(result.topics.length >= 4 && result.topics.length <= 7, "Synthetic fixture should contain a handful of distinct conversations, not repeated episodes");
console.log(JSON.stringify({ stage: "passed-needs-semantic-review", topics: result.topics.length, workspace }));
