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
  autoStart: true,
  pendingTopics: ["Как сделать бытовые договорённости спокойнее"],
  blockedTopics: [],
  reports: [],
  running: false,
  codex: { installed: true, authenticated: true, version: "preview mode" },
  remote: { configured: false, connected: false },
};

type TimelineItem = { from?: string; text: string; type: "message" | "status" };

export function App() {
  const [state, setState] = useState<AppState>(fallback);
  const [topic, setTopic] = useState("");
  const [blocked, setBlocked] = useState("");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [report, setReport] = useState<ConversationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [language, setLanguage] = useState<Language>(() => (localStorage.getItem("family-bridge-language") as Language) || "ru");
  const t = translations[language];

  function changeLanguage(value: Language) {
    setLanguage(value);
    localStorage.setItem("family-bridge-language", value);
  }

  const api = window.familyBridge;
  useEffect(() => {
    void api?.getState().then(setState);
    return api?.onEvent((raw) => {
      const event = raw as { type?: string; from?: string; text?: string; status?: string };
      if (event.type === "message" && event.text) {
        setTimeline((items) => [...items, { type: "message", from: event.from, text: event.text! }]);
      }
      if (event.type === "status" && event.status) {
        setTimeline((items) => [...items, { type: "status", text: event.status! }]);
      }
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
          <button className="active"><Activity size={18} />{t.overview}</button>
          <button><Sparkles size={18} />{t.topics}</button>
          <button><Radio size={18} />{t.conversation}</button>
          <button><ScrollText size={18} />{t.reports}</button>
          <button><BookHeart size={18} />{t.memory}</button>
          <button><Settings2 size={18} />{t.settings}</button>
        </nav>
        <div className="sidebar-status">
          <span className={health ? "status-dot online" : "status-dot"} />
          <div><strong>{health ? t.ready : t.setup}</strong><small>{state.codex.version}</small></div>
        </div>
      </aside>

      <main>
        <header>
          <div><p className="eyebrow">{t.autonomous}</p><h1>{t.title}</h1></div>
          <div className="header-tools"><label>{t.language}<select value={language} onChange={(e) => changeLanguage(e.target.value as Language)}>{(Object.keys(languageNames) as Language[]).map((key) => <option value={key} key={key}>{languageNames[key]}</option>)}</select></label><div className="live-pill"><CircleDot size={14} />{t.background}</div></div>
        </header>

        <section className="hero-card">
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
        </section>

        <section className="panel pairing-panel">
          <div className="panel-title"><div><p className="eyebrow">{t.connection}</p><h3>{state.remote.connected ? t.agentsConnected : t.linkComputers}</h3></div><Radio size={20} /></div>
          {!state.remote.configured && <button className="primary" onClick={async () => api && setState(await api.createPair())}>{t.createInvite}</button>}
          {state.remote.invite && <><p className="muted">{t.shareCode}</p><textarea readOnly value={state.remote.invite} onFocus={(e) => e.currentTarget.select()} /></>}
          {!state.remote.connected && <div className="input-row"><input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder={t.pasteInvite}/><button onClick={async () => api && setState(await api.joinPair(inviteCode))}>{t.connect}</button></div>}
          {state.remote.connected && <p className="muted">{t.channelActive}</p>}
        </section>

        <div className="grid">
          <section className="panel topics-panel">
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
          </section>

          <section className="panel privacy-panel">
            <div className="panel-title"><div><p className="eyebrow">{t.boundaries}</p><h3>{t.doNotDiscuss}</h3></div><Ban size={20} /></div>
            <div className="input-row compact">
              <input value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder={t.blockedPlaceholder} onKeyDown={(e) => e.key === "Enter" && void blockTopic()} />
              <button onClick={() => void blockTopic()}>{t.block}</button>
            </div>
            {state.blockedTopics.map((item) => <span className="blocked-chip" key={item}>{item}</span>)}
            {!state.blockedTopics.length && <p className="muted">{t.noBlocks}</p>}
          </section>

          <section className="panel conversation-panel">
            <div className="panel-title"><div><p className="eyebrow">{t.live}</p><h3>{t.progress}</h3></div><Clock3 size={20} /></div>
            <div className="timeline">
              {timeline.map((item, index) => item.type === "status" ? (
                <div className="timeline-status" key={index}>{item.text}</div>
              ) : (
                <div className={`bubble ${item.from === "dima" ? "dima" : "katya"}`} key={index}>
                  <strong>{item.from === "dima" ? t.agentDima : t.agentKatya}</strong><p>{item.text}</p>
                </div>
              ))}
              {!timeline.length && <div className="empty tall"><Radio size={28} /><span>{t.noMessages}</span></div>}
            </div>
          </section>

          <section className="panel report-panel">
            <div className="panel-title"><div><p className="eyebrow">{t.result}</p><h3>{t.latest}</h3></div><Check size={20} /></div>
            {report ? <><p className="summary">{report.sharedSummary || t.noSummary}</p><div className="report-meta"><span>{report.turns} {t.turns}</span><span>{report.topics.length} {t.topicCount}</span></div></> : <div className="empty tall"><ScrollText size={28} /><span>{t.noReport}</span></div>}
            <button className="link-button" onClick={() => void api?.openReports()}>{t.openReports}</button>
          </section>
        </div>

        {error && <div className="error"><Bell size={18} />{error}</div>}
      </main>
    </div>
  );
}
