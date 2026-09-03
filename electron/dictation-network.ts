import { net } from "electron";

// Use Electron's native desktop network stack, not its bundled Node/undici.
// Credentials remain in main; never attach browser-session cookies or follow
// redirects. DictationService always supplies the one fixed HTTPS endpoint.
export const dictationFetch: typeof fetch = (input, init) => {
  if (typeof input !== "string") throw new Error("Invalid dictation endpoint");
  return net.fetch(input, { ...init, credentials: "omit" });
};
