import { topicKey } from "./conversation-quality.js";
import { VERSION_PROBE_PREFIX } from "./peer-version.js";

export function reconcileTopicQueue(pending: string[], approved: Array<{ title: string; sourceTitles?: string[] }>, protectedTitles: string[]) {
  const protectedKeys = new Set(protectedTitles.map(topicKey));
  const result = new Map<string, string>();
  for (const title of pending) if (!title.startsWith(VERSION_PROBE_PREFIX) && !protectedKeys.has(topicKey(title))) result.set(topicKey(title), title);
  for (const topic of approved) {
    if (topic.title.startsWith(VERSION_PROBE_PREFIX) || [topic.title, ...(topic.sourceTitles ?? [])].some(title=>protectedKeys.has(topicKey(title)))) continue;
    result.set(topicKey(topic.title), topic.title);
  }
  return [...result.values()];
}
