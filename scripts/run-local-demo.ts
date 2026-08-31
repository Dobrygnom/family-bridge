import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexCliAgent, defaultCodexCommand, resolveAgentWorkspace } from "../src/core/codex-runtime.js";
import { ConversationCoordinator } from "../src/core/coordinator.js";
import { MockAgent } from "../src/core/mock-runtime.js";
import type { AgentResponse, AgentRuntime } from "../src/core/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, ".family-bridge", "demo-output");
const useMock = process.argv.includes("--mock");
const topic =
  "Как совместить потребность одного партнёра в заранее понятном плане выходных с потребностью другого сохранять гибкость";

const response = (
  message_to_peer: string,
  status: AgentResponse["status"],
  private_report = "",
  shared_summary = "",
): AgentResponse => ({
  message_to_peer,
  status,
  owner_question: "",
  topics: ["предсказуемость и гибкость"],
  private_report,
  shared_summary,
});

function mockAgents(): [AgentRuntime, AgentRuntime] {
  return [
    new MockAgent("dima", [
      response("Предлагаю обсудить минимальный каркас выходных: заранее закрепить только ключевые обязательства, оставив остальное свободным. Что важно сохранить вашей стороне?", "continue"),
      response("Согласен: до пятницы фиксируем одно обязательное семейное окно, а остальное можно менять с коротким предупреждением. Предлагаю испытать это две недели.", "complete", "Удалось сформулировать просьбу о предсказуемости без требования контролировать всё время.", "Договорённость: одно заранее подтверждённое семейное окно и свободное остальное время; тестовый срок — две недели."),
    ]),
    new MockAgent("katya", [
      response("Важно не превращать весь выходной в расписание. Я готова заранее подтвердить одно семейное окно, если остальные планы можно корректировать без обвинений.", "continue"),
      response("Такой эксперимент подходит. Добавлю условие: изменение подтверждённого окна обсуждаем, а изменение свободной части не считаем нарушением договорённости.", "complete", "Гибкость удалось сохранить, одновременно признав ценность одного надёжного ориентира.", "Договорённость: одно заранее подтверждённое семейное окно и свободное остальное время; тестовый срок — две недели."),
    ]),
  ];
}

function codexAgents(): [AgentRuntime, AgentRuntime] {
  const schemaPath = path.join(root, "schemas", "agent-response.schema.json");
  const command = defaultCodexCommand();
  return [
    new CodexCliAgent({
      id: "dima",
      displayName: "Димы",
      perspective:
        "Диме спокойнее, когда хотя бы ключевые планы известны заранее. Частые изменения в последний момент он иногда воспринимает как отсутствие надёжности, хотя не хочет контролировать всё время партнёра.",
      workspace: resolveAgentWorkspace(root, "dima"),
      schemaPath,
      codexCommand: command,
    }),
    new CodexCliAgent({
      id: "katya",
      displayName: "Кати",
      perspective:
        "Кате важна свобода корректировать необязательные планы. Жёсткое расписание она иногда воспринимает как контроль, хотя готова заранее договариваться о действительно важных обязательствах.",
      workspace: resolveAgentWorkspace(root, "katya"),
      schemaPath,
      codexCommand: command,
    }),
  ];
}

await mkdir(outputDir, { recursive: true });
const [dima, katya] = useMock ? mockAgents() : codexAgents();
const coordinator = new ConversationCoordinator(dima, katya, undefined, {
  maxTurns: 6,
  onEvent(event) {
    if (event.type === "message") {
      console.log(`\n[ход ${event.turn}] ${event.from} → ${event.to}\n${event.text}`);
    } else if (event.type === "status") {
      console.log(`[состояние] ${event.status}`);
    } else if (event.type === "error") {
      console.error(`[ошибка] ${event.error}`);
    }
  },
});

console.log(`Family Bridge demo (${useMock ? "mock" : "real Codex CLI"})`);
console.log(`Тема: ${topic}\n`);
const report = await coordinator.run(topic);
const reportPath = path.join(outputDir, `report-${Date.now()}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(`\n[готово] ${report.status}, ходов: ${report.turns}`);
console.log(`[общий итог] ${report.sharedSummary || "не сформирован"}`);
console.log(`[отчёт] ${reportPath}`);
