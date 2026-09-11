import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Plus, Send, Sparkles, X } from "lucide-react";
import type { AppState } from "../global.js";
import type { Language } from "./i18n.js";
import { errorMessage } from "../core/error-message.js";
import { NEW_TOPIC_CONTEXT_LIMIT, NEW_TOPIC_DESCRIPTION_LIMIT, NEW_TOPIC_MESSAGE_LIMIT } from "../core/new-topic.js";
import { DictationControl } from "./DictationControl.js";
import { appendDictation } from "../core/dictation.js";

const labels = {
  ru: { add: "Новая тема", heading: "Новый разговор", agent: "Через агента", direct: "Дословно", description: "Что произошло и что хочется обсудить", private: "Описание — для подготовки. Собеседнику уйдут только контекст и реплика ниже.", prepare: "Подготовить реплику", preparing: "Агент готовит черновик…", title: "Название темы", message: "Первая реплика", preview: "Кате уйдёт именно этот текст", instruction: "Что изменить или уточнить", refine: "Переписать с уточнением", send: "Отправить", sending: "Сохраняем для отправки…", saved: "Черновик сохранён на этом компьютере", queued: "Реплика сохранена для отправки. При доступной связи разговор продолжится автоматически.", close: "Свернуть", missing: "Сначала подключите собеседника", changed: "Есть новые уточнения. Подготовьте реплику заново, чтобы учесть их.", directHint: "Напишите реплику своими словами. Агент не будет переписывать её перед отправкой.", next: "Дальше разговор продолжат агенты.", failure: "Не удалось сохранить черновик. Текст остаётся в форме.", empty: "Опишите ситуацию подробно: важные обстоятельства, ваши мысли и вопросы.", recipient: "Получатель", previewTitle: "Точный текст для отправки" },
  en: { add: "New topic", heading: "New conversation", agent: "With my agent", direct: "My exact words", description: "What happened and what you want to discuss", private: "Context for your agent, separate from the outgoing message", prepare: "Prepare message", preparing: "Preparing a draft…", title: "Topic title", message: "Opening message", preview: "This exact text will be sent", instruction: "What to change or clarify", refine: "Revise draft", send: "Send", sending: "Saving for delivery…", saved: "Draft saved on this computer", queued: "Message saved for delivery. The conversation will continue automatically when connected.", close: "Collapse", missing: "Connect a partner first", changed: "The description changed. Prepare the message again to include the changes.", directHint: "Write the message in your own words. Your agent will not rewrite it before sending.", next: "Your agents will continue the conversation afterwards.", failure: "Could not save the draft. The text remains in the form.", empty: "Describe the situation, important details, your thoughts and questions.", recipient: "Recipient", previewTitle: "Exact outgoing message" },
  cs: { add: "Nové téma", heading: "Nový rozhovor", agent: "S agentem", direct: "Doslovně", description: "Co se stalo a co chcete probrat", private: "Kontext pro vašeho agenta, oddělený od odesílané zprávy", prepare: "Připravit zprávu", preparing: "Agent připravuje koncept…", title: "Název tématu", message: "První zpráva", preview: "Odešle se přesně tento text", instruction: "Co změnit nebo upřesnit", refine: "Upravit koncept", send: "Odeslat", sending: "Ukládáme k odeslání…", saved: "Koncept uložen v tomto počítači", queued: "Zpráva je uložena k odeslání. Po připojení bude rozhovor pokračovat automaticky.", close: "Sbalit", missing: "Nejprve připojte partnera", changed: "Popis se změnil. Připravte zprávu znovu.", directHint: "Napište zprávu vlastními slovy. Agent ji před odesláním nepřepíše.", next: "Poté budou v rozhovoru pokračovat agenti.", failure: "Koncept nelze uložit. Text zůstává ve formuláři.", empty: "Popište situaci, důležité okolnosti, své myšlenky a otázky.", recipient: "Příjemce", previewTitle: "Přesný text k odeslání" },
  fr: { add: "Nouveau sujet", heading: "Nouvelle conversation", agent: "Avec mon agent", direct: "Mot pour mot", description: "Ce qui s’est passé et ce que vous souhaitez discuter", private: "Contexte pour votre agent, séparé du message envoyé", prepare: "Préparer le message", preparing: "Préparation du brouillon…", title: "Titre du sujet", message: "Premier message", preview: "Ce texte exact sera envoyé", instruction: "Que changer ou préciser", refine: "Réviser le brouillon", send: "Envoyer", sending: "Enregistrement pour envoi…", saved: "Brouillon enregistré sur cet ordinateur", queued: "Message enregistré pour envoi. La conversation continuera automatiquement une fois la connexion disponible.", close: "Réduire", missing: "Connectez d’abord un partenaire", changed: "La description a changé. Préparez le message à nouveau.", directHint: "Écrivez avec vos propres mots. L’agent ne réécrira pas le message avant l’envoi.", next: "Les agents poursuivront ensuite la conversation.", failure: "Impossible d’enregistrer le brouillon. Le texte reste dans le formulaire.", empty: "Décrivez la situation, les détails importants, vos pensées et vos questions.", recipient: "Destinataire", previewTitle: "Texte exact à envoyer" },
};
type Draft = { id: string; description: string; context: string; title: string; message: string; instruction: string; preparedFor: string };
const fresh = (): Draft => ({ id: crypto.randomUUID(), description: "", context: "", title: "", message: "", instruction: "", preparedFor: "" });
type Saved = { mode: "agent" | "direct"; agent: Draft; direct: Draft };
function load(key: string): Saved {
  const empty: Saved = { mode: "agent", agent: fresh(), direct: fresh() };
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "null");
    if (!raw) {
      if (!key.endsWith(":unpaired")) empty.agent.description = localStorage.getItem("family-bridge-new-topic-draft") || "";
      return empty;
    }
    for (const mode of ["agent", "direct"] as const) {
      for (const field of Object.keys(empty[mode]) as Array<keyof Draft>) if (typeof raw[mode]?.[field] === "string") empty[mode][field] = raw[mode][field];
    }
    empty.mode = raw.mode === "direct" ? "direct" : "agent";
  } catch { /* A missing draft starts empty. */ }
  return empty;
}

export function NewTopicComposer({ state, language, onState, onActive }: {
  state: AppState; language: Language; onState: (value: AppState) => void; onActive: (value: boolean) => void;
}) {
  const t = labels[language], pairId = state.remote.pairId || "unpaired";
  const sharedLabel = { ru: "Контекст для собеседника", en: "Context for your partner", cs: "Kontext pro partnera", fr: "Contexte pour le partenaire" }[language];
  const sharedHint = { ru: "Контекст и реплика отправятся вместе, двумя блоками одного сообщения.", en: "Context and message are sent together as two blocks of one message.", cs: "Kontext a zpráva se odešlou společně jako dva bloky jedné zprávy.", fr: "Le contexte et le message seront envoyés ensemble en deux blocs." }[language];
  const key = `family-bridge-topic-composer:${pairId}`;
  const [saved, setSaved] = useState(() => load(key));
  const [open, setOpen] = useState(Boolean(saved.agent.description || saved.direct.message || saved.direct.context));
  const [busy, setBusy] = useState<"" | "prepare" | "send">("");
  const [dictating, setDictating] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [persisted, setPersisted] = useState(true);
  const pending = useRef(false), alive = useRef(true);
  const mode = saved.mode, draft = saved[mode];
  const locked = Boolean(busy || dictating), configured = Boolean(state.remote.configured && state.remote.pairId);
  useEffect(() => { onActive(open || locked || !persisted); return () => onActive(false); }, [open, locked, persisted, onActive]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  function commit(next: Saved) {
    setSaved(next);
    try { localStorage.setItem(key, JSON.stringify(next)); localStorage.removeItem("family-bridge-new-topic-draft"); setPersisted(true); }
    catch { setPersisted(false); setError(t.failure); }
  }
  function edit(fields: Partial<Draft>) { setNotice(""); commit({ ...saved, [mode]: { ...draft, ...fields } }); }
  async function prepare() {
    const api = window.familyBridge;
    if (!api || pending.current || !configured || !draft.description.trim()) return;
    pending.current = true; setBusy("prepare"); setError("");
    try {
      const result = await api.prepareNewTopic({ pairId, description: draft.description, instruction: draft.instruction,
        preview: draft.message && draft.title ? { title: draft.title, context: draft.context, message: draft.message } : undefined });
      if (alive.current) commit({ ...saved, agent: { ...draft, ...result, instruction: "", preparedFor: draft.description } });
    } catch (e) { if (alive.current) setError(errorMessage(e)); }
    finally { pending.current = false; if (alive.current) setBusy(""); }
  }
  async function send() {
    const api = window.familyBridge;
    if (!api || pending.current || !configured || !draft.message.trim() || !draft.title.trim()) return;
    pending.current = true; setBusy("send"); setError("");
    try {
      const next = await api.sendNewTopic({ id: draft.id, pairId, mode, title: draft.title, message: draft.message, context: draft.context });
      if (alive.current) { onState(next); commit({ ...saved, [mode]: fresh() }); setNotice(t.queued); setOpen(false); }
    } catch (e) { if (alive.current) setError(errorMessage(e)); }
    finally { pending.current = false; if (alive.current) setBusy(""); }
  }
  const stale = mode === "agent" && (draft.preparedFor !== draft.description || Boolean(draft.instruction.trim()));
  return <section className="new-topic-composer">
    <div className="composer-heading"><h3>{t.heading}</h3><button type="button" className="ghost" disabled={locked} onClick={() => { setNotice(""); setOpen(!open); }}>{open ? <X size={17} /> : <Plus size={17} />}{open ? t.close : t.add}</button></div>
    {notice && <p role="status" className="composer-success">{notice}</p>}
    {error && <p role="alert" className="composer-error">{error}</p>}
    {open && <>
      <p className="composer-recipient">{t.recipient}: <strong>{state.remote.peerName || state.remote.counterpartLabel || "—"}</strong></p>
      <div className="composer-modes" role="tablist"><button role="tab" aria-selected={mode === "agent"} disabled={locked} onClick={() => { setNotice(""); commit({ ...saved, mode: "agent" }); }}><Sparkles size={17} />{t.agent}</button><button role="tab" aria-selected={mode === "direct"} disabled={locked} onClick={() => { setNotice(""); commit({ ...saved, mode: "direct" }); }}>{t.direct}</button></div>
      {!configured && <p>{t.missing}</p>}
      <fieldset disabled={Boolean(busy)}>
        {mode === "direct" && <p>{t.directHint}</p>}
        {mode === "agent" && <label>{t.description}<textarea disabled={dictating} value={draft.description} maxLength={NEW_TOPIC_DESCRIPTION_LIMIT} rows={7} placeholder={t.empty} onChange={e => edit({ description: e.target.value })} /></label>}
        {mode === "agent" && <>
          <small>{t.private}</small>
          <DictationControl language={language} disabled={Boolean(busy)} onText={text => edit({ description: appendDictation(draft.description, text) })} onBusyChange={setDictating} />
          {!draft.message && <button type="button" className="primary" disabled={dictating || !configured || !draft.description.trim()} onClick={() => void prepare()}><Sparkles size={17} />{t.prepare}</button>}
        </>}
        {(mode === "direct" || draft.message) && <div className="composer-preview">
          <h4>{mode === "agent" ? t.previewTitle : t.message}</h4>
          <label>{t.title}<input disabled={dictating} value={draft.title} maxLength={240} onChange={e => edit({ title: e.target.value })} /></label>
          <label>{sharedLabel}<textarea disabled={dictating} rows={4} maxLength={NEW_TOPIC_CONTEXT_LIMIT} value={draft.context} onChange={e => edit({ context: e.target.value })} /></label>
          <label>{t.message}<textarea disabled={dictating} className="composer-message" rows={8} value={draft.message} maxLength={NEW_TOPIC_MESSAGE_LIMIT} onChange={e => edit({ message: e.target.value })} /></label>
          <small>{sharedHint}</small>
          {mode === "agent" ? <><label>{t.instruction}<textarea rows={3} maxLength={4000} value={draft.instruction} onChange={e => edit({ instruction: e.target.value })} /></label><button type="button" className="ghost" disabled={!configured || !draft.description.trim()} onClick={() => void prepare()}><Sparkles size={17} />{t.refine}</button>{stale && <p>{t.changed}</p>}</> : <DictationControl language={language} disabled={Boolean(busy)} onText={text => edit({ message: appendDictation(draft.message, text) })} onBusyChange={setDictating} />}
          <div className="composer-send"><small>{t.next}</small><button type="button" className="primary" disabled={dictating || !configured || !draft.title.trim() || !draft.message.trim() || stale || !persisted} onClick={() => void send()}><Send size={17} />{t.send}{state.remote.peerName ? ` · ${state.remote.peerName}` : ""}</button></div>
        </div>}
      </fieldset>
      {busy && <p role="status"><LoaderCircle className="spin" size={17} /> {busy === "prepare" ? t.preparing : t.sending}</p>}
      {persisted && <small>{t.saved}</small>}
    </>}
  </section>;
}
