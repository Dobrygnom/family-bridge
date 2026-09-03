// Real Electron transport probe. No window, private speech, or personal app state.
const { app } = require("electron");
const { mkdtempSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const profile = mkdtempSync(path.join(os.tmpdir(), "fb-dictation-probe-"));
app.setPath("userData", profile);
const deadline = setTimeout(() => app.exit(1), 25_000);
app.whenReady().then(async () => {
  const { DictationService } = await import(pathToFileURL(path.resolve(__dirname, "../dist-electron/electron/dictation.js")).href);
  const { encodeDictationWav } = await import(pathToFileURL(path.resolve(__dirname, "../dist-electron/src/core/dictation.js")).href);
  const { dictationFetch } = await import(pathToFileURL(path.resolve(__dirname, "../dist-electron/electron/dictation-network.js")).href);
  const nativeFetch = async (input, init) => {
    const response = await dictationFetch(input, init);
    console.log(JSON.stringify({ transport: "electron-net", status: response.status, contentType: response.headers.get("content-type"), challenge: response.headers.get("cf-mitigated") === "challenge" }));
    return response;
  };
  const audio = encodeDictationWav([new Float32Array(1600)], 16000);
  const result = await new DictationService(undefined, nativeFetch, 15_000).transcribe({ id: "diagnostic-silence", audio });
  console.log(JSON.stringify({ ok: result.ok, ...(result.ok ? { textLength: result.text.length } : { code: result.code }) }));
  app.exit(result.ok || result.code === "empty" ? 0 : 1);
}).catch(() => { console.log("PROBE_FAILED"); app.exit(1); }).finally(() => clearTimeout(deadline));
