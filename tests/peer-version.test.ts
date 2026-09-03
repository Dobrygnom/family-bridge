import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BackgroundService } from "../electron/background-service.js";
import { AtomicStore } from "../electron/store.js";
import { PEER_VERSION_TIMEOUT_MS, validPeerVersion, VERSION_PROBE_PREFIX } from "../src/core/peer-version.js";
import { PeerVersionControl } from "../src/ui/PeerVersionControl.js";
import { ReportContinuation } from "../src/ui/ReportContinuation.js";
import type { AppState } from "../src/global.js";

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("Operation did not settle");
}

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fb-peer-version-"));
  const store = new AtomicStore(dir);
  await store.update({ remote: { pairId: "pair", encryptionSecret: "test", peerName: "Катя" } });
  const events: any[] = [], sent: any[] = [], incoming: any[] = [];
  let updateChecks = 0;
  const service = new BackgroundService(dir, process.cwd(), store, () => ({ webContents: { send: (_: string, event: unknown) => events.push(event) } } as any), undefined,
    { backgroundTasks: false, appVersion: "0.3.31", requestUpdateCheck: () => updateChecks++ });
  const transport = {
    pairState: async () => ({ id: "pair", owner_id: "one", partner_id: "two" }), identity: async () => "one",
    send: async (input: any) => { sent.push(input); return "sent"; },
    claimNext: async () => incoming.shift() ?? null, acknowledge: async () => {},
  };
  (service as any).remote = transport;
  (service as any).localRemoteAgent = () => assert.fail("Version exchange must never invoke an agent");
  return { dir, store, service, events, sent, incoming, transport, updateChecks: () => updateChecks,
    cleanup: async () => { clearTimeout((service as any).versionProbeTimer); await rm(dir, { recursive: true, force: true }); } };
}

test("unknown version and empty topic list still send a dedicated metadata-only probe", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.service.requestPeerVersionCheck();
    assert.equal(snapshot.remote.peerVersionCheck?.status, "checking");
    await until(() => f.sent.length === 1);
    const message = f.sent[0];
    assert.ok(message.payload.topic.startsWith(VERSION_PROBE_PREFIX));
    assert.equal(message.payload.versionOnly, true);
    assert.equal(message.payload.requestUpdateCheck, true, "0.3.29 compatibility flag");
    assert.equal(message.payload.requestVersion, true);
    assert.equal(message.payload.senderVersion, "0.3.31");
    assert.equal("text" in message.payload, false);
    await f.service.requestPeerVersionCheck();
    assert.equal(f.sent.length, 1, "Repeated clicks share a pending request");
    assert.deepEqual((await f.store.read()).pairTopics, []);
    const log = await readFile(f.service.diagnostics.file, "utf8");
    assert.match(log, /peer-version.sent/);
    assert.doesNotMatch(log, /Катя|encryptionSecret|family-bridge:version:/);
  } finally { await f.cleanup(); }
});

test("a 0.3.29-style response resolves the request without topics or dialogue", async () => {
  const f = await fixture();
  try {
    await f.service.requestPeerVersionCheck();
    await until(() => f.sent.length === 1);
    // v0.3.29's versionOnly branch replies only when requestUpdateCheck is true,
    // echoes incomingTopic, and clears requestUpdateCheck. No new fields required.
    const probe = f.sent[0].payload;
    assert.equal(probe.requestUpdateCheck, true);
    f.incoming.push({ id: "legacy-reply", payload: { kind: "topic", topic: probe.topic, versionOnly: true, requestUpdateCheck: false, senderVersion: "0.3.29", senderName: "Катя" } });
    await (f.service as any).pumpRemote();
    const state = await f.service.state();
    assert.equal(state.remote.peerVersion, "0.3.29");
    assert.equal(state.remote.peerVersionCheck?.status, "received");
    assert.ok(state.remote.peerLastSeenAt);
    assert.equal(f.sent.length, 1, "Replies must not trigger reply loops");
    assert.equal(f.updateChecks(), 0);
    assert.deepEqual(state.pairTopics, []);
    assert.deepEqual(state.reports, []);
  } finally { await f.cleanup(); }
});

test("initial connection announces version exactly once even with no topics", async () => {
  const f = await fixture();
  try {
    await (f.service as any).pumpRemote();
    await until(() => f.sent.length === 1);
    await (f.service as any).pumpRemote();
    await (f.service as any).pumpRemote();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].payload.requestVersion, true);
  } finally { await f.cleanup(); }
});

test("new builds answer before identity setup without checking updates or leaking topics", async () => {
  const f = await fixture();
  try {
    (f.service as any).versionProbePair = "pair:two";
    f.incoming.push({ id: "request", payload: { kind: "topic", topic: "service-probe", versionOnly: true, requestVersion: true, requestUpdateCheck: true, senderVersion: "0.3.31" } });
    await (f.service as any).pumpRemote();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].payload.topic, "service-probe");
    assert.equal(f.sent[0].payload.requestVersion, false);
    assert.equal(f.sent[0].payload.requestUpdateCheck, false);
    assert.equal(f.updateChecks(), 0);
    assert.deepEqual((await f.store.read()).pendingTopics, []);
  } finally { await f.cleanup(); }
});

test("network errors have a visible retryable state and do not erase the last version", async () => {
  const f = await fixture();
  try {
    await f.store.mutate((current) => ({ remote: { ...current.remote!, peerVersion: "0.3.29" } }));
    f.transport.send = async () => { throw new Error("private transport details"); };
    await f.service.requestPeerVersionCheck();
    await until(() => f.events.some((event) => event.peerVersionCheck?.status === "error"));
    assert.equal((await f.service.state()).remote.peerVersion, "0.3.29");
    assert.doesNotMatch(JSON.stringify(f.events), /private transport details/);
    f.transport.send = async (input) => { f.sent.push(input); return "sent"; };
    await f.service.requestPeerVersionCheck();
    await until(() => f.sent.length === 1);
    assert.equal((await f.service.state()).remote.peerVersionCheck?.status, "checking");
  } finally { await f.cleanup(); }
});

test("a slow or absent peer times out honestly; late replies recover without erasing drafts", async (t) => {
  const f = await fixture();
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    f.transport.pairState = () => new Promise(() => {});
    const snapshot = await f.service.requestPeerVersionCheck();
    assert.equal(snapshot.remote.peerVersionCheck?.status, "checking");
    t.mock.timers.tick(PEER_VERSION_TIMEOUT_MS);
    assert.equal((await f.service.state()).remote.peerVersionCheck?.status, "timeout");
    await (f.service as any).receivePeerVersion({ kind: "topic", topic: (f.service as any).versionProbe.topic, versionOnly: true, senderVersion: "0.3.29" }, "pair");
    assert.equal((await f.service.state()).remote.peerVersionCheck?.status, "received");
    assert.equal((await f.store.read()).remote?.peerVersion, "0.3.29");
  } finally { t.mock.timers.reset(); await f.cleanup(); }
});

test("old probe replies cannot complete a new request; malformed versions are not accepted", async () => {
  const f = await fixture();
  try {
    await f.service.requestPeerVersionCheck();
    await until(() => f.sent.length === 1);
    await (f.service as any).receivePeerVersion({ kind: "topic", topic: "old-probe", versionOnly: true, senderVersion: "0.3.29" }, "pair");
    assert.equal((await f.service.state()).remote.peerVersionCheck?.status, "checking");
    assert.equal(validPeerVersion("0.3.29"), "0.3.29");
    assert.equal(validPeerVersion("1.0.0"), "1.0.0");
    assert.equal(validPeerVersion("secret-text"), undefined);
  } finally { await f.cleanup(); }
});

test("version button remains visible and enabled when version and live connection are unknown", () => {
  const state = { remote: { configured: true, connected: false, peerName: "Катя" } } as AppState;
  const html = renderToStaticMarkup(createElement(PeerVersionControl, { state, language: "ru", onCheck: () => {}, continuation: true }));
  assert.match(html, /Проверить версию собеседника/);
  assert.match(html, /Ваш текст не отправлен/);
  assert.doesNotMatch(html, /disabled=/);
  const old = renderToStaticMarkup(createElement(PeerVersionControl, { state: { ...state, remote: { ...state.remote, peerVersion: "0.3.29" } }, language: "ru", onCheck: () => {}, continuation: true }));
  assert.match(old, /v0.3.29/);
  assert.match(old, /обновиться до 0.3.30/);
});

test("continuation itself exposes version checking and a clear block reason without consuming the draft", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  Object.defineProperty(globalThis, "localStorage", { value: { getItem: () => "preserved draft" }, configurable: true });
  try {
    const html = renderToStaticMarkup(createElement(ReportContinuation, { reportId: "saved", state: { remote: { configured: true, connected: true } } as AppState, language: "ru", onState: () => {}, dictationBusy: false, onDictationBusy: () => {} }));
    assert.match(html, /Проверить версию собеседника/);
    assert.match(html, /preserved draft/);
    assert.match(html, /Ваш текст не отправлен/);
    assert.match(html, /disabled="">Продолжить разговор/);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window");
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
