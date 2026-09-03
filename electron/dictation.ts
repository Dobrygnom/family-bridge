import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_DICTATION_BYTES, MAX_DICTATION_SECONDS, type DictationResult } from "../src/core/dictation.js";

const execFileAsync = promisify(execFile);
const endpoint = "https://chatgpt.com/backend-api/transcribe";
type Credentials = { token: string; accountId?: string };

export function parseDictationCredentials(raw: string): Credentials | null {
  try {
    const auth = JSON.parse(raw);
    const mode = auth.auth_mode ?? auth.authMode;
    if (mode && !["chatgpt", "chatgpt_auth_tokens"].includes(mode)) return null;
    const token = auth.tokens?.access_token;
    if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) return null;
    const accountId = auth.tokens?.account_id;
    return { token, ...(typeof accountId === "string" && accountId && !/[\r\n]/.test(accountId) ? { accountId } : {}) };
  } catch { return null; }
}

// Read only the current Codex login. Never copy, refresh, print, or export it.
export async function loadDictationCredentials(): Promise<Credentials | null> {
  const codexDirectory = process.env.CODEX_HOME || path.join(homedir(), ".codex");
  const config = await readFile(path.join(codexDirectory, "config.toml"), "utf8").catch(() => "");
  const rootConfig = config.split(/^\s*\[/m)[0];
  const mode = /^\s*cli_auth_credentials_store\s*=\s*["']([^"']+)["']/m.exec(rootConfig)?.[1] ?? "file";
  if ((mode === "auto" || mode === "keyring") && process.platform === "darwin") {
    const canonical = await realpath(codexDirectory).catch(() => codexDirectory);
    const account = `cli|${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
    try {
      const { stdout } = await execFileAsync("/usr/bin/security", ["find-generic-password", "-s", "Codex Auth", "-a", account, "-w"], { timeout: 15_000, maxBuffer: 1024 * 1024 });
      const credentials = parseDictationCredentials(stdout);
      if (credentials) return credentials;
    } catch { /* Do not propagate stderr/stdout from credential helpers. */ }
  }
  if (mode === "keyring" || mode === "ephemeral") return null;
  return parseDictationCredentials(await readFile(path.join(codexDirectory, "auth.json"), "utf8").catch(() => ""));
}

export function validDictationWav(value: unknown): value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 46 || value.byteLength > MAX_DICTATION_BYTES) return false;
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.toString("ascii", 12, 16) !== "fmt " || bytes.toString("ascii", 36, 40) !== "data") return false;
  const rate = bytes.readUInt32LE(24);
  return bytes.readUInt32LE(4) === bytes.length - 8 && bytes.readUInt32LE(16) === 16 && bytes.readUInt16LE(20) === 1 && bytes.readUInt16LE(22) === 1 && bytes.readUInt16LE(34) === 16 && rate >= 8_000 && rate <= 96_000 && bytes.readUInt32LE(28) === rate * 2 && bytes.readUInt16LE(32) === 2 && bytes.readUInt32LE(40) === bytes.length - 44 && (bytes.length - 44) % 2 === 0 && (bytes.length - 44) / (rate * 2) <= MAX_DICTATION_SECONDS + 5;
}

export class DictationService {
  private active?: { id: string; controller: AbortController };
  constructor(private readonly credentials = loadDictationCredentials, private readonly request: typeof fetch = fetch, private readonly timeoutMs = 60_000,
    private readonly diagnostic?: (fields: { stage: string; code?: string; elapsedMs: number }) => void) {}

  cancel(id?: string) {
    if (this.active && (!id || this.active.id === id)) this.active.controller.abort();
  }

  async transcribe(input: unknown): Promise<DictationResult> {
    const value = input as { id?: unknown; audio?: unknown } | undefined;
    if (typeof value?.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(value.id) || !validDictationWav(value.audio)) return { ok: false, code: "invalid_audio" };
    if (this.active) return { ok: false, code: "busy" };
    const active = { id: value.id, controller: new AbortController() };
    this.active = active;
    const startedAt = Date.now();
    const record = (stage: string, code?: string) => {
      try { this.diagnostic?.({ stage, code, elapsedMs: Date.now() - startedAt }); } catch { /* Logging must not interrupt dictation. */ }
    };
    record("started");
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; active.controller.abort(); }, this.timeoutMs);
    try {
      const credentials = await this.credentials();
      if (active.controller.signal.aborted) return { ok: false, code: timedOut ? "timeout" : "cancelled" };
      if (!credentials) { record("failed", "auth_missing"); return { ok: false, code: "auth" }; }
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(value.audio)], { type: "audio/wav" }), "dictation.wav");
      const response = await this.request(endpoint, {
        method: "POST", body: form, redirect: "error", signal: active.controller.signal,
        headers: { Authorization: `Bearer ${credentials.token}`, originator: "family_bridge_audio_test", "User-Agent": "FamilyBridgeDictation/1.0", ...(credentials.accountId ? { "ChatGPT-Account-Id": credentials.accountId } : {}) },
      });
      record("response", `HTTP_${response.status}`);
      if (response.status === 401) return { ok: false, code: "auth" };
      if (response.status === 429) return { ok: false, code: "limit" };
      if (!response.ok) return { ok: false, code: "unavailable" };
      let body: { text?: unknown } | null;
      try { body = await response.json(); }
      catch { record("failed", "invalid_json"); return { ok: false, code: "unavailable" }; }
      if (active.controller.signal.aborted) return { ok: false, code: timedOut ? "timeout" : "cancelled" };
      if (typeof body?.text !== "string" || body.text.length > 50_000) { record("failed", "invalid_response"); return { ok: false, code: "unavailable" }; }
      record(body.text.trim() ? "completed" : "empty");
      return body.text.trim() ? { ok: true, text: body.text.trim() } : { ok: false, code: "empty" };
    } catch {
      // Never send request headers, auth file paths, or upstream error bodies to UI/logs.
      const code = active.controller.signal.aborted ? timedOut ? "timeout" : "cancelled" : "network";
      record("failed", code);
      return { ok: false, code };
    } finally {
      clearTimeout(timer);
      if (this.active === active) this.active = undefined;
    }
  }
}
