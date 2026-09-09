import { useEffect, useState } from "react";
import type { AppState } from "../global.js";
import { appendDictation } from "../core/dictation.js";
import { supportsContinuation } from "../core/continuation.js";
import { DictationControl } from "./DictationControl.js";
import { PeerVersionControl } from "./PeerVersionControl.js";
import { PendingStatus } from "./PendingStatus.js";
import type { Language } from "./i18n.js";
import { StableDetails } from "./StableDetails.js";

const labels = {
  ru: { title: "Продолжить этот разговор", placeholder: "Что уточнить или добавить? Например: «Я не понял итог. Попроси объяснить на конкретном примере».", hint: "Ваш агент учтёт прежний диалог и это поручение. Его новая реплика уйдёт собеседнику. Предыдущий итог сохранится.", send: "Продолжить разговор", starting: "Готовим уточнение с учётом предыдущей беседы…", waiting: "Уточнение принято. Ждём продолжения разговора; если понадобится ваш ответ, вопрос появится в «Подключении».", complete: "Продолжение завершено. Новый результат находится выше в истории.", failed: "Не удалось отправить уточнение. Поручение сохранено, можно повторить.", retry: "Повторить отправку", update: "Для продолжения нужны версии 0.3.30 или новее на обоих компьютерах.", saveError: "Не удалось сохранить черновик. Не закрывайте приложение до отправки.", error: "Не удалось продолжить разговор. Проверьте подключение и версии приложений." },
  en: { title: "Continue this conversation", placeholder: "What would you like to clarify or add? For example: “Ask for a concrete example of what this result means.”", hint: "Your agent will use the previous dialogue and this instruction. Its new message goes to your partner. The previous result stays in history.", send: "Continue conversation", starting: "Preparing a follow-up using the previous dialogue…", waiting: "Follow-up accepted. Waiting for the conversation; any question for you will appear under Connection.", complete: "Continuation finished. The new result appears above in history.", failed: "Could not send the follow-up. Your instruction is saved and can be retried.", retry: "Retry sending", update: "Both computers need version 0.3.30 or later to continue.", saveError: "Could not save the draft. Keep the app open until you send it.", error: "Could not continue. Check the connection and both app versions." },
  cs: { title: "Pokračovat v rozhovoru", placeholder: "Co chcete upřesnit nebo přidat? Například: „Požádej o konkrétní příklad, co tento závěr znamená.“", hint: "Agent zohlední předchozí rozhovor a tento pokyn. Novou zprávu odešle partnerovi. Původní závěr zůstane v historii.", send: "Pokračovat v rozhovoru", starting: "Připravujeme upřesnění podle předchozího rozhovoru…", waiting: "Pokyn přijat. Čekáme na pokračování; případná otázka pro vás se objeví v Propojení.", complete: "Pokračování dokončeno. Nový výsledek je výše v historii.", failed: "Upřesnění nelze odeslat. Pokyn je uložen, můžete to zkusit znovu.", retry: "Odeslat znovu", update: "Oba počítače potřebují verzi 0.3.30 nebo novější.", saveError: "Koncept nelze uložit. Nezavírejte aplikaci před odesláním.", error: "Nelze pokračovat. Zkontrolujte propojení a verze aplikací." },
  fr: { title: "Continuer cette conversation", placeholder: "Que voulez-vous préciser ou ajouter ? Par exemple : « Demande un exemple concret pour expliquer ce résultat. »", hint: "Votre agent utilisera le dialogue précédent et cette consigne. Son nouveau message ira au partenaire. Le résultat précédent restera dans l’historique.", send: "Continuer la conversation", starting: "Préparation de la suite à partir du dialogue précédent…", waiting: "Consigne reçue. En attente de la suite ; toute question pour vous apparaîtra dans Connexion.", complete: "Suite terminée. Le nouveau résultat apparaît plus haut.", failed: "Impossible d’envoyer la précision. Votre consigne est enregistrée ; vous pouvez réessayer.", retry: "Réessayer l’envoi", update: "Les deux ordinateurs doivent avoir la version 0.3.30 ou ultérieure.", saveError: "Impossible d’enregistrer le brouillon. Gardez l’application ouverte jusqu’à l’envoi.", error: "Impossible de continuer. Vérifiez la connexion et les versions." },
};

export function ReportContinuation({ reportId, state, language, onState, dictationBusy, onDictationBusy, conversationBusy = false, threadId, relatedReportIds = [reportId] }: { reportId: string; state: AppState; language: Language; onState: (state: AppState) => void; dictationBusy: boolean; onDictationBusy: (busy: boolean) => void; conversationBusy?: boolean; threadId?: string; relatedReportIds?: string[] }) {
  const key = threadId ? `family-bridge-thread-draft-v2:${threadId}` : `family-bridge-report-draft-v1:${reportId}`;
  const [draft, setDraft] = useState(() => { try {
    const saved = localStorage.getItem(key);
    if (saved !== null) return saved;
    return [...new Set(relatedReportIds.map(id=>localStorage.getItem(`family-bridge-report-draft-v1:${id}`)||"").filter(Boolean))].join("\n\n");
  } catch { return ""; } });
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState("");
  const [checkingVersion, setCheckingVersion] = useState(false);
  const t = labels[language];
  const request = state.continuationStates?.filter((item) => relatedReportIds.includes(item.parentReportId)).at(-1);
  const pending = request?.status === "starting" || request?.status === "waiting";
  useEffect(() => { try { localStorage.setItem(key, draft); } catch { setError(t.saveError); } }, [key, draft, t.saveError]);
  async function send(retry = false) {
    const api = window.familyBridge;
    if (!api || busy || dictationBusy || recording || pending || conversationBusy) return;
    setBusy(true); setError("");
    try {
      const next = retry && request ? await api.retryContinuation(request.id) : await api.continueReport({ reportId, requestId: crypto.randomUUID(), prompt: draft.trim() });
      onState(next);
      if (!retry) setDraft("");
    } catch { setError(t.error); }
    finally { setBusy(false); }
  }
  async function checkVersion() {
    if (!window.familyBridge || checkingVersion) return;
    setCheckingVersion(true); setError("");
    try { onState(await window.familyBridge.checkPairVersions()); }
    catch { setError(t.error); }
    finally { setCheckingVersion(false); }
  }
  return <StableDetails className="report-continuation" storageKey={`family-bridge-continuation-open:${threadId ?? reportId}`}>
    <summary>{t.title}</summary>
    <p className="muted">{t.hint}</p>
    {busy || pending ? <PendingStatus language={language}>{request?.status === "waiting" ? t.waiting : t.starting}</PendingStatus> : request && <p role="status">{request.status === "complete" ? t.complete : t.failed}</p>}
    {request?.status === "error" && <button disabled={busy || conversationBusy || dictationBusy || !supportsContinuation(state.remote.peerVersion)} onClick={() => void send(true)}>{t.retry}</button>}
    {!pending && <><textarea aria-label={t.title} placeholder={t.placeholder} maxLength={8000} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
      <DictationControl language={language} disabled={busy || dictationBusy && !recording} onText={(text) => setDraft((current) => appendDictation(current, text))} onBusyChange={(value) => { setRecording(value); onDictationBusy(value); }} />
      {!supportsContinuation(state.remote.peerVersion) && <PeerVersionControl state={state} language={language} onCheck={() => void checkVersion()} busy={checkingVersion} continuation />}
      <button className="primary" disabled={busy || conversationBusy || !draft.trim() || dictationBusy || recording || !state.remote.configured || !supportsContinuation(state.remote.peerVersion)} onClick={() => void send()}>{busy ? t.starting : t.send}</button>
    </>}
    {error && <p role="alert" className="analysis-error">{error}</p>}
  </StableDetails>;
}
