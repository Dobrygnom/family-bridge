import type { MessageOrigin } from "../core/continuation.js";
import type { Language } from "./i18n.js";
const labels = {
  ru: { agent: "Реплика агента", continuation: ["По вашему дополнению", "По дополнению собеседника"], "owner-answer": ["По вашему ответу", "По ответу собеседника"] },
  en: { agent: "Agent reply", continuation: ["From your follow-up", "From your partner’s follow-up"], "owner-answer": ["From your answer", "From your partner’s answer"] },
  cs: { agent: "Odpověď agenta", continuation: ["Podle vašeho doplnění", "Podle doplnění partnera"], "owner-answer": ["Podle vaší odpovědi", "Podle odpovědi partnera"] },
  fr: { agent: "Réponse de l’agent", continuation: ["D’après votre ajout", "D’après l’ajout du partenaire"], "owner-answer": ["D’après votre réponse", "D’après la réponse du partenaire"] },
};
export function originLabel(origin: MessageOrigin | undefined, local: boolean, language: Language) {
  return origin ? origin === "agent" ? labels[language].agent : labels[language][origin][local ? 0 : 1] : undefined;
}
