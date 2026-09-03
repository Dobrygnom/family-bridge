import { RefreshCw } from "lucide-react";
import type { AppState } from "../global.js";
import { supportsContinuation } from "../core/continuation.js";
import type { Language } from "./i18n.js";

const labels = {
  ru: { peer: "Собеседник", check: "Проверить версию собеседника", checking: "Запрашиваем версию…", unknown: "Версия ещё не получена", waiting: "Запрос отправляется. Ждём ответ от приложения собеседника…", timeout: "Ответ пока не получен. Приложение может быть закрыто, без сети или занято. Можно проверить ещё раз; поздний ответ появится автоматически.", error: "Не удалось отправить запрос. Проверьте соединение и повторите.", received: "Версия подтверждена приложением собеседника", last: "Последний ответ", old: "Для продолжения собеседнику нужно обновиться до 0.3.30 или новее.", blocked: "Продолжение пока недоступно: сначала нужно получить версию собеседника. Ваш текст не отправлен.", unpaired: "Сначала соедините два приложения.", legacy: "В версиях до 0.3.31 запрос также запускает у собеседника проверку обновлений." },
  en: { peer: "Partner", check: "Check partner’s version", checking: "Requesting version…", unknown: "Version not received yet", waiting: "Sending the request. Waiting for the partner’s app to reply…", timeout: "No reply yet. The app may be closed, offline, or busy. You can retry; a late reply will appear automatically.", error: "Could not send the request. Check your connection and retry.", received: "Version confirmed by the partner’s app", last: "Last reply", old: "Your partner needs version 0.3.30 or later to continue.", blocked: "Continuation is unavailable until we receive the partner’s version. Your text has not been sent.", unpaired: "Connect the two apps first.", legacy: "Before version 0.3.31, this request also checks for updates on the partner’s app." },
  cs: { peer: "Partner", check: "Ověřit verzi partnera", checking: "Zjišťujeme verzi…", unknown: "Verze zatím nebyla přijata", waiting: "Odesíláme požadavek. Čekáme na odpověď aplikace partnera…", timeout: "Odpověď zatím nepřišla. Aplikace může být zavřená, offline nebo zaneprázdněná. Můžete to zkusit znovu; pozdější odpověď se zobrazí automaticky.", error: "Požadavek nelze odeslat. Zkontrolujte připojení a zkuste to znovu.", received: "Verze potvrzená aplikací partnera", last: "Poslední odpověď", old: "Pro pokračování potřebuje partner verzi 0.3.30 nebo novější.", blocked: "Pokračování není dostupné, dokud nezjistíme verzi partnera. Váš text nebyl odeslán.", unpaired: "Nejprve propojte aplikace.", legacy: "U verzí před 0.3.31 požadavek také spustí kontrolu aktualizací u partnera." },
  fr: { peer: "Partenaire", check: "Vérifier la version du partenaire", checking: "Demande de version…", unknown: "Version pas encore reçue", waiting: "Envoi de la demande. En attente de la réponse de l’application du partenaire…", timeout: "Pas encore de réponse. L’application peut être fermée, hors ligne ou occupée. Vous pouvez réessayer ; une réponse tardive apparaîtra automatiquement.", error: "Impossible d’envoyer la demande. Vérifiez la connexion et réessayez.", received: "Version confirmée par l’application du partenaire", last: "Dernière réponse", old: "Votre partenaire doit passer à la version 0.3.30 ou ultérieure pour continuer.", blocked: "La suite attend la version du partenaire. Votre texte n’a pas été envoyé.", unpaired: "Connectez d’abord les deux applications.", legacy: "Avant la version 0.3.31, cette demande vérifie aussi les mises à jour chez le partenaire." },
};

export function PeerVersionControl({ state, language, onCheck, busy = false, continuation = false }: {
  state: AppState; language: Language; onCheck: () => void; busy?: boolean; continuation?: boolean;
}) {
  const t = labels[language];
  const remote = state.remote;
  const checking = busy || remote.peerVersionCheck?.status === "checking";
  const status = remote.peerVersionCheck?.status;
  const known = Boolean(remote.peerVersion);
  const blocked = continuation && !supportsContinuation(remote.peerVersion);
  const lastReply = remote.peerLastSeenAt && Number.isFinite(Date.parse(remote.peerLastSeenAt))
    ? new Date(remote.peerLastSeenAt).toLocaleString(language) : undefined;
  return <div className="peer-version-control">
    <div className="peer-version-heading"><strong>{remote.peerName || t.peer}</strong><span>{known ? `v${remote.peerVersion}` : t.unknown}</span></div>
    {lastReply && <small>{t.last}: {lastReply}</small>}
    {blocked && <p className="peer-version-warning">{known ? t.old : t.blocked}</p>}
    {!remote.configured && <p>{t.unpaired}</p>}
    <button type="button" className="ghost pair-version-check" disabled={checking || !remote.configured} onClick={onCheck}>
      <RefreshCw className={checking ? "spin" : ""} size={15} />{checking ? t.checking : t.check}
    </button>
    <p role="status" aria-live="polite">{checking ? t.waiting : status === "timeout" ? t.timeout : status === "error" ? t.error : status === "received" ? t.received : ""}</p>
    <small>{t.legacy}</small>
  </div>;
}
