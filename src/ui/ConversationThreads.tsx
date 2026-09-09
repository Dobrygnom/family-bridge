import type { AppState } from "../global.js";
import { conversationThreads } from "../core/conversation-threads.js";
import { ReportContinuation } from "./ReportContinuation.js";
import type { Language } from "./i18n.js";
import { useRef } from "react";
import { StableDetails } from "./StableDetails.js";

const labels = {
  ru: { live: "Разговор продолжается", done: "Обсудили", follow: "Нужно вернуться к теме", history: "Предыдущие реплики", next: "Продолжение", messages: "реплик", result: "Последний итог", draft: "Дополнить этот этап", empty: "Разговоров пока нет" },
  en: { live: "Conversation in progress", done: "Discussed", follow: "Needs follow-up", history: "Earlier messages", next: "Continuation", messages: "messages", result: "Latest result", draft: "Add to this stage", empty: "No conversations yet" },
  cs: { live: "Rozhovor pokračuje", done: "Probráno", follow: "Je potřeba se k tématu vrátit", history: "Předchozí zprávy", next: "Pokračování", messages: "zpráv", result: "Poslední závěr", draft: "Doplnit tuto část", empty: "Zatím žádné rozhovory" },
  fr: { live: "Conversation en cours", done: "Discussion terminée", follow: "À reprendre", history: "Messages précédents", next: "Suite", messages: "messages", result: "Dernière conclusion", draft: "Compléter cette étape", empty: "Aucune conversation pour le moment" },
};

export function ConversationThreads({ state, language, selectedReportId, onState, activeDictation, onDictationBusy }: {
  state: AppState; language: Language; selectedReportId: string; onState: (state: AppState) => void;
  activeDictation: string; onDictationBusy: (id: string, busy: boolean) => void;
}) {
  const threads = conversationThreads(state), t = labels[language];
  const order = useRef<string[]>([]);
  // Keep the reading position stable when a conversation receives or finishes
  // a reply. Newly arriving conversations go after the current list.
  for (const thread of threads) if (!order.current.includes(thread.id)) order.current.push(thread.id);
  threads.sort((a, b) => order.current.indexOf(a.id) - order.current.indexOf(b.id));
  const proposedLabel = { ru: "Предложили", en: "Proposed by", cs: "Navrhli", fr: "Proposé par" }[language];
  return <div className="report-cards">
    {!threads.length && <div className="empty tall">{t.empty}</div>}
    {threads.map(thread => {
      const selected = thread.stages.some(stage => stage.id === selectedReportId);
      return <article className={`report-card ${selected ? "selected-report" : ""}`} key={thread.id} data-thread-id={thread.id}>
        <StableDetails className="conversation-thread" storageKey={`family-bridge-thread-open:${thread.id}`} revealKey={selected ? selectedReportId : ""}>
          <summary className="report-heading"><strong>{thread.topic}</strong><span className="report-status">
            <span>{thread.live ? t.live : thread.latest?.completionState === "needs_follow_up" ? t.follow : t.done}</span>
            <small>{thread.messageCount} {t.messages}</small>
          </span></summary>
          {thread.latest && <div className="report-source">{proposedLabel}: <strong>{[...new Set(thread.stages.flatMap(stage => stage.report?.proposedBy ?? []))].join(" + ")}</strong></div>}
          {thread.stages.map((stage, index) => <section id={`report-${stage.id}`} className="conversation-stage" key={stage.id}>
            {index > 0 && <div className="conversation-updates-heading"><strong>{t.next}</strong><small>{stage.live ? t.live : stage.report?.completedAt ? new Date(stage.report.completedAt).toLocaleString(language) : ""}</small></div>}
            <div className="report-transcript" role="log" aria-live={stage.live ? "polite" : "off"} aria-relevant="additions text" aria-atomic="false">
              {stage.newMessages.map((message, i) => <div className={`transcript-message ${message.local ? "local" : "peer"}`} key={`${stage.id}-${i}`}><strong>{message.speaker}</strong><p>{message.text}</p></div>)}
            </div>
            {stage.report && stage.id !== thread.latest?.id && <details className="report-position-details"><summary>{t.history} · {t.result}</summary><p>{stage.report.summary}</p>{stage.report.comparison && <p>{stage.report.comparison}</p>}</details>}
          </section>)}
          {!thread.live && thread.latest && <>
            <details className="report-position-details"><summary>{t.result}</summary><p>{thread.latest.summary}</p>{thread.latest.comparison && <p>{thread.latest.comparison}</p>}</details>
          </>}
          {thread.latest && <ReportContinuation threadId={thread.id} relatedReportIds={thread.stages.map(stage=>stage.id)} reportId={thread.latest.id} state={state} language={language} onState={onState} conversationBusy={thread.live} dictationBusy={Boolean(activeDictation)} onDictationBusy={busy=>onDictationBusy(thread.id,busy)} />}
        </StableDetails>
      </article>;
    })}
  </div>;
}
