import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Ban,
  Bell,
  BookHeart,
  Check,
  CircleDot,
  Clock3,
  MessageCircleHeart,
  Plus,
  Radio,
  ScrollText,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { AppState } from "../global.js";
import type { ConversationReport } from "../core/types.js";
import { languageNames, translations, type Language } from "./i18n.js";

const fallback: AppState = {
  owner: "dima",
  identityConfigured: false,
  language: "ru",
  autoStart: true,
  pendingTopics: ["Как сделать бытовые договорённости спокойнее"],
  blockedTopics: [],
  reports: [],
  running: false,
  codex: { installed: true, authenticated: true, version: "preview mode" },
  remote: { configured: false, connected: false },
  memory: { configured: false, messageCount: 0 },
  update: { available: false, downloading: false },
};

type TimelineItem = { from?: string; text: string; type: "message" | "status" };
type SectionId = "overview" | "topics" | "conversation" | "reports" | "memory" | "settings";

export function App() {
  const [state, setState] = useState<AppState>(fallback);
  const [topic, setTopic] = useState("");
  const [blocked, setBlocked] = useState("");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [report, setReport] = useState<ConversationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const [language, setLanguage] = useState<Language>(() => (localStorage.getItem("family-bridge-language") as Language) || "ru");
  const t = translations[language];
  const deviceText = {
    ru: { identity: "Кто есть кто", local: "этот компьютер", partner: "компьютер партнёра", question: "Кто пользуется этим компьютером?", hint: "Выберите себя. На втором компьютере партнёр выберет себя отдельно.", dima: "Я — Дима", katya: "Я — Катя" },
    en: { identity: "Who is who", local: "this computer", partner: "partner computer", question: "Who uses this computer?", hint: "Choose yourself. Your partner will choose themselves on the other computer.", dima: "I'm Dima", katya: "I'm Katya" },
    cs: { identity: "Kdo je kdo", local: "tento počítač", partner: "počítač partnera", question: "Kdo používá tento počítač?", hint: "Vyberte sebe. Partner se vybere samostatně na druhém počítači.", dima: "Jsem Dima", katya: "Jsem Katya" },
    fr: { identity: "Qui est qui", local: "cet ordinateur", partner: "ordinateur du partenaire", question: "Qui utilise cet ordinateur ?", hint: "Choisissez-vous. Votre partenaire fera son choix sur l'autre ordinateur.", dima: "Je suis Dima", katya: "Je suis Katya" },
  }[language];

  function goTo(section: SectionId) {
    setActiveSection(section);
    window.setTimeout(() => document.getElementById(section)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function agentLabel(from?: string) {
    const name = from === "dima" ? t.agentDima : t.agentKatya;
    return from === state.owner ? `${name} · ${deviceText.local}` : `${name} · ${deviceText.partner}`;
  }

  async function changeLanguage(value: Language) {
    setLanguage(value);
    localStorage.setItem("family-bridge-language", value);
    if (api) setState(await api.setLanguage(value));
  }

  const api = window.familyBridge;
  useEffect(() => {
    void api?.getState().then(async (current) => {
      const saved = localStorage.getItem("family-bridge-language") as Language | null;
      const next = saved && saved !== current.language ? await api.setLanguage(saved) : current;
      setState(next);
      setLanguage(next.language);
    });
    return api?.onEvent((raw) => {
      const event = raw as { type?: string; from?: string; text?: string; status?: string; available?: boolean; version?: string; downloading?: boolean };
      if (event.type === "message" && event.text) {
        setTimeline((items) => [...items, { type: "message", from: event.from, text: event.text! }]);
      }
      if (event.type === "status" && event.status) {
        setTimeline((items) => [...items, { type: "status", text: event.status! }]);
      }
      if (event.type === "update") setState((current) => ({ ...current, update: { available: Boolean(event.available), version: event.version, downloading: Boolean(event.downloading) } }));
    });
  }, [api]);

  const health = useMemo(
    () => state.codex.installed && state.codex.authenticated,
    [state.codex],
  );

  async function addTopic() {
    if (!topic.trim()) return;
    if (api) setState(await api.addTopic(topic));
    else setState((current) => ({ ...current, pendingTopics: [...current.pendingTopics, topic] }));
    setTopic("");
  }

  async function blockTopic() {
    if (!blocked.trim()) return;
    if (api) setState(await api.blockTopic(blocked));
    else setState((current) => ({ ...current, blockedTopics: [...current.blockedTopics, blocked] }));
    setBlocked("");
  }

  async function runConversation(realCodex: boolean) {
    const selected = state.pendingTopics[0] || topic.trim();
    if (!selected || !api) return;
    setBusy(true);
    setError("");
    setReport(null);
    setTimeline([]);
    try {
      const result = await api.runConversation(selected, realCodex);
      setReport(result);
      setState(await api.getState());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function runRemote() {
    const selected = state.pendingTopics[0] || topic.trim();
    if (!selected || !api) return;
    setBusy(true); setError(""); setTimeline([]);
    try { await api.runRemote(selected); setState(await api.getState()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><MessageCircleHeart size={25} /><span>Family Bridge</span></div>
        <nav>
          <button className={activeSection === "overview" ? "active" : ""} onClick={() => goTo("overview")}><Activity size={18} />{t.overview}</button>
          <button className={activeSection === "topics" ? "active" : ""} onClick={() => goTo("topics")}><Sparkles size={18} />{t.topics}</button>
          <button className={activeSection === "conversation" ? "active" : ""} onClick={() => goTo("conversation")}><Radio size={18} />{t.conversation}</button>
          <button className={activeSection === "reports" ? "active" : ""} onClick={() => goTo("reports")}><ScrollText size={18} />{t.reports}</button>
          <button className={activeSection === "memory" ? "active" : ""} onClick={() => goTo("memory")}><BookHeart size={18} />{t.memory}</button>
          <button className={activeSection === "settings" ? "active" : ""} onClick={() => goTo("settings")}><Settings2 size={18} />{t.settings}</button>
        </nav>
        <div className="sidebar-status">
          <span className={health ? "status-dot online" : "status-dot"} />
          <div><strong>{health ? t.ready : t.setup}</strong><small>{state.codex.version}</small></div>
        </div>
      </aside>

      <main id="overview">
        <header>
          <div><p className="eyebrow">{t.autonomous}</p><h1>{t.title}</h1></div>
          <div className="header-tools"><label>{t.language}<select value={language} onChange={(e) => void changeLanguage(e.target.value as Language)}>{(Object.keys(languageNames) as Language[]).map((key) => <option value={key} key={key}>{languageNames[key]}</option>)}</select></label><div className="live-pill"><CircleDot size={14} />{t.background}</div></div>
        </header>

        {activeSection === "overview" && <section className="hero-card">
          <div>
            <span className="hero-icon"><ShieldCheck /></span>
            <p className="eyebrow">{t.state}</p>
            <h2>{busy ? t.talking : t.waiting}</h2>
            <p>{t.privacy}</p>
          </div>
          <div className="hero-metrics">
            <div><span>Codex</span><strong>{health ? t.connected : t.notReady}</strong></div>
            <div><span>{t.queued}</span><strong>{state.pendingTopics.length}</strong></div>
            <div><span>{t.last}</span><strong>{state.lastConversationAt ? new Date(state.lastConversationAt).toLocaleDateString(language) : "—"}</strong></div>
          </div>
        </section>}

        {(activeSection === "overview" || activeSection === "settings") && <section className="panel pairing-panel screen-panel" id="settings">
          <div className="panel-title"><div><p className="eyebrow">{t.connection}</p><h3>{state.remote.connected ? t.agentsConnected : t.linkComputers}</h3></div><Radio size={20} /></div>
          {(!state.identityConfigured || activeSection === "settings") && <div className="identity-setup"><strong>{deviceText.question}</strong><span>{deviceText.hint}</span><div><button className={state.identityConfigured && state.owner === "dima" ? "primary" : "ghost"} onClick={async () => api && setState(await api.setOwner("dima"))}>{deviceText.dima}</button><button className={state.identityConfigured && state.owner === "katya" ? "primary" : "ghost"} onClick={async () => api && setState(await api.setOwner("katya"))}>{deviceText.katya}</button></div></div>}
          {state.identityConfigured && <>
            {!state.remote.configured && <button className="primary" onClick={async () => api && setState(await api.createPair())}>{t.createInvite}</button>}
            {state.remote.invite && <><p className="muted">{t.shareCode}</p><textarea readOnly value={state.remote.invite} onFocus={(e) => e.currentTarget.select()} /></>}
            {!state.remote.connected && <div className="input-row"><input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder={t.pasteInvite}/><button onClick={async () => api && setState(await api.joinPair(inviteCode))}>{t.connect}</button></div>}
            {state.remote.connected && <p className="muted">{t.channelActive}</p>}
            <div className="identity-card"><strong>{deviceText.identity}</strong><span>{state.owner === "dima" ? t.agentDima : t.agentKatya} · {deviceText.local}</span><span>{state.owner === "dima" ? t.agentKatya : t.agentDima} · {deviceText.partner}</span></div>
          </>}
          {activeSection === "settings" && <div className="settings-actions"><label><input type="checkbox" checked={state.autoStart} onChange={async (e) => api && setState(await api.setAutoStart(e.target.checked))} /> Автозапуск приложения</label><button onClick={() => void api?.checkForUpdates()}>Проверить обновления</button><small>{state.update.available ? `Доступна версия ${state.update.version}` : "Установлена актуальная версия"}</small></div>}
        </section>}

        <div className={`grid ${activeSection !== "overview" ? "single-screen" : ""}`}>
          {(activeSection === "overview" || activeSection === "topics") && <section className="panel topics-panel" id="topics">
            <div className="panel-title"><div><p className="eyebrow">{t.agenda}</p><h3>{t.propose}</h3></div><Plus size={20} /></div>
            <div className="input-row">
              <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={t.topicPlaceholder} onKeyDown={(e) => e.key === "Enter" && void addTopic()} />
              <button onClick={() => void addTopic()}>{t.add}</button>
            </div>
            <div className="topic-list">
              {state.pendingTopics.map((item, index) => (
                <div className="topic" key={`${item}-${index}`}><span>{item}</span><small>{index === 0 ? t.next : t.inQueue}</small></div>
              ))}
              {!state.pendingTopics.length && <div className="empty">{t.autoTopics}</div>}
            </div>
            <div className="actions">
              <button className="primary" disabled={busy || !state.pendingTopics.length} onClick={() => void runConversation(true)}><Sparkles size={17} />{t.runCodex}</button>
              <button className="primary" disabled={busy || !state.pendingTopics.length || !state.remote.connected} onClick={() => void runRemote()}><Radio size={17} />{t.talkPartner}</button>
              <button className="ghost" disabled={busy || !state.pendingTopics.length} onClick={() => void runConversation(false)}>{t.quickDemo}</button>
            </div>
          </section>}

          {(activeSection === "overview" || activeSection === "memory") && <section className="panel privacy-panel" id="memory">
            <div className="panel-title"><div><p className="eyebrow">{t.boundaries}</p><h3>{t.doNotDiscuss}</h3></div><Ban size={20} /></div>
            <div className="input-row compact">
              <input value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder={t.blockedPlaceholder} onKeyDown={(e) => e.key === "Enter" && void blockTopic()} />
              <button onClick={() => void blockTopic()}>{t.block}</button>
            </div>
            {state.blockedTopics.map((item) => <span className="blocked-chip" key={item}>{item}</span>)}
            {!state.blockedTopics.length && <p className="muted">{t.noBlocks}</p>}
            {activeSection === "memory" && <div className="memory-status"><strong>{state.memory.configured ? "Память синхронизирована" : "Память ещё не настроена"}</strong><span>{state.memory.messageCount} реплик в локальном архиве</span><span>Последняя проверка: {state.memory.lastCheckedAt ? new Date(state.memory.lastCheckedAt).toLocaleString(language) : "—"}</span><span>Статус: {state.memory.status || "—"}</span></div>}
          </section>}

          {(activeSection === "overview" || activeSection === "conversation") && <section className="panel conversation-panel" id="conversation">
            <div className="panel-title"><div><p className="eyebrow">{t.live}</p><h3>{t.progress}</h3></div><Clock3 size={20} /></div>
            <div className="timeline">
              {timeline.map((item, index) => item.type === "status" ? (
                <div className="timeline-status" key={index}>{item.text}</div>
              ) : (
                <div className={`bubble ${item.from === "dima" ? "dima" : "katya"}`} key={index}>
                  <strong>{agentLabel(item.from)}</strong><p>{item.text}</p>
                </div>
              ))}
              {!timeline.length && <div className="empty tall"><Radio size={28} /><span>{t.noMessages}</span></div>}
            </div>
          </section>}

          {(activeSection === "overview" || activeSection === "reports") && <section className="panel report-panel" id="reports">
            <div className="panel-title"><div><p className="eyebrow">{t.result}</p><h3>{t.latest}</h3></div><Check size={20} /></div>
            {report ? <><p className="summary">{report.sharedSummary || t.noSummary}</p><div className="report-meta"><span>{report.turns} {t.turns}</span><span>{report.topics.length} {t.topicCount}</span></div></> : <div className="empty tall"><ScrollText size={28} /><span>{t.noReport}</span></div>}
            <button className="link-button" onClick={() => void api?.openReports()}>{t.openReports}</button>
            {activeSection === "reports" && <div className="report-list">{state.reports.map((item) => <div key={item}>{item.split(/[\\/]/).pop()}</div>)}{!state.reports.length && <span>Сохранённых итогов пока нет</span>}</div>}
          </section>}
        </div>

        {error && <div className="error"><Bell size={18} />{error}</div>}
      </main>
    </div>
  );
}
