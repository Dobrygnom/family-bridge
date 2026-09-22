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
  ru: { title: "Продолжить этот разговор", placeholder: "Что уточнить или добавить? Например: «Я не понял итог. Попроси объяснить на конкретном примере».", hint: "Сначала помощник подготовит реплику. Вы увидите и сможете изменить её до отправки.", send: "Подготовить реплику", approve: "Отправить", preview: "Проверьте реплику перед отправкой", starting: "Готовим уточнение с учётом предыдущего разговора…", waiting: "Уточнение принято. Новые реплики появятся здесь автоматически; если понадобится ваш ответ, приложение сообщит.", complete: "Продолжение завершено. Новый итог находится выше.", failed: "Не удалось отправить уточнение. Оно сохранено — можно повторить.", retry: "Повторить отправку", update: "Обновите Family Bridge на обоих компьютерах, чтобы продолжить.", saveError: "Не удалось сохранить черновик. Не закрывайте приложение до отправки.", error: "Не удалось продолжить разговор. Проверьте связь и повторите." },
  en: { title: "Continue this conversation", placeholder: "What would you like to clarify or add? For example: “Ask for a concrete example of what this result means.”", hint: "Your assistant will prepare a message first. You can review and edit it before sending.", send: "Prepare message", approve: "Send", preview: "Review the message before sending", starting: "Preparing a follow-up using the previous conversation…", waiting: "Follow-up accepted. New messages will appear here automatically; the app will notify you if your answer is needed.", complete: "Continuation finished. The new result appears above.", failed: "Could not send the follow-up. It is saved and can be retried.", retry: "Retry sending", update: "Update Family Bridge on both computers to continue.", saveError: "Could not save the draft. Keep the app open until you send it.", error: "Could not continue. Check the connection and retry." },
  cs: { title: "Pokračovat v rozhovoru", placeholder: "Co chcete upřesnit nebo přidat? Například: „Požádej o konkrétní příklad, co tento závěr znamená.“", hint: "Pomocník nejprve připraví zprávu. Před odesláním ji můžete zkontrolovat a upravit.", send: "Připravit zprávu", approve: "Odeslat", preview: "Zkontrolujte zprávu před odesláním", starting: "Připravujeme upřesnění podle předchozího rozhovoru…", waiting: "Pokyn byl přijat. Nové zprávy se zobrazí automaticky; aplikace vás upozorní, pokud bude potřeba vaše odpověď.", complete: "Pokračování dokončeno. Nový výsledek je výše.", failed: "Upřesnění nelze odeslat. Je uložené a odeslání lze zopakovat.", retry: "Odeslat znovu", update: "Pro pokračování aktualizujte Family Bridge na obou počítačích.", saveError: "Koncept nelze uložit. Nezavírejte aplikaci před odesláním.", error: "Nelze pokračovat. Zkontrolujte spojení a zkuste to znovu." },
  fr: { title: "Continuer cette conversation", placeholder: "Que voulez-vous préciser ou ajouter ? Par exemple : « Demande un exemple concret pour expliquer ce résultat. »", hint: "L’assistant prépare d’abord un message. Vous pourrez le vérifier et le modifier avant l’envoi.", send: "Préparer le message", approve: "Envoyer", preview: "Vérifiez le message avant l’envoi", starting: "Préparation de la suite à partir de la conversation précédente…", waiting: "Consigne reçue. Les nouveaux messages apparaîtront automatiquement ; l’application vous préviendra si votre réponse est nécessaire.", complete: "Suite terminée. Le nouveau résultat apparaît plus haut.", failed: "Impossible d’envoyer la précision. Elle est enregistrée et peut être renvoyée.", retry: "Réessayer l’envoi", update: "Mettez à jour Family Bridge sur les deux ordinateurs pour continuer.", saveError: "Impossible d’enregistrer le brouillon. Gardez l’application ouverte jusqu’à l’envoi.", error: "Impossible de continuer. Vérifiez la connexion et réessayez." },
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
  const [previewDraft, setPreviewDraft] = useState("");
  const t = labels[language];
  const latestRequest = state.continuationStates?.filter((item) => relatedReportIds.includes(item.parentReportId)).at(-1);
  const request = latestRequest?.mode === "restart" ? undefined : latestRequest;
  const pending = latestRequest?.status === "starting" || latestRequest?.status === "waiting";
  useEffect(() => { if (request?.status === "preview" && request.previewText) setPreviewDraft(request.previewText); }, [request?.status, request?.previewText]);
  useEffect(() => { try { localStorage.setItem(key, draft); } catch { setError(t.saveError); } }, [key, draft, t.saveError]);
  async function send(retry = false) {
    const api = window.familyBridge;
    if (!api || busy || dictationBusy || recording || pending || conversationBusy) return;
    setBusy(true); setError("");
    try {
      const next = retry && request ? await api.retryContinuation(request.id) : await api.continueReport({ reportId, requestId: crypto.randomUUID(), prompt: draft.trim(), preview: true });
      onState(next);
      if (!retry) setDraft("");
    } catch (err) { setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : t.error); }
    finally { setBusy(false); }
  }
  async function approve() {
    if (!window.familyBridge || !request || !previewDraft.trim() || busy) return;
    setBusy(true); setError("");
    try { onState(await window.familyBridge.approveContinuation({ id:request.id, text:previewDraft.trim() })); }
    catch (err) { setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") : t.error); }
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
    {busy || pending && latestRequest?.mode !== "restart" ? <PendingStatus language={language}>{request?.status === "waiting" ? t.waiting : t.starting}</PendingStatus> : request && <p role="status">{request.status === "complete" ? t.complete : t.failed}</p>}
    {request?.status === "error" && <button disabled={busy || conversationBusy || dictationBusy || !supportsContinuation(state.remote.peerVersion)} onClick={() => void send(true)}>{t.retry}</button>}
    {request?.status === "preview" && <div className="continuation-preview"><label>{t.preview}<textarea aria-label={t.preview} maxLength={8000} value={previewDraft} disabled={busy} onChange={event=>setPreviewDraft(event.target.value)} /></label><button className="primary" disabled={busy || !previewDraft.trim()} onClick={()=>void approve()}>{t.approve}{state.remote.peerName ? ` · ${state.remote.peerName}` : ""}</button></div>}
    {!pending && request?.status !== "preview" && <><textarea aria-label={t.title} placeholder={t.placeholder} maxLength={8000} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} />
      <DictationControl language={language} disabled={busy || dictationBusy && !recording} onText={(text) => setDraft((current) => appendDictation(current, text))} onBusyChange={(value) => { setRecording(value); onDictationBusy(value); }} />
      {!supportsContinuation(state.remote.peerVersion) && <PeerVersionControl state={state} language={language} onCheck={() => void checkVersion()} busy={checkingVersion} continuation />}
      <button className="primary" disabled={busy || conversationBusy || !draft.trim() || dictationBusy || recording || !state.remote.configured || !supportsContinuation(state.remote.peerVersion)} onClick={() => void send()}>{busy ? t.starting : t.send}</button>
    </>}
    {error && <p role="alert" className="analysis-error">{error}</p>}
  </StableDetails>;
}
