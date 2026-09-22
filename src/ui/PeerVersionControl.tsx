import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { peerIsOnline } from "../core/peer-version.js";
import type { AppState } from "../global.js";
import { supportsContinuation } from "../core/continuation.js";
import type { Language } from "./i18n.js";

const labels = {
  ru: { peer: "Собеседник", check: "Проверить связь", checking: "Проверяем связь…", unknown: "Связь ещё не подтверждена", waiting: "Проверяем приложение собеседника…", timeout: "Собеседник пока не на связи. Проверка продолжится автоматически; можно повторить её сейчас.", error: "Не удалось начать проверку. Повторите позже.", received: "Связь подтверждена", last: "Последняя связь", old: "На втором компьютере нужно обновить Family Bridge, чтобы продолжить.", blocked: "Пока не удалось подтвердить, что второй компьютер готов. Ваш текст сохранён и не отправлен.", unpaired: "Сначала соедините два приложения." },
  en: { peer: "Partner", check: "Check connection", checking: "Checking connection…", unknown: "Connection not confirmed yet", waiting: "Checking your partner’s app…", timeout: "Your partner is not connected yet. Checks will continue automatically; you can retry now.", error: "Could not start the check. Try again later.", received: "Connection confirmed", last: "Last connection", old: "Family Bridge needs to be updated on the other computer before continuing.", blocked: "We have not confirmed that the other computer is ready. Your text is saved and has not been sent.", unpaired: "Connect the two apps first." },
  cs: { peer: "Partner", check: "Ověřit spojení", checking: "Ověřujeme spojení…", unknown: "Spojení zatím není potvrzené", waiting: "Ověřujeme aplikaci partnera…", timeout: "Partner zatím není připojený. Kontrola bude pokračovat automaticky; nyní ji můžete zopakovat.", error: "Kontrolu se nepodařilo spustit. Zkuste to později.", received: "Spojení potvrzeno", last: "Poslední spojení", old: "Pro pokračování je třeba na druhém počítači aktualizovat Family Bridge.", blocked: "Zatím jsme nepotvrdili, že je druhý počítač připravený. Text je uložený a nebyl odeslán.", unpaired: "Nejprve propojte aplikace." },
  fr: { peer: "Partenaire", check: "Vérifier la connexion", checking: "Vérification de la connexion…", unknown: "Connexion pas encore confirmée", waiting: "Vérification de l’application du partenaire…", timeout: "Le partenaire n’est pas encore connecté. La vérification continuera automatiquement ; vous pouvez la relancer maintenant.", error: "Impossible de lancer la vérification. Réessayez plus tard.", received: "Connexion confirmée", last: "Dernière connexion", old: "Family Bridge doit être mis à jour sur l’autre ordinateur avant de continuer.", blocked: "Nous n’avons pas encore confirmé que l’autre ordinateur est prêt. Votre texte est enregistré et n’a pas été envoyé.", unpaired: "Connectez d’abord les deux applications." },
};

export function PeerVersionControl({ state, language, onCheck, busy = false, continuation = false }: {
  state: AppState; language: Language; onCheck: () => void; busy?: boolean; continuation?: boolean;
}) {
  const t = labels[language];
  const remote = state.remote;
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5_000); return () => clearInterval(timer); }, []);
  const online = remote.configured && peerIsOnline(remote.peerPresenceAt, now);
  const presence = {
    ru: { online: "Приложение на связи", offline: "Сейчас не на связи", hint: "Статус показывает доступность приложения, а не присутствие человека у экрана." },
    en: { online: "App connected", offline: "Not connected right now", hint: "This shows whether the app is reachable, not whether the person is at the screen." },
    cs: { online: "Aplikace je připojená", offline: "Nyní nepřipojeno", hint: "Stav ukazuje dostupnost aplikace, ne přítomnost člověka u obrazovky." },
    fr: { online: "Application connectée", offline: "Pas connecté pour le moment", hint: "Cet état indique si l’application est joignable, pas si la personne est devant l’écran." },
  }[language];
  const checking = busy || remote.peerVersionCheck?.status === "checking";
  const status = remote.peerVersionCheck?.status;
  const known = Boolean(remote.peerVersion);
  const blocked = continuation && !supportsContinuation(remote.peerVersion);
  const lastReply = remote.peerLastSeenAt && Number.isFinite(Date.parse(remote.peerLastSeenAt))
    ? new Date(remote.peerLastSeenAt).toLocaleString(language) : undefined;
  return <div className="peer-version-control">
    <div className="peer-version-heading"><strong>{remote.peerName || t.peer}</strong><span>{known ? `v${remote.peerVersion}` : t.unknown}</span></div>
    {remote.configured && <small className={`peer-presence ${online ? "online" : "offline"}`} title={presence.hint} role="status"><span aria-hidden="true">●</span> {online ? presence.online : presence.offline}</small>}
    {lastReply && <small>{t.last}: {lastReply}</small>}
    {blocked && <p className="peer-version-warning">{known ? t.old : t.blocked}</p>}
    {!remote.configured && <p>{t.unpaired}</p>}
    <button type="button" className="ghost pair-version-check" disabled={checking || !remote.configured} onClick={onCheck}>
      <RefreshCw className={checking ? "spin" : ""} size={15} />{checking ? t.checking : t.check}
    </button>
    <p role="status" aria-live="polite">{checking ? t.waiting : status === "timeout" ? t.timeout : status === "error" ? t.error : status === "received" ? t.received : ""}</p>
  </div>;
}
