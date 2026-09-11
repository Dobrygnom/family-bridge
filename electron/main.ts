import { UpdateActivity } from "./update-activity.js";
import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, shell, systemPreferences, Tray, type MessageBoxOptions, type IpcMainInvokeEvent } from "electron";
import { conversationThreads } from "../src/core/conversation-threads.js";
import electronUpdater from "electron-updater";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BackgroundService } from "./background-service.js";
import { MacReleaseUpdater, type UpdateState } from "./mac-updater.js";
import { exportReportFiles, revealInWindowsExplorer } from "./open-directory.js";
import { AtomicStore } from "./store.js";
import { DictationService } from "./dictation.js";
import { dictationFetch } from "./dictation-network.js";
import { allowAppPermission } from "../src/core/media-permissions.js";
import { AutomaticUpdate } from "./automatic-update.js";
import { Diagnostics } from "./diagnostics.js";
import { installCrashDiagnostics } from "./crash-diagnostics.js";
import { startSupportControl } from "./support-control.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;
process.stdout?.on("error", () => undefined);
process.stderr?.on("error", () => undefined);
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let service: BackgroundService;
const dictation = new DictationService(undefined, dictationFetch, undefined, (fields) => service?.diagnostics.record("dictation", fields));
let isQuitting = false;
let macUpdater: MacReleaseUpdater | null = null;
let updateInstallIsQuitting = false;
let rendererUpdateBlocked = true;
let rendererUpdateReason: "activity" | "dictation" | "editing" = "activity";
let currentUpdate: UpdateState = { available: false, downloading: false };

function publishUpdate(update: UpdateState) {
  currentUpdate = update;
  service.setUpdateState(update);
  service.diagnostics.record('updater.state', { version: update.version, ready: update.ready, downloading: update.downloading, installing: update.installing, waitingFor: update.waitingFor, current: update.progress });
}
let activeIpc = 0;
const ipcActivity = new UpdateActivity();
const activeChannels = new Map<symbol, { channel: string; startedAt: number }>();
let preparingUpdate = false;
let updateGate: AutomaticUpdate;
function handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (updateInstallIsQuitting || preparingUpdate && channel !== "bridge:update-blocked") throw new Error("Приложение обновляется. Черновики сохранены.");
    activeIpc++;
    const token = Symbol(), end = ipcActivity.begin("ipc");
    activeChannels.set(token, { channel, startedAt: Date.now() });
    try { return await listener(event, ...args); } finally { activeIpc--; end(); activeChannels.delete(token); }
  });
}
let windowsUpdateVersion: string | undefined;
let windowsUpdateDownloading = false;
let windowsUpdateReady = false;
let updateCheckOperation: Promise<void> | undefined;
if (process.env.FAMILY_BRIDGE_E2E_USER_DATA) app.setPath("userData", path.resolve(process.env.FAMILY_BRIDGE_E2E_USER_DATA));
const hasSingleInstanceLock = process.env.FAMILY_BRIDGE_E2E_ALLOW_SECOND_INSTANCE === "1" || app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();
else installCrashDiagnostics(app, crashReporter, new Diagnostics(app.getPath("userData")), () => updateInstallIsQuitting);
app.on("second-instance", () => {
  showMainWindow();
});

function showMainWindow() {
  if (!mainWindow) {
    if (app.isReady() && serviceReady) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  rendererUpdateBlocked = true;
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 920,
    minHeight: 640,
    backgroundColor: "#0d151d",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const devUrl = !app.isPackaged && process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(path.join(dirname, "..", "..", "dist", "index.html"));
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  const contents = mainWindow.webContents;
  contents.on("preload-error", () => service.diagnostics.record("renderer.preload-failed"));
  contents.on("render-process-gone", (_event, details) => service.diagnostics.record("renderer.gone", { code: `${details.reason}:${details.exitCode}` }));
  mainWindow.on("unresponsive", () => service.diagnostics.record("renderer.unresponsive"));
  mainWindow.on("responsive", () => service.diagnostics.record("renderer.responsive"));
  contents.on("did-finish-load", () => {
    if (!app.isPackaged) mainWindow?.setTitle("Family Bridge — локальная сборка");
    service.diagnostics.record("renderer.loaded");
  });
  const trustedUrl = (url: string) => {
    try {
      const candidate = new URL(url);
      const expected = new URL(contents.getURL());
      return candidate.protocol === expected.protocol && candidate.host === expected.host && candidate.pathname === expected.pathname;
    } catch { return false; }
  };
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => { if (!trustedUrl(url)) event.preventDefault(); });
  contents.session.setPermissionCheckHandler((sender, permission, _origin, details) => allowAppPermission(sender === contents, permission, details.mediaType ? [details.mediaType] : []));
  contents.session.setPermissionRequestHandler((sender, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes ?? [] : [];
    callback(allowAppPermission(sender === contents && trustedUrl(details.requestingUrl), permission, mediaTypes));
  });
  const stopDictation = () => {
    dictation.cancel();
    contents.send("bridge:event", { type: "dictation-cancelled" });
  };
  mainWindow.on("hide", stopDictation);
  mainWindow.on("minimize", stopDictation);
  mainWindow.on("closed", () => { mainWindow = null; });
}

function createTray() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect rx="9" width="32" height="32" fill="#80d6b7"/><path d="M9 10h14v3H9zm0 6h10v3H9zm0 6h7v3H9z" fill="#10222a"/></svg>`;
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Family Bridge работает в фоне");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Открыть Family Bridge", click: showMainWindow },
      { type: "separator" },
      { label: "Завершить", click: () => { isQuitting = true; app.quit(); } },
    ]),
  );
  tray.on("double-click", showMainWindow);
}

async function installPreparedUpdate() {
  publishUpdate({ ...currentUpdate, installing: true, waitingFor: undefined, error: undefined });
  if (process.platform === "darwin" && macUpdater) {
    try {
      updateInstallIsQuitting = true;
      const launched = await macUpdater.launchInstaller();
      if (!launched) throw new Error("Не удалось запустить установщик");
      isQuitting = true;
      app.quit();
    } catch (error) {
      updateInstallIsQuitting = false;
      isQuitting = false;
      throw error;
    }
    return;
  }
  updateInstallIsQuitting = true;
  isQuitting = true;
  autoUpdater.quitAndInstall(true, true);
}

async function presentReadyUpdate(state: UpdateState) {
  if (state.ready && state.version) updateGate.ready();
}

function checkForUpdates() {
  if (!app.isPackaged) return Promise.resolve();
  if (process.platform !== "darwin" && (windowsUpdateDownloading || windowsUpdateReady)) return Promise.resolve();
  if (updateCheckOperation) return updateCheckOperation;
  updateCheckOperation = (async () => {
    if (process.platform === "darwin" && macUpdater) {
      await macUpdater.checkForUpdates();
      return;
    }
    publishUpdate({ available: false, checking: true, downloading: false });
    try {
      await autoUpdater.checkForUpdatesAndNotify();
    } catch (error) {
      publishUpdate({ available: false, downloading: false, error: error instanceof Error ? error.message : String(error) });
    }
  })().finally(() => { updateCheckOperation = undefined; });
  return updateCheckOperation;
}

let serviceReady = false;
app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  const store = new AtomicStore(app.getPath("userData"));
  service = new BackgroundService(
    app.getPath("userData"),
    app.isPackaged ? process.resourcesPath : path.resolve(dirname, "..", ".."),
    store,
    () => mainWindow,
    () => {
      if (Notification.isSupported()) {
        new Notification({ title: "Family Bridge ждёт вашего ответа", body: "Один из разговоров поставлен на паузу. Откройте приложение, чтобы продолжить." }).show();
      }
    },
    {
      appVersion: app.getVersion(),
      updateDiagnostics: () => ({ gate: updateGate?.snapshot(), ipc: [...activeChannels.values()].map(row => ({ ...row, elapsedMs: Math.max(0, Date.now() - row.startedAt) })), rendererBlocked: rendererUpdateBlocked, rendererReason: rendererUpdateReason }),
      conversationResetVersion: "0.3.25",
      experienceResetVersion: "natural-dialogues-v1",
      reportsExportDirectory: path.join(app.getPath("documents"), "Family Bridge Reports"),
      requestUpdateCheck: () => setTimeout(() => void checkForUpdates(), 0),
      requestSupportUpdate: () => {
        setTimeout(() => {
          void checkForUpdates().then(() => {
            if (currentUpdate.ready) {
              updateGate.requestNow();
              void updateGate.tick();
            }
          }).catch(() => service.diagnostics.record("support.failed"));
        }, 0);
      },
    },
  );
  service.diagnostics.record('process.runtime', { version: app.getVersion(), executable: process.execPath, userData: app.getPath('userData'), cwd: process.cwd(), updatedLaunch: process.argv.includes('--updated'), agentLaunched: Boolean(process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID) });
  service.diagnostics.snapshotProfile(app.getPath('userData'), 'before-start');
  await service.start();
  service.diagnostics.snapshotProfile(app.getPath('userData'), 'after-start');
  void startSupportControl(app.getPath("userData"), service.support, {
      diagnostics: () => ({ schema: 1, at: new Date().toISOString(), bootId: service.diagnostics.bootId, version: app.getVersion(), update: service.updateDiagnostics(), gate: updateGate?.snapshot(), ipc: [...activeChannels.values()].map(row => ({ ...row, elapsedMs: Math.max(0, Date.now() - row.startedAt) })), rendererBlocked: rendererUpdateBlocked, rendererReason: rendererUpdateReason }),
      refreshContext: () => { if (preparingUpdate || updateInstallIsQuitting) throw new Error("Update in progress"); void service.refreshContextNow().catch(() => service.diagnostics.record("context.read-failed")); return { accepted: true }; },
      update: () => { if (!currentUpdate.ready) throw new Error("Update not ready"); updateGate.requestNow(); setTimeout(() => void updateGate.tick(), 0); return { accepted: true }; },
    })
    .then(server => app.once("will-quit", () => { service.support.stop(); server.close(); }))
    .catch(() => service.diagnostics.record("support.failed"));
  updateGate = new AutomaticUpdate({
    canInstall: () => app.isPackaged && activeIpc === 0 && (!mainWindow || !rendererUpdateBlocked),
    prepare: async () => {
      preparingUpdate = true;
      const prepared = await service.prepareForUpdate();
      return prepared;
    },
    install: installPreparedUpdate,
    resume: () => { preparingUpdate = false; updateInstallIsQuitting = false; isQuitting = false; service.cancelPreparedUpdate(); },
    failed: error => publishUpdate({ ...currentUpdate, available:true, downloading:false, ready:true, installing:false, error:error instanceof Error ? error.message : String(error) }),
    waiting: reason => {
      const waitingFor = reason === "activity" && rendererUpdateBlocked ? rendererUpdateReason : reason;
      if (currentUpdate.waitingFor !== waitingFor) publishUpdate({ ...currentUpdate, installing: false, waitingFor });
    },
  });
  handle("bridge:update-blocked", (_event, blocked, reason) => {
    rendererUpdateBlocked = blocked !== false;
    rendererUpdateReason = reason === "dictation" || reason === "editing" ? reason : "activity";
  });
  const conversationNotifications = new Map<string, number>();
  handle("bridge:notify-conversation", async (_event, threadId: unknown) => {
    if (typeof threadId !== "string" || !Notification.isSupported() || mainWindow?.isFocused()) return;
    if (Date.now() - (conversationNotifications.get(threadId) ?? 0) < 60_000) return;
    const snapshot = await service.state();
    if (!conversationThreads(snapshot).some(thread => thread.id === threadId)) return;
    const body = { ru: "В разговоре появилось продолжение. Открыть новые сообщения.", en: "A conversation has new messages. Open the continuation.", cs: "V rozhovoru jsou nové zprávy. Otevřít pokračování.", fr: "Une conversation contient de nouveaux messages. Ouvrir la suite." }[snapshot.language];
    const notification = new Notification({ title: "Family Bridge", body });
    notification.on("click", () => { showMainWindow(); mainWindow?.webContents.send("bridge:event", { type: "open-conversation", threadId }); });
    conversationNotifications.set(threadId, Date.now());
    notification.show();
  });
  powerMonitor.on("resume", () => {
    void service.checkContextForUpdates();
    void checkForUpdates();
  });
  const state = await store.read();
  // A local verification build must not replace the installed app's login entry.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: state.autoStart, openAsHidden: true });

  handle("bridge:get-state", () => service.state());
  handle("bridge:diagnose-ui", async (_event, input: unknown) => {
    const shown = input as { onboardingComplete?: unknown; analysisStatus?: unknown } | null;
    service.diagnostics.record("renderer.snapshot", { onboarding: shown?.onboardingComplete === true, analysisStatus: ["ready", "analyzing", "error"].includes(String(shown?.analysisStatus)) ? String(shown?.analysisStatus) : "none" });
    service.diagnostics.snapshotProfile(app.getPath('userData'), 'renderer-snapshot');
    const actual = await service.state();
    service.diagnostics.record('renderer.backend-state', { onboarding: actual.onboardingComplete, analysisStatus: actual.contextAnalysis?.status, topics: actual.contextAnalysis?.topics.length, reports: actual.reports.length });
  });
  handle("bridge:open-diagnostics", async () => {
    service.diagnostics.record("diagnostics.open");
    const error = await shell.openPath(service.diagnostics.file);
    if (error) throw new Error("Не удалось открыть журнал диагностики");
  });
  handle("bridge:get-local-context-state", () => service.localContextState());
  handle("bridge:add-topic", (_event, topic: string) => service.addTopic(topic));
  handle("bridge:block-topic", (_event, topic: string) => service.blockTopic(topic));
  handle("bridge:run-conversation", async (_event, input: { topic: string; realCodex: boolean }) => {
    const report = await service.run(input.topic, input.realCodex);
    if (Notification.isSupported()) {
      new Notification({ title: "Разговор завершён", body: report.sharedSummary || "Итог готов" }).show();
    }
    return report;
  });
  handle("bridge:set-autostart", async (_event, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    await store.update({ autoStart: enabled });
    return service.state();
  });
  handle("bridge:set-display-name", (_event, name: unknown) => service.setDisplayName(name));
  handle("bridge:set-language", (_event, language: unknown) => service.setLanguage(language));
  handle("bridge:list-context-threads", () => service.listContextThreads());
  handle("bridge:select-context-thread", (_event, threadId: unknown) => service.selectContextThread(threadId));
  handle("bridge:sync-context", () => service.syncContext());
  handle("bridge:refresh-context-now", () => service.refreshContextNow());
  handle("bridge:update-portrait-observation", (_event, input: unknown) => service.updatePortraitObservation(input));
  handle("bridge:complete-onboarding", (_event, counterpartPersonId?: string) => service.completeOnboarding(counterpartPersonId));
  handle("bridge:open-reports", async () => {
    const internalReports = path.join(app.getPath("userData"), "reports");
    const exportedReports = path.join(app.getPath("documents"), "Family Bridge Reports");
    await mkdir(internalReports, { recursive: true });
    const stored = await store.read();
    const latestExport = await exportReportFiles(stored.reports, exportedReports);
    if (process.platform === "win32") {
      await revealInWindowsExplorer(latestExport ?? exportedReports);
      return;
    }
    const error = await shell.openPath(exportedReports);
    if (error) throw new Error(`Не удалось открыть папку с файлами: ${error}`);
  });
  handle("bridge:create-pair", (_event, counterpartPersonId: unknown) => service.createPair(counterpartPersonId));
  handle("bridge:join-pair", (_event, input: { invite?: unknown; counterpartPersonId?: unknown }) => service.joinPair(String(input?.invite ?? ""), input?.counterpartPersonId));
  handle("bridge:update-context-topic", (_event, input: unknown) => service.updateContextTopic(input));
  handle("bridge:refine-context-topic", (_event, input: unknown) => service.refineContextTopic(input));
  handle("bridge:update-context-topics", (_event, input: unknown) => service.updateContextTopics(input));
  handle("bridge:run-remote", (_event, topic: string) => service.runRemote(topic));
  handle("bridge:discuss-all-topics", () => service.discussAllTopics());
  handle("bridge:answer-owner-question", (_event, input: unknown) => service.answerOwnerQuestion(input));
  handle("bridge:continue-report", (_event, input: unknown) => service.continueReport(input));
  handle("bridge:retry-continuation", (_event, id: unknown) => service.retryContinuation(id));
  const trustedDictationSender = (event: IpcMainInvokeEvent) => event.sender === mainWindow?.webContents && event.senderFrame === mainWindow?.webContents.mainFrame;
  handle("bridge:request-microphone", async (event) => {
    if (!trustedDictationSender(event)) return false;
    try {
      return process.platform === "darwin" ? await systemPreferences.askForMediaAccess("microphone") : systemPreferences.getMediaAccessStatus("microphone") !== "denied";
    } catch { return false; }
  });
  handle("bridge:transcribe-audio", (event, input: unknown) => trustedDictationSender(event) ? dictation.transcribe(input) : { ok: false, code: "unavailable" });
  handle("bridge:cancel-dictation", (event, id: unknown) => { if (trustedDictationSender(event) && typeof id === "string") dictation.cancel(id); });
  handle("bridge:check-updates", async () => {
    await checkForUpdates();
  });
  handle("bridge:check-pair-versions", async () => {
    return service.requestPeerVersionCheck();
  });
  handle("bridge:install-update", () => {
    if (!app.isPackaged) throw new Error("Установка обновлений доступна в установленном приложении.");
    if (!currentUpdate.ready) throw new Error("Обновление ещё не скачано. Сначала проверьте обновления.");
    updateGate.requestNow();
    publishUpdate({ ...currentUpdate, installRequested: true, error: undefined });
    // Leave this IPC handler before testing activeIpc; otherwise the request
    // would block itself. This also bypasses the automatic retry cooldown.
    setTimeout(() => void updateGate.tick(), 0);
  });
  serviceReady = true;
  createWindow();
  createTray();
  if (app.isPackaged) {
    let lastUpdateDiagnostic = 0, lastUpdateSignature = "";
    const automaticUpdateTimer = setInterval(() => {
      void updateGate.tick();
      if (!currentUpdate.ready) return;
      const snapshot = service.updateDiagnostics(), gate = updateGate.snapshot();
      const blockers = [...snapshot.blockers, ...ipcActivity.snapshot()];
      const signature = JSON.stringify([gate.phase, rendererUpdateBlocked, rendererUpdateReason, blockers.map(b => [b.operation, b.count, b.startedAt])]);
      if (signature === lastUpdateSignature && Date.now() - lastUpdateDiagnostic < 30_000) return;
      lastUpdateSignature = signature; lastUpdateDiagnostic = Date.now();
      service.diagnostics.record("updater.gate", { stage: gate.phase, elapsedMs: gate.elapsedMs, current: blockers.length, ready: gate.pending });
      for (const blocker of blockers) service.diagnostics.record("updater.blocker", { operation: blocker.operation, current: blocker.count, startedAt: blocker.startedAt, elapsedMs: blocker.elapsedMs });
      for (const row of activeChannels.values()) service.diagnostics.record("updater.ipc", { channel: row.channel, startedAt: row.startedAt, elapsedMs: Math.max(0, Date.now() - row.startedAt) });
    }, 2_000);
    automaticUpdateTimer.unref();
    autoUpdater.logger = null;
    if (process.platform === "darwin") {
      macUpdater = new MacReleaseUpdater(app.getVersion(), process.execPath, app.getPath("userData"), process.arch, (update) => {
        publishUpdate(update);
        void presentReadyUpdate(update);
      });
    } else {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.disableDifferentialDownload = true;
      autoUpdater.disableWebInstaller = true;
      autoUpdater.on("update-available", (info) => {
        windowsUpdateVersion = info.version;
        windowsUpdateDownloading = true;
        windowsUpdateReady = false;
        publishUpdate({ available: true, version: info.version, downloading: true, progress: 0 });
      });
      autoUpdater.on("download-progress", (progress) => publishUpdate({ available: true, version: windowsUpdateVersion, downloading: true, progress: Math.round(progress.percent) }));
      autoUpdater.on("update-downloaded", (info) => {
        windowsUpdateDownloading = false;
        windowsUpdateReady = true;
        const update = { available: true, version: info.version, downloading: false, progress: 100, ready: true };
        publishUpdate(update);
        void presentReadyUpdate(update);
      });
      autoUpdater.on("update-not-available", () => {
        windowsUpdateVersion = undefined;
        windowsUpdateDownloading = false;
        windowsUpdateReady = false;
        publishUpdate({ available: false, downloading: false });
      });
      autoUpdater.on("error", (error) => {
        updateGate.cancel();
        preparingUpdate = false;
        updateInstallIsQuitting = false;
        isQuitting = false;
        service.cancelPreparedUpdate();
        windowsUpdateVersion = undefined;
        windowsUpdateDownloading = false;
        windowsUpdateReady = false;
        publishUpdate({ available: false, downloading: false, error: error.message });
      });
    }
    setTimeout(() => void checkForUpdates(), 10_000);
    const updateTimer = setInterval(() => void checkForUpdates(), 60_000);
    updateTimer.unref();
  }
}).catch(() => {
  service?.diagnostics.record("startup.failed");
  dialog.showErrorBox("Family Bridge", "Не удалось открыть сохранённые данные. Они не сброшены. Закройте приложение и повторите запуск. Журнал: diagnostics/lifecycle.jsonl в папке данных Family Bridge.");
  isQuitting = true;
  app.quit();
});

app.on("activate", showMainWindow);

app.on("before-quit", (event) => {
  dictation.cancel();
  isQuitting = true;
  if (process.platform !== "darwin" || !macUpdater?.hasPreparedUpdate || updateInstallIsQuitting) return;
  event.preventDefault();
  updateInstallIsQuitting = true;
  void macUpdater.launchInstaller().then((launched) => {
    if (launched) app.quit();
  }).catch((error) => {
    updateInstallIsQuitting = false;
    isQuitting = false;
    publishUpdate({ ...currentUpdate, available: true, downloading: false, ready: true, installing: false, error: error instanceof Error ? error.message : String(error) });
    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
});
