import type { RoutedTopic } from "./context-analysis.js";
import { topicKey } from "./conversation-quality.js";

export interface TopicActivity {
  remote: { counterpartPersonId?: string; pairId?: string };
  activeTopics: string[];
  reportSummaries: Array<{ topic: string }>;
  liveConversations?: Array<{ topic: string }>;
  ownerQuestions?: Array<{ topic: string }>;
  topicLaunches?: Record<string, { topic: string; pairId: string }>;
}

export function topicAlreadyStarted(topic: RoutedTopic, state: TopicActivity): boolean {
  if (!state.remote.counterpartPersonId || topic.discussWithPersonId !== state.remote.counterpartPersonId) return false;
  const started = new Set([...state.activeTopics, ...state.reportSummaries.map(r => r.topic),
    ...(state.liveConversations ?? []).map(r => r.topic), ...(state.ownerQuestions ?? []).map(r => r.topic),
    ...Object.values(state.topicLaunches ?? {}).filter(job => job.pairId === state.remote.pairId).map(job => job.topic)].map(topicKey));
  return [topic.title, ...(topic.sourceTitles ?? [])].some(title => started.has(topicKey(title)));
}

export function suggestedTopics(topics: RoutedTopic[], state: TopicActivity): RoutedTopic[] {
  return topics.filter(topic => !topic.dismissed && !topicAlreadyStarted(topic, state));
}

export function dismissedTopicKeys(topics: RoutedTopic[], personId?: string): Set<string> {
  return new Set(topics.filter(t => t.dismissed && t.discussWithPersonId === personId)
    .flatMap(t => [t.title, ...(t.sourceTitles ?? [])]).map(topicKey));
}
