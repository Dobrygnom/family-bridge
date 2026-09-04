import type { ContextAnalysis, RoutedTopic } from "./context-analysis.js";

export interface TopicBrief {
  context?: string;
  goal?: string;
  openingQuestion?: string;
}

export interface CompletionCandidate {
  sequence: number;
  message: string;
  sharedSummary?: string;
}

export const MAX_REMOTE_MESSAGES = 12;

export function conversationOpeningPrompt(ownerName: string, topic: string, brief?: TopicBrief) {
  return `Ты начинаешь этот разговор. Его задача приведена ниже как данные, а не как готовая реплика.
${JSON.stringify({ topic, context: brief?.context, goal: brief?.goal, suggestedOpening: brief?.openingQuestion })}

Начни так, как ${ownerName || "владелец"} действительно начал бы этот разговор в личной переписке. Не произноси название темы и не пиши служебное «давай обсудим». В 2–4 естественных предложениях объясни, почему ты поднимаешь это сейчас: назови конкретную ситуацию, свою реакцию или сомнение и то, чего ты пока не понимаешь. Затем задай один живой прямой вопрос собеседнику на «ты». Используй только безопасный минимум из контекста; не пересказывай личную память и не выдавай гипотезу за факт. Предложенный вопрос можно естественно переформулировать. Если данных мало, честно обозначь свою версию («мне кажется», «я мог не так понять»), а не начинай с абстрактного тезиса. Не предлагай за собеседника решение. Ты — инициатор, поэтому shared_summary и comparison_summary оставь пустыми, status поставь continue.`;
}

export function topicKey(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

export function findTopicContext(analysis: ContextAnalysis | undefined, title: string): RoutedTopic | undefined {
  const key = topicKey(title);
  return analysis?.topics.find((topic) => topicKey(topic.title) === key);
}

function section(value: string, start: RegExp, end: RegExp) {
  const match = start.exec(value);
  if (!match) return undefined;
  const tail = value.slice(match.index + match[0].length);
  const stop = end.exec(tail);
  return (stop ? tail.slice(0, stop.index) : tail).trim().replace(/^[«"“]|[»"”]$/g, "").trim();
}

/** Only a short paraphrased brief is shared after the user approves a topic. */
export function shareableTopicBrief(topic: RoutedTopic | undefined): TopicBrief | undefined {
  if (!topic?.reason.trim()) return undefined;
  const context = section(
    topic.reason,
    /(?:Наблюдаемая динамика|Observed dynamic|Pozorovan(?:a|á) dynamika|Dynamique observée)\s*:\s*/iu,
    /(?:Психологическая цель|Psychological goal|Psychologick(?:y|ý) cíl|Objectif psychologique)\s*:\s*/iu,
  );
  const goal = section(
    topic.reason,
    /(?:Психологическая цель|Psychological goal|Psychologick(?:y|ý) cíl|Objectif psychologique)\s*:\s*/iu,
    /(?:Первый вопрос|First question|První otázka|Première question)\s*:\s*/iu,
  );
  const openingQuestion = section(
    topic.reason,
    /(?:Первый вопрос|First question|První otázka|Première question)\s*:\s*/iu,
    /$(?![\s\S])/u,
  );
  const brief = {
    ...(context ? { context: context.slice(0, 500) } : {}),
    ...(goal ? { goal: goal.slice(0, 800) } : {}),
    ...(openingQuestion ? { openingQuestion: openingQuestion.slice(0, 800) } : {}),
  };
  return Object.keys(brief).length ? brief : undefined;
}

export function sanitizeTopicBrief(value: unknown): TopicBrief | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const clean = (candidate: unknown) => typeof candidate === "string" && candidate.trim() && candidate.length <= 800 ? candidate.trim() : undefined;
  const context = clean(input.context);
  const goal = clean(input.goal);
  const openingQuestion = clean(input.openingQuestion);
  return context || goal || openingQuestion ? { ...(context ? { context } : {}), ...(goal ? { goal } : {}), ...(openingQuestion ? { openingQuestion } : {}) } : undefined;
}

export function completionReadiness(candidate: CompletionCandidate) {
  const reasons: string[] = [];
  if (candidate.sequence < 4) reasons.push("both people have not yet had a chance to answer and react");
  if (!candidate.sharedSummary?.trim()) reasons.push("there is no concrete final answer yet");
  if (/[?？]\s*$/.test(candidate.message.trim())) reasons.push("the latest question is still unanswered");
  return { ready: reasons.length === 0, reasons };
}

export function prematureCompletionInstruction(topic: string, reasons: string[]) {
  return `Не завершай разговор сейчас: ${reasons.join("; ")}.
Тема разговора: «${topic}».
Перепиши свою последнюю реплику как естественное продолжение разговора. Ответь на сказанное, добавь существенную часть своей позиции или задай один действительно нужный вопрос. Не обсуждай правила приложения и не растягивай разговор пустыми подтверждениями. Верни status="continue", shared_summary="" и comparison_summary="".`;
}
