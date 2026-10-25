import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const profile = process.argv[3] || (process.platform === "win32"
  ? path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "family-bridge")
  : process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "family-bridge")
    : path.join(os.homedir(), ".config", "family-bridge"));
const mode = process.argv[2] || "check";
if (!new Set(["check", "baseline"]).has(mode)) throw new Error("Usage: family-bridge-watch.mjs check|baseline [profile]");

const statePath = path.join(profile, "state.json");
const cursorPath = path.join(profile, "diagnostics", "tablet-notifier-cursor.json");
const state = JSON.parse(await readFile(statePath, "utf8"));
const messages = [];

function addConversation(conversationId, topic, rows) {
  if (!Array.isArray(rows)) return;
  rows.forEach((message, index) => {
    if (!message || typeof message !== "object" || message.from === state.owner || typeof message.text !== "string" || !message.text.trim()) return;
    const sentAt = typeof message.sentAt === "string" ? message.sentAt : undefined;
    const identity = [conversationId, String(message.from ?? "peer"), sentAt ?? `index:${index}`, message.text].join("\0");
    messages.push({
      key: createHash("sha256").update(identity).digest("hex"),
      conversationId,
      topic: typeof topic === "string" && topic.trim() ? topic.trim() : "Разговор без названия",
      text: message.text,
      ...(sentAt ? { sentAt } : {}),
    });
  });
}

for (const [conversationId, transcript] of Object.entries(state.conversationTranscripts ?? {})) {
  addConversation(conversationId, transcript?.topic, transcript?.messages);
}
for (const reportPath of Array.isArray(state.reports) ? state.reports : []) {
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    addConversation(String(report.conversationId ?? report.id ?? reportPath), report.topic, report.messages);
  } catch {
    // A missing legacy report must not disable notifications for current conversations.
  }
}

const unique = [...new Map(messages.map(message => [message.key, message])).values()];
let cursor;
try { cursor = JSON.parse(await readFile(cursorPath, "utf8")); } catch { cursor = undefined; }
const seen = new Set(Array.isArray(cursor?.seen) ? cursor.seen.filter(value => typeof value === "string") : []);
const fresh = mode === "baseline" || !cursor ? [] : unique.filter(message => !seen.has(message.key));
for (const message of unique) seen.add(message.key);

await mkdir(path.dirname(cursorPath), { recursive: true });
const next = {
  version: 1,
  updatedAt: new Date().toISOString(),
  seen: [...seen].slice(-5000),
};
const temporary = `${cursorPath}.tmp`;
await writeFile(temporary, JSON.stringify(next, null, 2), "utf8");
await rename(temporary, cursorPath);

console.log(JSON.stringify({
  status: mode === "baseline" || !cursor ? "baseline" : fresh.length ? "new-messages" : "unchanged",
  peerName: state.remote?.peerName || "Собеседник",
  observed: unique.length,
  newMessages: fresh.sort((a, b) => String(a.sentAt ?? "").localeCompare(String(b.sentAt ?? ""))),
  cursorPath,
}, null, 2));
