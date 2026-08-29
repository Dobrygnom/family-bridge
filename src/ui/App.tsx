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
          <button className="active"><Activity size={18} />Обзор</button>
          <button><Sparkles size={18} />Темы</button>
          <button><Radio size={18} />Разговор</button>
          <button><ScrollText size={18} />Итоги</button>
          <button><BookHeart size={18} />Память</button>
          <button><Settings2 size={18} />Настройки</button>
        </nav>
        <div className="sidebar-status">
          <span className={health ? "status-dot online" : "status-dot"} />
          <div><strong>{health ? "Система готова" : "Нужна настройка"}</strong><small>{state.codex.version}</small></div>
        </div>
      </aside>

      <main>
        <header>
          <div><p className="eyebrow">АВТОНОМНЫЙ РЕЖИМ</p><h1>Спокойный канал между агентами</h1></div>
          <div className="live-pill"><CircleDot size={14} />Работает в фоне</div>
        </header>

        <section className="hero-card">
          <div>
            <span className="hero-icon"><ShieldCheck /></span>
            <p className="eyebrow">СОСТОЯНИЕ</p>
            <h2>{busy ? "Агенты разговаривают" : "Ожидаем подходящую тему"}</h2>
            <p>Личные архивы остаются на ваших компьютерах. Между агентами передаются только подготовленные реплики.</p>
          </div>
          <div className="hero-metrics">
            <div><span>Codex</span><strong>{health ? "Подключён" : "Не готов"}</strong></div>
            <div><span>Тем в очереди</span><strong>{state.pendingTopics.length}</strong></div>
            <div><span>Последний разговор</span><strong>{state.lastConversationAt ? new Date(state.lastConversationAt).toLocaleDateString("ru") : "—"}</strong></div>
          </div>
        </section>

        <section className="panel pairing-panel">
          <div className="panel-title"><div><p className="eyebrow">СОЕДИНЕНИЕ</p><h3>{state.remote.connected ? "Агенты соединены" : "Связать два компьютера"}</h3></div><Radio size={20} /></div>
          {!state.remote.configured && <button className="primary" onClick={async () => api && setState(await api.createPair())}>Создать приглашение</button>}
          {state.remote.invite && <><p className="muted">Передайте Кате этот одноразовый код:</p><textarea readOnly value={state.remote.invite} onFocus={(e) => e.currentTarget.select()} /></>}
          {!state.remote.connected && <div className="input-row"><input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} placeholder="Вставить код приглашения"/><button onClick={async () => api && setState(await api.joinPair(inviteCode))}>Подключиться</button></div>}
          {state.remote.connected && <p className="muted">Облачный канал активен. Новые реплики проверяются каждые 2 секунды.</p>}
        </section>

        <div className="grid">
          <section className="panel topics-panel">
            <div className="panel-title"><div><p className="eyebrow">ПОВЕСТКА</p><h3>Предложить тему</h3></div><Plus size={20} /></div>
            <div className="input-row">
              <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Что агентам стоит обсудить?" onKeyDown={(e) => e.key === "Enter" && void addTopic()} />
              <button onClick={() => void addTopic()}>Добавить</button>
            </div>
            <div className="topic-list">
              {state.pendingTopics.map((item, index) => (
                <div className="topic" key={`${item}-${index}`}><span>{item}</span><small>{index === 0 ? "следующая" : "в очереди"}</small></div>
              ))}
              {!state.pendingTopics.length && <div className="empty">Агенты добавят важные темы автоматически.</div>}
            </div>
            <div className="actions">
              <button className="primary" disabled={busy || !state.pendingTopics.length} onClick={() => void runConversation(true)}><Sparkles size={17} />Запустить через Codex</button>
              <button className="primary" disabled={busy || !state.pendingTopics.length || !state.remote.connected} onClick={() => void runRemote()}><Radio size={17} />Поговорить с агентом Кати</button>
              <button className="ghost" disabled={busy || !state.pendingTopics.length} onClick={() => void runConversation(false)}>Быстрый demo</button>
            </div>
          </section>

          <section className="panel privacy-panel">
            <div className="panel-title"><div><p className="eyebrow">ГРАНИЦЫ</p><h3>Не обсуждать</h3></div><Ban size={20} /></div>
            <div className="input-row compact">
              <input value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder="Тема или ключевая фраза" onKeyDown={(e) => e.key === "Enter" && void blockTopic()} />
              <button onClick={() => void blockTopic()}>Запретить</button>
            </div>
            {state.blockedTopics.map((item) => <span className="blocked-chip" key={item}>{item}</span>)}
            {!state.blockedTopics.length && <p className="muted">Запретов пока нет. Локальная политика раскрытия всё равно не позволяет цитировать личные признания.</p>}
          </section>

          <section className="panel conversation-panel">
            <div className="panel-title"><div><p className="eyebrow">ЖИВОЙ ДИАЛОГ</p><h3>Ход разговора</h3></div><Clock3 size={20} /></div>
            <div className="timeline">
              {timeline.map((item, index) => item.type === "status" ? (
                <div className="timeline-status" key={index}>{item.text}</div>
              ) : (
                <div className={`bubble ${item.from === "dima" ? "dima" : "katya"}`} key={index}>
                  <strong>{item.from === "dima" ? "Агент Димы" : "Агент Кати"}</strong><p>{item.text}</p>
                </div>
              ))}
              {!timeline.length && <div className="empty tall"><Radio size={28} /><span>Здесь появятся только межагентные реплики — не личные архивы.</span></div>}
            </div>
          </section>

          <section className="panel report-panel">
            <div className="panel-title"><div><p className="eyebrow">РЕЗУЛЬТАТ</p><h3>Последний итог</h3></div><Check size={20} /></div>
            {report ? <><p className="summary">{report.sharedSummary || "Общий итог не опубликован."}</p><div className="report-meta"><span>{report.turns} ходов</span><span>{report.topics.length} тем</span></div></> : <div className="empty tall"><ScrollText size={28} /><span>После разговора здесь появится нейтральный общий итог.</span></div>}
            <button className="link-button" onClick={() => void api?.openReports()}>Открыть все отчёты</button>
          </section>
        </div>

        {error && <div className="error"><Bell size={18} />{error}</div>}
      </main>
    </div>
  );
}
