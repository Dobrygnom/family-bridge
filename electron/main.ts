import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, powerMonitor, shell, systemPreferences, Tray, type MessageBoxOptions, type IpcMainInvokeEvent } from "electron";
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
let promptedUpdateVersion: string | undefined;
let windowsUpdateVersion: string | undefined;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) app.quit();
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
  contents.on("render-process-gone", (_event, details) => service.diagnostics.record("renderer.gone", { code: details.reason }));
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
  if (process.platform === "darwin" && macUpdater) {
    try {
      updateInstallIsQuitting = true;
      const launched = await macUpdater.launchInstaller();
      if (!launched) return;
      isQuitting = true;
      app.quit();
    } catch (error) {
      updateInstallIsQuitting = false;
      isQuitting = false;
      const message = error instanceof Error ? error.message : String(error);
      service.setUpdateState({ available: true, downloading: false, ready: true, error: message });
      showMainWindow();
      const options: MessageBoxOptions = {
        type: "error",
        title: "Не удалось установить обновление",
        message,
        detail: "Можно скачать тот же проверенный архив вручную.",
        buttons: ["Скачать вручную", "Позже"],
        defaultId: 0,
        cancelId: 1,
      };
      const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
      if (result.response === 0 && macUpdater.downloadUrl) await shell.openExternal(macUpdater.downloadUrl);
    }
    return;
  }
  autoUpdater.quitAndInstall(true, true);
}

async function presentReadyUpdate(state: UpdateState) {
  if (!state.ready || !state.version || promptedUpdateVersion === state.version) return;
  promptedUpdateVersion = state.version;
  const options: MessageBoxOptions = {
    type: "info",
    title: "Обновление готово",
    message: `Версия ${state.version} готова к установке`,
    detail: "Перезапустить приложение сейчас? Если выбрать «Позже», обновление установится при обычном выходе.",
    buttons: ["Перезапустить", "Позже"],
    defaultId: 0,
    cancelId: 1,
  };
  const result = mainWindow ? await dialog.showMessageBox(mainWindow, options) : await dialog.showMessageBox(options);
  if (result.response === 0) await installPreparedUpdate();
}

async function checkForUpdates() {
  if (!app.isPackaged) return;
  if (process.platform === "darwin" && macUpdater) {
    await macUpdater.checkForUpdates();
    return;
  }
  service.setUpdateState({ available: false, checking: true, downloading: false });
  try {
    await autoUpdater.checkForUpdatesAndNotify();
  } catch (error) {
    service.setUpdateState({ available: false, downloading: false, error: error instanceof Error ? error.message : String(error) });
  }
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
      conversationResetVersion: "0.3.25",
      experienceResetVersion: "natural-dialogues-v1",
      reportsExportDirectory: path.join(app.getPath("documents"), "Family Bridge Reports"),
      requestUpdateCheck: () => setTimeout(() => void checkForUpdates(), 0),
    },
  );
  await service.start();
  powerMonitor.on("resume", () => {
    void service.checkContextForUpdates();
    void checkForUpdates();
  });
  const state = await store.read();
  app.setLoginItemSettings({ openAtLogin: state.autoStart, openAsHidden: true });

  ipcMain.handle("bridge:get-state", () => service.state());
  ipcMain.handle("bridge:diagnose-ui", async (_event, input: unknown) => {
    const shown = input as { onboardingComplete?: unknown; analysisStatus?: unknown } | null;
    service.diagnostics.record("renderer.snapshot", { onboarding: shown?.onboardingComplete === true, analysisStatus: ["ready", "analyzing", "error"].includes(String(shown?.analysisStatus)) ? String(shown?.analysisStatus) : "none" });
  });
  ipcMain.handle("bridge:open-diagnostics", async () => {
    service.diagnostics.record("diagnostics.open");
    const error = await shell.openPath(service.diagnostics.file);
    if (error) throw new Error("Не удалось открыть журнал диагностики");
  });
  ipcMain.handle("bridge:get-local-context-state", () => service.localContextState());
  ipcMain.handle("bridge:add-topic", (_event, topic: string) => service.addTopic(topic));
  ipcMain.handle("bridge:block-topic", (_event, topic: string) => service.blockTopic(topic));
  ipcMain.handle("bridge:run-conversation", async (_event, input: { topic: string; realCodex: boolean }) => {
    const report = await service.run(input.topic, input.realCodex);
    if (Notification.isSupported()) {
      new Notification({ title: "Разговор завершён", body: report.sharedSummary || "Итог готов" }).show();
    }
    return report;
  });
  ipcMain.handle("bridge:set-autostart", async (_event, enabled: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    await store.update({ autoStart: enabled });
    return service.state();
  });
  ipcMain.handle("bridge:set-display-name", (_event, name: unknown) => service.setDisplayName(name));
  ipcMain.handle("bridge:set-language", (_event, language: unknown) => service.setLanguage(language));
  ipcMain.handle("bridge:list-context-threads", () => service.listContextThreads());
  ipcMain.handle("bridge:select-context-thread", (_event, threadId: unknown) => service.selectContextThread(threadId));
  ipcMain.handle("bridge:sync-context", () => service.syncContext());
  ipcMain.handle("bridge:refresh-context-now", () => service.refreshContextNow());
  ipcMain.handle("bridge:complete-onboarding", (_event, counterpartPersonId?: string) => service.completeOnboarding(counterpartPersonId));
  ipcMain.handle("bridge:open-reports", async () => {
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
  ipcMain.handle("bridge:create-pair", (_event, counterpartPersonId: unknown) => service.createPair(counterpartPersonId));
  ipcMain.handle("bridge:join-pair", (_event, input: { invite?: unknown; counterpartPersonId?: unknown }) => service.joinPair(String(input?.invite ?? ""), input?.counterpartPersonId));
  ipcMain.handle("bridge:update-context-topic", (_event, input: unknown) => service.updateContextTopic(input));
  ipcMain.handle("bridge:update-context-topics", (_event, input: unknown) => service.updateContextTopics(input));
  ipcMain.handle("bridge:run-remote", (_event, topic: string) => service.runRemote(topic));
  ipcMain.handle("bridge:discuss-all-topics", () => service.discussAllTopics());
  ipcMain.handle("bridge:answer-owner-question", (_event, input: unknown) => service.answerOwnerQuestion(input));
  ipcMain.handle("bridge:continue-report", (_event, input: unknown) => service.continueReport(input));
  ipcMain.handle("bridge:retry-continuation", (_event, id: unknown) => service.retryContinuation(id));
  const trustedDictationSender = (event: IpcMainInvokeEvent) => event.sender === mainWindow?.webContents && event.senderFrame === mainWindow?.webContents.mainFrame;
  ipcMain.handle("bridge:request-microphone", async (event) => {
    if (!trustedDictationSender(event)) return false;
    try {
      return process.platform === "darwin" ? await systemPreferences.askForMediaAccess("microphone") : systemPreferences.getMediaAccessStatus("microphone") !== "denied";
    } catch { return false; }
  });
  ipcMain.handle("bridge:transcribe-audio", (event, input: unknown) => trustedDictationSender(event) ? dictation.transcribe(input) : { ok: false, code: "unavailable" });
  ipcMain.handle("bridge:cancel-dictation", (event, id: unknown) => { if (trustedDictationSender(event) && typeof id === "string") dictation.cancel(id); });
  ipcMain.handle("bridge:check-updates", async () => {
    await checkForUpdates();
  });
  ipcMain.handle("bridge:check-pair-versions", async () => {
    return service.requestPeerVersionCheck();
  });
  ipcMain.handle("bridge:install-update", () => installPreparedUpdate());
  serviceReady = true;
  createWindow();
  createTray();
  if (app.isPackaged) {
    autoUpdater.logger = null;
    if (process.platform === "darwin") {
      macUpdater = new MacReleaseUpdater(app.getVersion(), process.execPath, app.getPath("userData"), process.arch, (update) => {
        service.setUpdateState(update);
        void presentReadyUpdate(update);
      });
    } else {
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.disableDifferentialDownload = true;
      autoUpdater.disableWebInstaller = true;
      autoUpdater.on("update-available", (info) => {
        windowsUpdateVersion = info.version;
        service.setUpdateState({ available: true, version: info.version, downloading: true, progress: 0 });
      });
      autoUpdater.on("download-progress", (progress) => service.setUpdateState({ available: true, version: windowsUpdateVersion, downloading: true, progress: Math.round(progress.percent) }));
      autoUpdater.on("update-downloaded", (info) => {
        const update = { available: true, version: info.version, downloading: false, progress: 100, ready: true };
        service.setUpdateState(update);
        void presentReadyUpdate(update);
      });
      autoUpdater.on("update-not-available", () => service.setUpdateState({ available: false, downloading: false }));
      autoUpdater.on("error", (error) => service.setUpdateState({ available: false, downloading: false, error: error.message }));
    }
    setTimeout(() => void checkForUpdates(), 10_000);
    const updateTimer = setInterval(() => void checkForUpdates(), 24 * 60 * 60 * 1_000);
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
    service.setUpdateState({ available: true, downloading: false, ready: true, error: error instanceof Error ? error.message : String(error) });
    showMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
});
