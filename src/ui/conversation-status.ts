import type { LiveConversation } from "../core/conversation-updates.js";
import type { Language } from "./i18n.js";
export const activityLabels: Record<Language, Record<NonNullable<LiveConversation["activity"]>, string>> = {
  ru: { preparing: "Ваш агент готовит ответ", sending: "Отправляем реплику", "waiting-peer": "Ждём ответа агента собеседника", "needs-answer": "Нужен ваш ответ", retrying: "Отправка отложена · повторим автоматически", error: "Не удалось подготовить ответ", interrupted: "Обсуждение приостановлено" },
  en: { preparing: "Your agent is preparing a reply", sending: "Sending reply", "waiting-peer": "Waiting for your partner’s agent", "needs-answer": "Your answer is needed", retrying: "Delivery delayed · will retry automatically", error: "Could not prepare a reply", interrupted: "Discussion is paused" },
  cs: { preparing: "Váš agent připravuje odpověď", sending: "Odesíláme odpověď", "waiting-peer": "Čekáme na agenta partnera", "needs-answer": "Je potřeba vaše odpověď", retrying: "Odeslání odloženo · zopakujeme automaticky", error: "Odpověď se nepodařilo připravit", interrupted: "Rozhovor je pozastaven" },
  fr: { preparing: "Votre agent prépare une réponse", sending: "Envoi de la réponse", "waiting-peer": "En attente de l’agent du partenaire", "needs-answer": "Votre réponse est nécessaire", retrying: "Envoi différé · nouvelle tentative automatique", error: "Impossible de préparer une réponse", interrupted: "Discussion en pause" },
};
export const repairLabels = {
  ru: { peer: "Ждём автоматического запуска у собеседника", version: "Ждём обновления собеседника", active: "Ждём завершения текущего продолжения", queued: "Повторное обсуждение в очереди" },
  en: { peer: "Waiting for partner’s app to start automatically", version: "Waiting for partner’s update", active: "Waiting for the current continuation to finish", queued: "New attempt is queued" },
  cs: { peer: "Čekáme na automatické zahájení u partnera", version: "Čekáme na aktualizaci partnera", active: "Čekáme na dokončení pokračování", queued: "Nový rozhovor čeká ve frontě" },
  fr: { peer: "En attente du démarrage automatique chez le partenaire", version: "En attente de la mise à jour du partenaire", active: "En attente de la fin de la suite actuelle", queued: "Nouvelle discussion en attente" },
};
