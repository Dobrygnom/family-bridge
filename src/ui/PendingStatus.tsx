import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { Language } from "./i18n.js";

/** Shows real pending work, never a simulated percentage or a claim of completion. */
export function PendingStatus({ children, language }: { children: string; language: Language }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const timer = window.setTimeout(() => setSlow(true), 20_000);
    return () => window.clearTimeout(timer);
  }, [children]);
  const hint = {
    ru: "Ответ пока не получен. Можно перейти в другой раздел — результат появится автоматически.",
    en: "No response yet. You can use another section — the result will appear automatically.",
    cs: "Odpověď zatím nepřišla. Můžete přejít do jiné sekce — výsledek se zobrazí automaticky.",
    fr: "Pas encore de réponse. Vous pouvez changer de rubrique — le résultat apparaîtra automatiquement.",
  }[language];
  return <div className="pending-status" role="status" aria-live="polite">
    <LoaderCircle className="spin" size={18} aria-hidden="true" />
    <div><span>{children}</span>{slow && <small>{hint}</small>}</div>
  </div>;
}
