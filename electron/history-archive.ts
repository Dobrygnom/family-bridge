import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StoredState } from "./store.js";
import { messageSentAt } from "../src/core/continuation.js";

const ARCHIVE_SCHEMA = "1";

function safeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180);
}

function renderMessage(from: string | undefined, text: string, sentAt: unknown) {
  const time = messageSentAt(sentAt);
  return `**${from || "Участник"} · ${time ?? "Время неизвестно"}**\n\n${text}\n`;
}

/** Creates a local, credential-free archive before state migrations. */
export async function archiveConversationHistory(userData: string, state: StoredState, appVersion = "development") {
  const marker = path.join(userData, "history-archives", `schema-${ARCHIVE_SCHEMA}.completed`);
  try { await readFile(marker, "utf8"); return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(userData, "history-archives", `${stamp}-before-${appVersion}`);
  const reportsRoot = path.join(root, "reports");
  await mkdir(reportsRoot, { recursive: true });
  const snapshot = {
    archiveSchema: ARCHIVE_SCHEMA, createdAt: new Date().toISOString(), appVersion,
    owner: state.owner, displayName: state.displayName, peerName: state.remote?.peerName,
    reports: state.reports.map(report => path.basename(report)), conversationTranscripts: state.conversationTranscripts,
    conversationParents: state.conversationParents, conversationModes: state.conversationModes,
    conversationInheritedCounts: state.conversationInheritedCounts, topicBriefs: state.topicBriefs,
  };
  await writeFile(path.join(root, "history.json"), JSON.stringify(snapshot, null, 2), "utf8");
  const sections: string[] = [`# Family Bridge — архив разговоров\n\nСоздан: ${snapshot.createdAt}\nВерсия приложения: ${appVersion}\n`];
  for (const [id, transcript] of Object.entries(state.conversationTranscripts)) {
    sections.push(`\n## ${transcript.topic}\n\nИдентификатор: ${id}\n`);
    for (const message of transcript.messages) sections.push(renderMessage(message.from, message.text, message.sentAt));
  }
  for (const reportPath of state.reports) {
    try {
      const raw = await readFile(reportPath, "utf8");
      const report = JSON.parse(raw) as { topic?: string; conversationId?: string; messages?: Array<{ from?: string; text?: string; payload?: string; sentAt?: unknown; createdAt?: unknown }> };
      sections.push(`\n## ${report.topic || "Сохранённый разговор"}\n\nИдентификатор: ${report.conversationId || "неизвестен"}\n`);
      for (const message of report.messages ?? []) {
        const text = message.text ?? message.payload ?? "";
        if (text) sections.push(renderMessage(message.from, text, message.sentAt ?? message.createdAt));
      }
      await copyFile(reportPath, path.join(reportsRoot, safeFileName(path.basename(reportPath))));
    } catch { /* A missing legacy report must not prevent archiving the remaining history. */ }
  }
  await writeFile(path.join(root, "history.md"), sections.join("\n"), "utf8");
  await writeFile(marker, JSON.stringify({ archiveSchema: ARCHIVE_SCHEMA, createdAt: snapshot.createdAt, directory: path.basename(root) }, null, 2), "utf8");
}
