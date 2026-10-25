import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const releaseApiUrl = "https://api.github.com/repos/Dobrygnom/family-bridge/releases/latest";
const allowedDownloadPrefix = "https://github.com/Dobrygnom/family-bridge/releases/download/";

export interface UpdateState {
  available: boolean;
  version?: string;
  checking?: boolean;
  downloading: boolean;
  progress?: number;
  ready?: boolean;
  error?: string;
  installRequested?: boolean;
  installing?: boolean;
  waitingFor?: "activity" | "dictation" | "editing" | "background";
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
  size?: number;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

interface PreparedUpdate {
  version: string;
  appBundle: string;
  downloadUrl: string;
}

export function normalizeVersion(value: string) {
  return value.trim().replace(/^v/i, "").split("-")[0];
}

export function isVersionNewer(current: string, candidate: string) {
  const left = normalizeVersion(current).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = normalizeVersion(candidate).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

export function shouldReplacePreparedUpdate(preparedVersion: string, candidateVersion: string) {
  return isVersionNewer(preparedVersion, candidateVersion);
}

export function findMacAppBundle(executablePath: string) {
  const pathApi = executablePath.startsWith("/") ? path.posix : path;
  let current = pathApi.resolve(executablePath);
  while (true) {
    if (current.toLowerCase().endsWith(".app")) return current;
    const parent = pathApi.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function selectMacAsset(release: GitHubRelease, architecture: string) {
  const version = normalizeVersion(release.tag_name);
  const arch = architecture === "arm64" ? "arm64" : "x64";
  const expectedName = `Family-Bridge-${version}-${arch}.zip`;
  const asset = release.assets.find((candidate) => candidate.name === expectedName);
  if (!asset) throw new Error(`В релизе ${version} нет сборки для ${arch}`);
  if (!asset.browser_download_url.startsWith(allowedDownloadPrefix)) throw new Error("GitHub вернул недопустимый адрес обновления");
  if (!/^sha256:[a-f\d]{64}$/i.test(asset.digest ?? "")) throw new Error("У релиза нет контрольной суммы SHA-256");
  return { asset, version };
}

const DOWNLOAD_IDLE_TIMEOUT_MS = 45_000;

async function existingSize(file: string) {
  try { return (await stat(file)).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
}

async function hashExisting(file: string, hash: ReturnType<typeof createHash>) {
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
}

export async function downloadAndVerify(
  asset: ReleaseAsset,
  destination: string,
  onProgress: (progress: number) => void,
  options: { fetch?: typeof fetch; idleTimeoutMs?: number } = {},
) {
  const fetchUpdate = options.fetch ?? fetch;
  const idleTimeoutMs = options.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
  const expectedSize = Number.isSafeInteger(asset.size) && Number(asset.size) > 0 ? Number(asset.size) : 0;
  let downloaded = await existingSize(destination);
  if (expectedSize && downloaded > expectedSize) { await rm(destination, { force: true }); downloaded = 0; }
  const expectedDigest = asset.digest!.slice("sha256:".length).toLowerCase();
  if (expectedSize && downloaded === expectedSize) {
    const completeHash = createHash("sha256");
    await hashExisting(destination, completeHash);
    if (completeHash.digest("hex") === expectedDigest) { onProgress(99); return; }
    await rm(destination, { force: true });
    downloaded = 0;
  }
  const controller = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  const refreshIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error("Загрузка обновления остановилась и будет продолжена автоматически")), idleTimeoutMs);
    idleTimer.unref();
  };
  refreshIdleTimer();
  const requestHeaders: Record<string, string> = { Accept: "application/octet-stream", "User-Agent": "Family-Bridge-Updater" };
  if (downloaded) requestHeaders.Range = `bytes=${downloaded}-`;
  let response: Response;
  try { response = await fetchUpdate(asset.browser_download_url, {
    headers: requestHeaders,
    redirect: "follow",
    signal: controller.signal,
  }); } catch (error) { clearTimeout(idleTimer); throw error; }
  refreshIdleTimer();
  if (!response.ok || !response.body) { clearTimeout(idleTimer); throw new Error(`Не удалось скачать обновление: HTTP ${response.status}`); }
  if (!response.url.startsWith(allowedDownloadPrefix) && !response.url.startsWith("https://release-assets.githubusercontent.com/")) {
    clearTimeout(idleTimer);
    throw new Error("Загрузка обновления была перенаправлена на неизвестный сервер");
  }
  const range = response.headers.get("content-range");
  const rangeAccepted = downloaded > 0 && response.status === 206 && range?.startsWith(`bytes ${downloaded}-`);
  if (downloaded > 0 && !rangeAccepted) downloaded = 0;
  const contentLength = Number(response.headers.get("content-length")) || 0;
  const rangeTotal = Number(range?.match(/\/(\d+)$/)?.[1]) || 0;
  const total = expectedSize || rangeTotal || downloaded + contentLength;
  const output = createWriteStream(destination, { flags: downloaded ? "a" : "w" });
  const hash = createHash("sha256");
  try {
    if (downloaded) await hashExisting(destination, hash);
    if (total > 0) onProgress(Math.min(99, Math.round((downloaded / total) * 100)));
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      refreshIdleTimer();
      const bytes = Buffer.from(value);
      hash.update(bytes);
      downloaded += bytes.length;
      if (!output.write(bytes)) await once(output, "drain");
      if (total > 0) onProgress(Math.min(99, Math.round((downloaded / total) * 100)));
    }
    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy();
    throw error;
  } finally {
    clearTimeout(idleTimer);
  }
  if (expectedSize && downloaded !== expectedSize) throw new Error("Размер обновления не совпал; загрузка будет продолжена автоматически");
  const actual = hash.digest("hex");
  if (actual !== expectedDigest) { await rm(destination, { force: true }); throw new Error("Контрольная сумма обновления не совпала; файл удалён"); }
}

async function findExtractedBundle(root: string): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory() && entry.name.toLowerCase().endsWith(".app")) return candidate;
    if (entry.isDirectory()) {
      const nested = await findExtractedBundle(candidate);
      if (nested) return nested;
    }
  }
  return undefined;
}

const installerScript = `#!/bin/sh
set -u
PID="$1"
CURRENT="$2"
NEW="$3"
BACKUP="$4"
LOG="$5"
exec >>"$LOG" 2>&1
COUNT=0
while kill -0 "$PID" 2>/dev/null && [ "$COUNT" -lt 60 ]; do
  sleep 1
  COUNT=$((COUNT + 1))
done
rm -rf "$BACKUP"
if mv "$CURRENT" "$BACKUP" && mv "$NEW" "$CURRENT"; then
  /usr/bin/open "$CURRENT"
  rm -rf "$BACKUP"
  exit 0
fi
if [ ! -e "$CURRENT" ] && [ -e "$BACKUP" ]; then
  mv "$BACKUP" "$CURRENT"
fi
/usr/bin/open "$CURRENT"
exit 1
`;

export class MacReleaseUpdater {
  private busy = false;
  private prepared?: PreparedUpdate;
  private installerStarted = false;

  constructor(
    private readonly currentVersion: string,
    private readonly executablePath: string,
    private readonly userData: string,
    private readonly architecture: string,
    private readonly onState: (state: UpdateState) => void,
  ) {}

  get hasPreparedUpdate() {
    return Boolean(this.prepared);
  }

  async checkForUpdates() {
    if (this.busy) return;
    this.busy = true;
    this.onState({ available: false, checking: true, downloading: false });
    try {
      const response = await fetch(releaseApiUrl, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "Family-Bridge-Updater", "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (!response.ok) throw new Error(`Не удалось проверить обновления: HTTP ${response.status}`);
      const release = await response.json() as GitHubRelease;
      if (release.draft || release.prerelease) throw new Error("Последний GitHub-релиз ещё не готов для установки");
      const candidateVersion = normalizeVersion(release.tag_name);
      if (this.prepared && !shouldReplacePreparedUpdate(this.prepared.version, candidateVersion)) {
        this.onState({ available: true, version: this.prepared.version, downloading: false, progress: 100, ready: true });
        return;
      }
      if (!isVersionNewer(this.currentVersion, candidateVersion)) {
        this.onState({ available: false, downloading: false });
        return;
      }
      const { asset, version } = selectMacAsset(release, this.architecture);
      if (this.prepared) {
        const obsolete = this.prepared;
        this.prepared = undefined;
        this.installerStarted = false;
        await rm(path.join(this.userData, "updates", obsolete.version), { recursive: true, force: true });
      }
      this.onState({ available: true, version, downloading: true, progress: 0 });
      const updateRoot = path.join(this.userData, "updates", version);
      await mkdir(updateRoot, { recursive: true });
      const archive = path.join(updateRoot, `${asset.name}.partial`);
      try {
        await downloadAndVerify(asset, archive, (progress) => this.onState({ available: true, version, downloading: true, progress }));
        const extracted = path.join(updateRoot, "extracted");
        await rm(extracted, { recursive: true, force: true });
        await mkdir(extracted, { recursive: true });
        await execFileAsync("/usr/bin/ditto", ["-x", "-k", archive, extracted]);
        const appBundle = await findExtractedBundle(extracted);
        if (!appBundle) throw new Error("В архиве обновления не найдено приложение Family Bridge");
        const infoPlist = path.join(appBundle, "Contents", "Info.plist");
        await access(infoPlist, constants.R_OK);
        const { stdout } = await execFileAsync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPlist]);
        if (normalizeVersion(stdout) !== version) throw new Error("Версия внутри скачанного приложения не совпадает с релизом");
        this.prepared = { version, appBundle, downloadUrl: asset.browser_download_url };
        this.onState({ available: true, version, downloading: false, progress: 100, ready: true });
      } catch (error) { throw error; }
    } catch (error) {
      this.onState({ available: false, downloading: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.busy = false;
    }
  }

  async launchInstaller() {
    if (!this.prepared || this.installerStarted) return false;
    const currentBundle = findMacAppBundle(this.executablePath);
    if (!currentBundle) throw new Error("Не удалось определить установленное приложение Family Bridge");
    const currentParent = path.dirname(currentBundle);
    await access(currentParent, constants.W_OK);
    const helperRoot = path.join(this.userData, "updates", this.prepared.version);
    const helper = path.join(helperRoot, "install-update.sh");
    const backup = `${currentBundle}.previous`;
    const log = path.join(helperRoot, "install.log");
    await writeFile(helper, installerScript, "utf8");
    await chmod(helper, 0o700);
    const child = spawn("/bin/sh", [helper, String(process.pid), currentBundle, this.prepared.appBundle, backup, log], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    this.installerStarted = true;
    return true;
  }

  get downloadUrl() {
    return this.prepared?.downloadUrl;
  }
}
