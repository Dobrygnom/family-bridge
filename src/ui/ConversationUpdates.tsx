import type { AppState } from "../global.js";
import { latestContinuation } from "../core/conversation-updates.js";
import type { Language } from "./i18n.js";

const labels = {
  ru: { title: "Продолжение разговора", live: "Новые реплики появляются здесь автоматически", complete: "Разговор завершён", open: "Открыть итог этого продолжения" },
  en: { title: "Conversation continued", live: "New messages appear here automatically", complete: "Conversation completed", open: "Open this continuation’s result" },
  cs: { title: "Pokračování rozhovoru", live: "Nové zprávy se zde zobrazují automaticky", complete: "Rozhovor dokončen", open: "Otevřít výsledek tohoto pokračování" },
  fr: { title: "Suite de la conversation", live: "Les nouveaux messages apparaissent ici automatiquement", complete: "Conversation terminée", open: "Ouvrir le résultat de cette suite" },
};

export function ConversationUpdates({ reportId, state, language, onOpenReport }: {
  reportId: string; state: AppState; language: Language; onOpenReport?: (id: string) => void;
}) {
  const conversation = latestContinuation(state, reportId);
  if (!conversation?.messages.length) return null;
  const t = labels[language];
  return <section className="conversation-updates" data-conversation-id={conversation.id}>
    <div className="conversation-updates-heading"><strong>{t.title}</strong><small role="status">{conversation.complete ? t.complete : t.live}</small></div>
    <div role="log" aria-label={t.title} aria-live="polite" aria-relevant="additions text" aria-atomic="false">
      {conversation.messages.map((message, index) => <div className={`transcript-message ${message.local ? "local" : "peer"}`} key={`${conversation.id}-${index}`}>
        <strong>{message.speaker}</strong><p>{message.text}</p>
      </div>)}
    </div>
    {conversation.complete && onOpenReport && <button className="link-button" onClick={() => onOpenReport(conversation.id)}>{t.open}</button>}
  </section>;
}
