import { createServer, type Server } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RemoteSupport } from "./remote-support.js";

export function supportLocatorFiles(userData: string) {
  const key = createHash("sha256").update(path.resolve(userData)).digest("hex").slice(0, 20);
  return [path.join(userData, "diagnostics", "support-control.json"),
    path.join(os.tmpdir(), `family-bridge-support-${key}.json`)];
}
/** Local operator access without Electron Inspector or a second profile writer. */
export async function startSupportControl(userData: string, support: RemoteSupport): Promise<Server> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (req.headers.origin || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(403); res.end('{"error":"forbidden"}'); req.resume(); return;
    }
    req.resume();
    void (async () => {
      if (req.method === "GET" && req.url === "/status") return support.status();
      if (req.method === "POST" && req.url === "/peer/snapshot") return support.request("snapshot");
      if (req.method === "POST" && req.url === "/peer/update") return support.request("update");
      res.statusCode = 404; return { error: "unknown-command" };
    })().then(value => res.end(JSON.stringify(value))).catch(() => {
      res.statusCode = 503; res.end('{"error":"support-unavailable","hint":"Read /status for technical state"}');
    });
  });
  server.maxConnections = 8;
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  server.on("error", () => {});
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Support listener unavailable");
  const locator = JSON.stringify({ schema: 1, pid: process.pid, port: address.port, token });
  let written = false;
  for (const file of supportLocatorFiles(userData)) {
    try { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, locator, { mode: 0o600 }); written = true; }
    catch { /* The independent fallback may remain writable. */ }
  }
  if (!written) { server.close(); throw new Error("Support locator unavailable"); }
  server.unref();
  return server;
}
