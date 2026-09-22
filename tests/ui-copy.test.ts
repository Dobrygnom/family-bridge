import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const visibleUiFiles = [
  "src/ui/App.tsx",
  "src/ui/PeerVersionControl.tsx",
  "src/ui/ReportContinuation.tsx",
  "src/ui/NewTopicComposer.tsx",
  "src/ui/conversation-status.ts",
  "src/ui/UpdateControl.tsx",
];

test("ordinary UI copy does not expose protocol versions or retired implementation language", async () => {
  const source = (await Promise.all(visibleUiFiles.map((file) => readFile(file, "utf8")))).join("\n");
  for (const forbidden of [
    /В версиях до/i,
    /Before version/i,
    /U verzí před/i,
    /Avant la version/i,
    /0\.3\.(?:30|31)/,
    /Codex CLI/i,
    /Нет свежего ответа/i,
    /Не в очереди/i,
    /Показать файлы в папке/i,
  ]) assert.doesNotMatch(source, forbidden);
});
