import type { AppState } from "../global.js";
import { conversationThreads } from "../core/conversation-threads.js";
import { ReportContinuation } from "./ReportContinuation.js";
import type { Language } from "./i18n.js";
import { useEffect, useRef, useState } from "react";
import { attentionLabels, unreadMessages, type ReadingState, type ConversationThread } from "../core/conversation-attention.js";
import { ReadMessage } from "./ReadMessage.js";
import { activityLabels, repairLabels } from "./conversation-status.js";
import { StableDetails } from "./StableDetails.js";
import { originLabel } from "./message-origin.js";

const labels = {
  ru: { live: "Разговор продолжается", done: "Обсудили", follow: "Нужно вернуться к теме", history: "Предыдущие реплики", next: "Продолжение", messages: "реплик", result: "Последний итог", draft: "Дополнить этот этап", empty: "Разговоров пока нет" },
  en: { live: "Conversation in progress", done: "Discussed", follow: "Needs follow-up", history: "Earlier messages", next: "Continuation", messages: "messages", result: "Latest result", draft: "Add to this stage", empty: "No conversations yet" },
  cs: { live: "Rozhovor pokračuje", done: "Probráno", follow: "Je potřeba se k tématu vrátit", history: "Předchozí zprávy", next: "Pokračování", messages: "zpráv", result: "Poslední závěr", draft: "Doplnit tuto část", empty: "Zatím žádné rozhovory" },
  fr: { live: "Conversation en cours", done: "Discussion terminée", follow: "À reprendre", history: "Messages précédents", next: "Suite", messages: "messages", result: "Dernière conclusion", draft: "Compléter cette étape", empty: "Aucune conversation pour le moment" },
};

interface Props {
  state: AppState; language: Language; selectedReportId: string; onState: (state: AppState) => void;
  activeDictation: string; onDictationBusy: (id: string, busy: boolean) => void;
  reading?: ReadingState; onRead?: (keys: string[]) => void; revealToken?: string;
}
export function ConversationThreads(props: Props) {
  const { state, language, reading } = props;
  const threads = conversationThreads(state), t = labels[language];
  const order = useRef<string[]>([]);
  if (!order.current.length) threads.sort((a,b) => Number(unreadMessages(b,reading).length > 0) - Number(unreadMessages(a,reading).length > 0));
  // Keep the reading position stable when a conversation receives or finishes
  // a reply. Newly arriving conversations go after the current list.
  for (const thread of threads) if (!order.current.includes(thread.id)) order.current.push(thread.id);
  threads.sort((a, b) => order.current.indexOf(a.id) - order.current.indexOf(b.id));
  return <div className="report-cards">
    {!threads.length && <div className="empty tall">{t.empty}</div>}
    {threads.map(thread => <ThreadCard {...props} thread={thread} key={thread.id} />)}
  </div>;
}

function ThreadCard({ state, language, selectedReportId, onState, activeDictation, onDictationBusy, reading, onRead, revealToken, thread }: Props & { thread: ConversationThread }) {
  const t = labels[language], attention = attentionLabels[language];
  const unread = unreadMessages(thread, reading);
  const unreadRef = useRef(unread); unreadRef.current = unread;
  const [open, setOpen] = useState(false), [boundary, setBoundary] = useState<string>();
  const article = useRef<HTMLElement>(null);
  const selected = thread.id === selectedReportId || thread.stages.some(stage => stage.id === selectedReportId);
  const jump = () => {
    const key = unreadRef.current[0]?.key;
    if (key) { setBoundary(current => current ?? key); document.getElementById(`message-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); }
    else article.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  useEffect(() => { if (selected) { const timer = setTimeout(jump, 80); return () => clearTimeout(timer); } }, [selected, selectedReportId, revealToken]);
  useEffect(() => { if (open && !boundary && unread.length) setBoundary(unread[0].key); }, [open, boundary, unread]);
  const activity = thread.currentStages.filter(stage => stage.live).at(-1)?.activity;
  const proposedLabel = { ru: "Предложили", en: "Proposed by", cs: "Navrhli", fr: "Proposé par" }[language];
  const authors = [...new Set(thread.stages.flatMap(stage => stage.report?.proposedBy ?? []).filter(name => name && name !== "Автор не определён"))];
  const restartLabel = { ru: "Обсуждаем заново", en: "Discussing again", cs: "Probíráme znovu", fr: "Nouvelle discussion" }[language];
  const repairLabel = { ru: "Ожидает повторного обсуждения", en: "Waiting to discuss again", cs: "Čeká na nový rozhovor", fr: "En attente d’une nouvelle discussion" }[language];
  const repairHint = { ru: "Начнём автоматически, когда оба приложения обновятся и текущий разговор завершится. Прежние ответы не будут использованы.", en: "Starts automatically once both apps are updated and the current conversation finishes. Previous replies will not be used.", cs: "Začne automaticky po aktualizaci obou aplikací a dokončení aktuálního rozhovoru. Předchozí odpovědi se nepoužijí.", fr: "Démarrera automatiquement après la mise à jour des deux applications et la fin du dialogue en cours. Les anciennes réponses seront exclues." }[language];
      const repairPending = state.repairPendingIds?.includes(thread.id);
      const status = repairPending ? state.repairWaiting?.[thread.id] ? repairLabels[language][state.repairWaiting[thread.id]] : repairLabel
        : thread.live ? activity ? activityLabels[language][activity] : t.live : thread.latest?.completionState === "needs_follow_up" ? t.follow : t.done;
      return <article ref={article} className={`report-card ${selected ? "selected-report" : ""}`} data-thread-id={thread.id}>
        <StableDetails className="conversation-thread" storageKey={`family-bridge-thread-open:${thread.id}`} revealKey={selected ? `${selectedReportId}:${revealToken ?? ""}` : ""}
          onOpenChange={value => { setOpen(value); if (!value) setBoundary(undefined); }}>
          <summary className="report-heading" onClick={event => { if (!event.currentTarget.parentElement?.hasAttribute("open")) setTimeout(jump, 50); }}><strong>{thread.topic}{unread.length > 0 && <span className="unread-badge">● {attention.new} · {unread.length}</span>}</strong><span className="report-status">
            <span>{status}</span>
            {!repairPending && <small>{thread.messageCount} {t.messages}</small>}
          </span></summary>
          {authors.length > 0 && <div className="report-source">{proposedLabel}: <strong>{authors.join(" + ")}</strong></div>}
          {repairPending && <p className="muted" role="status">{state.repairWaiting?.[thread.id] ? status : repairHint}</p>}
          {!repairPending && thread.currentStages.map((stage, index) => <section id={`report-${stage.id}`} className="conversation-stage" key={stage.id}>
            {(index > 0 || stage.restarted) && <div className="conversation-updates-heading"><strong>{stage.restarted ? restartLabel : t.next}</strong><small>{stage.live ? stage.activity ? activityLabels[language][stage.activity] : t.live : stage.report?.completedAt ? new Date(stage.report.completedAt).toLocaleString(language) : ""}</small></div>}
            <div className="report-transcript" role="log" aria-live={stage.live ? "polite" : "off"} aria-relevant="additions text" aria-atomic="false">
              {stage.newMessages.map((message, i) => {
                const key = `${stage.id}:${stage.messages.length - stage.newMessages.length + i}`;
                return <div key={key} id={`message-${key}`} className="message-anchor">
                  {boundary === key && <div className="unread-divider">{attention.since}</div>}
                  <div className={`transcript-message ${message.local ? "local" : "peer"}`}><ReadMessage messageKey={key} unread={Boolean(reading && !reading.seen[key])} onRead={onRead}><strong>{message.speaker}</strong>{message.origin && <small className="message-origin">{originLabel(message.origin, message.local, language)}</small>}<p>{message.text}</p></ReadMessage></div>
                </div>;
              })}
            </div>
            {stage.report && stage.id !== thread.latest?.id && <details className="report-position-details"><summary>{t.history} · {t.result}</summary><p>{stage.report.summary}</p>{stage.report.comparison && <p>{stage.report.comparison}</p>}</details>}
          </section>)}
          {open && unread.length > 0 && !repairPending && <button className="unread-jump ghost" onClick={jump}>↓ {attention.jump} · {unread.length}</button>}
          {!repairPending && !thread.live && thread.latest && <>
            <details className="report-position-details"><summary>{t.result}</summary><p>{thread.latest.summary}</p>{thread.latest.comparison && <p>{thread.latest.comparison}</p>}</details>
          </>}
          {!repairPending && thread.latest && <ReportContinuation threadId={thread.id} relatedReportIds={thread.stages.map(stage=>stage.id)} reportId={thread.latest.id} state={state} language={language} onState={onState} conversationBusy={thread.live} dictationBusy={Boolean(activeDictation)} onDictationBusy={busy=>onDictationBusy(thread.id,busy)} />}
        </StableDetails>
      </article>;
}
