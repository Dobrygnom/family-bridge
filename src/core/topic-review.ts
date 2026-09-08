import type { RoutedTopic } from "./context-analysis.js";

export function topicNeedsReview(topic: RoutedTopic) { return topic.sensitivity !== "direct" || topic.relevance === "check_relevance"; }
export function topicRelevanceLabel(language: string) {
  return ({ ru: "Проверить актуальность", en: "Check relevance", cs: "Ověřit aktuálnost", fr: "Vérifier la pertinence" } as Record<string, string>)[language] ?? "Check relevance";
}
