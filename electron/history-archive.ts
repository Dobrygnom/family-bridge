import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StoredState } from "./store.js";
import { messageSentAt } from "../src/core/continuation.js";
import { stitchMessages } from "../src/core/stitch-messages.js";

const ARCHIVE_SCHEMA = "2";

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
  type ArchiveMessage = { from?: string; text?: string; payload?: string; sentAt?: unknown; createdAt?: unknown };
  type ArchiveReport = { id: string; parentReportId?: string; restarted?: boolean; inheritedMessageCount?: number; topic: string; messages: ArchiveMessage[] };
  const reports: ArchiveReport[] = [];
  for (const reportPath of state.reports) {
    try {
      const raw = await readFile(reportPath, "utf8");
      const report = JSON.parse(raw) as { topic?: string; conversationId?: string; parentReportId?: string; restarted?: boolean; inheritedMessageCount?: number; messages?: ArchiveMessage[] };
      reports.push({ id: report.conversationId || path.basename(reportPath), parentReportId: report.parentReportId, restarted: report.restarted,
        inheritedMessageCount: report.inheritedMessageCount, topic: report.topic || "Сохранённый разговор", messages: report.messages ?? [] });
      await copyFile(reportPath, path.join(reportsRoot, safeFileName(path.basename(reportPath))));
    } catch { /* A missing legacy report must not prevent archiving the remaining history. */ }
  }
  const ordered = reports.reverse();
  for (const [id, transcript] of Object.entries(state.conversationTranscripts)) ordered.push({ id, topic: transcript.topic,
    parentReportId: state.conversationParents[id], restarted: state.conversationModes[id] === "restart",
    inheritedMessageCount: state.conversationInheritedCounts[id] ?? state.continuations[id]?.history.length, messages: transcript.messages });
  const stitched = stitchMessages(ordered, (a, b) => a.from === b.from && (a.text ?? a.payload) === (b.text ?? b.payload));
  for (const report of ordered) {
    const messages = stitched.get(report.id)?.newMessages ?? report.messages;
    if (!messages.length) continue;
    sections.push(`\n## ${report.topic}${report.parentReportId ? " — продолжение" : ""}\n\nИдентификатор: ${report.id}\n`);
    for (const message of messages) {
      const text = message.text ?? message.payload ?? "";
      if (text) sections.push(renderMessage(message.from, text, message.sentAt ?? message.createdAt));
    }
  }
  await writeFile(path.join(root, "history.md"), sections.join("\n"), "utf8");
  await writeFile(marker, JSON.stringify({ archiveSchema: ARCHIVE_SCHEMA, createdAt: snapshot.createdAt, directory: path.basename(root) }, null, 2), "utf8");
}
