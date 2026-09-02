import assert from "node:assert/strict";
import test from "node:test";
import { DictationService, parseDictationCredentials, validDictationWav } from "../electron/dictation.js";
import { appendDictation, encodeDictationWav, MAX_DICTATION_BYTES } from "../src/core/dictation.js";
import { parseOwnerDrafts } from "../src/ui/drafts.js";
import { dictationText } from "../src/ui/dictation-text.js";
import { allowAppPermission } from "../src/core/media-permissions.js";

test("microphone permission does not break invitation copying or allow camera/external pages", () => {
  assert.equal(allowAppPermission(true, "clipboard-sanitized-write"), true);
  assert.equal(allowAppPermission(true, "media", ["audio"]), true);
  assert.equal(allowAppPermission(true, "media", ["video"]), false);
  assert.equal(allowAppPermission(true, "media", ["audio", "video"]), false);
  assert.equal(allowAppPermission(true, "media", []), false);
  assert.equal(allowAppPermission(true, "clipboard-read"), false);
  assert.equal(allowAppPermission(false, "media", ["audio"]), false);
  assert.equal(allowAppPermission(false, "clipboard-sanitized-write"), false);
});

const audio = () => encodeDictationWav([Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i) * 0.1)], 16000);
const auth = async () => ({ token: "test-token", accountId: "test-account" });
const request = (implementation: (url: string | URL | Request, options?: RequestInit) => Promise<Response>) => implementation as typeof fetch;

test("dictation encodes PCM16 WAV with duration and clipping bounds", () => {
  const bytes = encodeDictationWav([new Float32Array([-2, 0, 2, NaN]), new Float32Array([-2, 0, 2, 0])], 16000);
  assert.equal(validDictationWav(bytes), true);
  const view = new DataView(bytes.buffer);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(48, true), 32767);
  assert.equal(view.getInt16(50, true), 0);
  assert.throws(() => encodeDictationWav([], 48000));
  assert.throws(() => encodeDictationWav([new Float32Array(1)], 0));
  assert.throws(() => encodeDictationWav([new Float32Array(1), new Float32Array(2)], 16000));
  assert.throws(() => encodeDictationWav([new Float32Array(16000 * 126)], 16000));
});

test("main process rejects untrusted or malformed audio payloads", () => {
  for (const value of [null, [], {}, "audio.wav", new Uint8Array(0), new Uint8Array(MAX_DICTATION_BYTES + 1)]) assert.equal(validDictationWav(value), false);
  for (const offset of [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
    const bytes = audio(); bytes[offset] ^= 1;
    assert.equal(validDictationWav(bytes), false, `corrupt header at ${offset}`);
  }
});

test("only valid ChatGPT credentials are accepted; no API key fallback", () => {
  assert.equal(parseDictationCredentials("invalid"), null);
  assert.equal(parseDictationCredentials("null"), null);
  assert.equal(parseDictationCredentials(JSON.stringify({ OPENAI_API_KEY: "secret" })), null);
  assert.equal(parseDictationCredentials(JSON.stringify({ auth_mode: "apikey", tokens: { access_token: "secret" } })), null);
  assert.equal(parseDictationCredentials(JSON.stringify({ tokens: { access_token: "bad\nheader" } })), null);
  assert.deepEqual(parseDictationCredentials(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test", account_id: "account" } })), { token: "test", accountId: "account" });
});

test("dictation sends only the audio to fixed OpenAI endpoint and forbids redirects", async () => {
  let calls = 0;
  const service = new DictationService(auth, request(async (url, options) => {
    calls++;
    assert.equal(url, "https://chatgpt.com/backend-api/transcribe");
    assert.equal(options?.redirect, "error");
    assert.equal(options?.method, "POST");
    assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer test-token");
    const form = options?.body as FormData;
    assert.deepEqual([...form.keys()], ["file"]);
    const file = form.get("file") as File;
    assert.equal(file.name, "dictation.wav");
    assert.equal(file.type, "audio/wav");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), audio());
    return Response.json({ text: "  A real response.  " });
  }));
  assert.deepEqual(await service.transcribe({ id: "test", audio: audio() }), { ok: true, text: "A real response." });
  assert.equal(calls, 1);
});

test("missing login and bad audio never send a network request", async () => {
  let calls = 0;
  const service = new DictationService(async () => null, request(async () => { calls++; throw new Error(); }));
  assert.deepEqual(await service.transcribe({ id: "test", audio: audio() }), { ok: false, code: "auth" });
  for (const value of [null, {}, { id: "test", audio: [] }, { id: "../bad", audio: audio() }]) assert.deepEqual(await service.transcribe(value), { ok: false, code: "invalid_audio" });
  assert.equal(calls, 0);
});

for (const [status, code] of [[401, "auth"], [403, "unavailable"], [429, "limit"], [500, "unavailable"], [302, "unavailable"]] as const) {
  test(`dictation handles HTTP ${status} without exposing upstream error details`, async () => {
    const service = new DictationService(auth, request(async () => new Response("secret-token raw server error", { status })));
    assert.deepEqual(await service.transcribe({ id: "test", audio: audio() }), { ok: false, code });
  });
}

test("empty speech, unexpected response, and network errors are explicit", async () => {
  for (const [body, code] of [[{ text: "  " }, "empty"], [{ content: "bad" }, "unavailable"], [{ text: "a".repeat(50_001) }, "unavailable"]] as const) {
    const service = new DictationService(auth, request(async () => Response.json(body)));
    assert.deepEqual(await service.transcribe({ id: "test", audio: audio() }), { ok: false, code });
  }
  const service = new DictationService(auth, request(async () => { throw new Error("SECRET must not escape"); }));
  assert.deepEqual(await service.transcribe({ id: "test", audio: audio() }), { ok: false, code: "network" });
});

test("a cancelled request cannot add a late transcript and does not block retry", async () => {
  let finish!: (value: Response) => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const service = new DictationService(auth, request(async () => { started(); return new Promise((resolve) => { finish = resolve; }); }));
  const pending = service.transcribe({ id: "first", audio: audio() });
  await waiting;
  assert.deepEqual(await service.transcribe({ id: "second", audio: audio() }), { ok: false, code: "busy" });
  service.cancel("other-id");
  service.cancel("first");
  finish(Response.json({ text: "must not appear" }));
  assert.deepEqual(await pending, { ok: false, code: "cancelled" });
  const retry = service.transcribe({ id: "third", audio: audio() });
  await new Promise((resolve) => setTimeout(resolve, 0));
  finish(Response.json({ text: "retry works" }));
  assert.deepEqual(await retry, { ok: true, text: "retry works" });
});

test("timeout aborts network operation and produces a retryable error", async () => {
  const service = new DictationService(auth, request(async (_url, options) => new Promise((_resolve, reject) => {
    options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })), 10);
  assert.deepEqual(await service.transcribe({ id: "timeout", audio: audio() }), { ok: false, code: "timeout" });
});

test("cancel during credential loading never uploads", async () => {
  let finish!: (value: Awaited<ReturnType<typeof auth>>) => void;
  const service = new DictationService(() => new Promise((resolve) => { finish = resolve; }), request(async () => { assert.fail("must not upload"); }));
  const pending = service.transcribe({ id: "first", audio: audio() });
  service.cancel(); finish(await auth());
  assert.deepEqual(await pending, { ok: false, code: "cancelled" });
});

test("transcripts append to current draft without overwriting edits", () => {
  assert.equal(appendDictation("", " hello "), "hello");
  assert.equal(appendDictation("Already typed", "new words"), "Already typed new words");
  assert.equal(appendDictation("Edited while waiting\n", "new words"), "Edited while waiting\nnew words");
  assert.equal(appendDictation("keep me", "  "), "keep me");
});

test("drafts survive reload and malformed storage is safe", () => {
  const drafts = { question1: "My private draft", question2: "" };
  assert.deepEqual(parseOwnerDrafts(JSON.stringify(drafts)), drafts);
  assert.deepEqual(parseOwnerDrafts("broken"), {});
  assert.deepEqual(parseOwnerDrafts("null"), {});
  assert.deepEqual(parseOwnerDrafts('["a"]'), {});
  assert.deepEqual(parseOwnerDrafts('{"valid":"text","bad":123}'), { valid: "text" });
});

test("all four UI languages provide dictation status and errors", () => {
  for (const copy of Object.values(dictationText)) {
    assert.deepEqual(Object.keys(copy).sort(), Object.keys(dictationText.ru).sort());
    assert.deepEqual(Object.keys(copy.errors).sort(), Object.keys(dictationText.ru.errors).sort());
    for (const value of Object.values(copy.errors)) assert.ok(value.length > 10);
  }
});
