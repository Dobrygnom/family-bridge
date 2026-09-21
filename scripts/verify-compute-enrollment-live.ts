import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.env.FAMILY_BRIDGE_LIVE_E2E !== "1") {
  throw new Error("Set FAMILY_BRIDGE_LIVE_E2E=1 to run the production Supabase and ChatGPT smoke test.");
}

const executable = path.resolve(process.argv[2] || (process.platform === "darwin"
  ? `release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/Family Bridge.app/Contents/MacOS/Family Bridge`
  : "release/win-unpacked/Family Bridge.exe"));
assert.ok(existsSync(executable), `Packaged application not found: ${executable}`);

const configuredRoot = process.env.FAMILY_BRIDGE_PROVIDER_ROOT
  ? path.resolve(process.env.FAMILY_BRIDGE_PROVIDER_ROOT)
  : process.env.APPDATA
    ? path.join(process.env.APPDATA, "family-bridge", "compute-channel")
    : "";
const providerAuth = path.join(configuredRoot, "enrollment");
const providerKeys = path.join(configuredRoot, "enrollment-keys.json");
assert.ok(configuredRoot && existsSync(providerAuth) && existsSync(providerKeys), "The configured trusted-computer identity and enrollment keys are required.");

const root = await mkdtemp(path.join(os.tmpdir(), "family-bridge-live-compute-"));
const hostProfile = path.join(root, "host");
const clientProfile = path.join(root, "client");
const hostCompute = path.join(hostProfile, "compute-channel");
await mkdir(hostCompute, { recursive: true });
await cp(providerAuth, path.join(hostCompute, "enrollment"), { recursive: true });
await copyFile(providerKeys, path.join(hostCompute, "enrollment-keys.json"));

const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

class Cdp {
  private socket!: WebSocket;
  private nextId = 1;
  private constructor(private readonly port: number) {}

  static async connect(port: number) {
    const cdp = new Cdp(port);
    let endpoint: string | undefined;
    for (let attempt = 0; attempt < 120 && !endpoint; attempt += 1) {
      try {
        const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
        endpoint = pages.find(page => page.type === "page")?.webSocketDebuggerUrl;
      } catch { /* application is still starting */ }
      if (!endpoint) await delay(250);
    }
    assert.ok(endpoint, `Renderer did not expose CDP on port ${port}`);
    cdp.socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      cdp.socket.addEventListener("open", () => resolve(), { once: true });
      cdp.socket.addEventListener("error", () => reject(new Error(`Could not connect to renderer on port ${port}`)), { once: true });
    });
    return cdp;
  }

  evaluate<T>(expression: string): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const listener = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } }; error?: { message?: string } };
        if (message.id !== id) return;
        this.socket.removeEventListener("message", listener);
        const problem = message.error?.message ?? message.result?.exceptionDetails?.exception?.description ?? message.result?.exceptionDetails?.text;
        if (problem) reject(new Error(problem));
        else resolve(message.result?.result?.value as T);
      };
      this.socket.addEventListener("message", listener);
      this.socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
  }

  async waitForBridge() {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        if (await this.evaluate<boolean>("typeof window.familyBridge?.getComputeState === 'function'")) return;
      } catch { /* preload and renderer are still starting */ }
      await delay(250);
    }
    throw new Error(`Family Bridge preload did not initialize on port ${this.port}`);
  }

  close() { this.socket.close(); }
}

function launch(profile: string, port: number) {
  return spawn(executable, [`--remote-debugging-port=${port}`], {
    env: { ...process.env, FAMILY_BRIDGE_E2E_ALLOW_SECOND_INSTANCE: "1", FAMILY_BRIDGE_E2E_USER_DATA: profile },
    windowsHide: true,
    stdio: "ignore",
  });
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  child.kill();
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function drive<T>(operation: Promise<T>, host: Cdp, client: Cdp) {
  let settled = false, value: T | undefined, failure: unknown;
  void operation.then(result => { settled = true; value = result; }, error => { settled = true; failure = error; });
  for (let attempt = 0; attempt < 240 && !settled; attempt += 1) {
    await Promise.allSettled([
      host.evaluate("window.familyBridge.getComputeState()"),
      client.evaluate("window.familyBridge.getComputeState()"),
    ]);
    if (!settled) await delay(1_000);
  }
  if (!settled) throw new Error("The live compute operation did not finish within four minutes");
  if (failure) throw failure;
  return value as T;
}

let hostProcess: ChildProcess | undefined, clientProcess: ChildProcess | undefined;
let host: Cdp | undefined, client: Cdp | undefined;
try {
  hostProcess = launch(hostProfile, 9321);
  clientProcess = launch(clientProfile, 9322);
  host = await Cdp.connect(9321);
  client = await Cdp.connect(9322);
  await Promise.all([host.waitForBridge(), client.waitForBridge()]);

  await host.evaluate("window.familyBridge.configureComputeHost(undefined, 'auto_accept')");
  await client.evaluate("window.familyBridge.setProcessingMode('trusted')");
  await host.evaluate("window.familyBridge.getComputeState()");

  let connected = false;
  for (let attempt = 0; attempt < 60 && !connected; attempt += 1) {
    const clientState = await client.evaluate<{ connected: boolean }>("window.familyBridge.getComputeState()");
    await host.evaluate("window.familyBridge.getComputeState()");
    connected = clientState.connected;
    if (!connected) await delay(500);
  }
  assert.equal(connected, true, "The fresh client did not join the trusted computer");

  // Prove store-and-forward: enqueue while the trusted computer is offline,
  // then restart the exact same isolated profile and complete the request.
  host.close(); host = undefined;
  await stop(hostProcess); hostProcess = undefined;
  const firstOperation = client.evaluate<any>("window.familyBridge.startPsychologistIntake()");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await client.evaluate<{ pending: number }>("window.familyBridge.getComputeState()");
    if (state.pending > 0) break;
    await delay(250);
  }
  hostProcess = launch(hostProfile, 9321);
  host = await Cdp.connect(9321);
  await host.waitForBridge();
  const first = await drive(firstOperation, host, client);
  const sessionId = first.intake?.sessionId;
  assert.match(sessionId ?? "", /^[A-Za-z0-9-]{20,}$/);
  assert.equal(first.intake.messages.filter((message: { role: string }) => message.role === "assistant").length, 1);

  const secondOperation = client.evaluate<any>("window.familyBridge.sendPsychologistIntake('Меня зовут Анна, моего партнёра зовут Борис. После переезда мы спорим о домашних делах и замолкаем. Я хочу спокойно договориться об обязанностях и о том, когда возвращаться к разговору после паузы.')");
  const second = await drive(secondOperation, host, client);
  assert.equal(second.intake.sessionId, sessionId, "The second turn did not resume the same Codex session");
  assert.equal(second.intake.messages.filter((message: { role: string }) => message.role === "assistant").length, 2);
  const finalOperation = client.evaluate<any>("window.familyBridge.finalizePsychologistIntake()");
  const finished = await drive(finalOperation, host, client);
  assert.equal(finished.context?.source, "interview");
  assert.equal(finished.contextAnalysis?.status, "ready");
  assert.ok(finished.contextAnalysis.people.length >= 1, "The hosted intake did not identify the partner");
  assert.ok(finished.contextAnalysis.topics.length >= 1, "The hosted intake did not prepare a topic");
  console.log(JSON.stringify({ liveEnrollment: true, offlineQueueRecovery: true, persistentSession: true,
    sessionId, turns: 2, people: finished.contextAnalysis.people.length, topics: finished.contextAnalysis.topics.length }));
} finally {
  host?.close(); client?.close();
  await Promise.all([stop(hostProcess), stop(clientProcess)]);
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
