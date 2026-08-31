import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import electronUpdater from "electron-updater";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BackgroundService } from "./background-service.js";
import { AtomicStore } from "./store.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let service: BackgroundService;
let isQuitting = false;

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
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) void mainWindow.loadURL(devUrl);
  else void mainWindow.loadFile(path.join(dirname, "..", "..", "dist", "index.html"));
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect rx="9" width="32" height="32" fill="#80d6b7"/><path d="M9 10h14v3H9zm0 6h10v3H9zm0 6h7v3H9z" fill="#10222a"/></svg>`;
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip("Family Bridge работает в фоне");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Открыть Family Bridge", click: () => mainWindow?.show() },
      { type: "separator" },
      { label: "Завершить", click: () => { isQuitting = true; app.quit(); } },
    ]),
  );
  tray.on("double-click", () => mainWindow?.show());
}

app.whenReady().then(async () => {
  const store = new AtomicStore(app.getPath("userData"));
  service = new BackgroundService(
    app.getPath("userData"),
    app.isPackaged ? process.resourcesPath : path.resolve(dirname, ".."),
    store,
    () => mainWindow,
  );
  createWindow();
  createTray();
  await service.start();
  const state = await store.read();
  app.setLoginItemSettings({ openAtLogin: state.autoStart, openAsHidden: true });

  ipcMain.handle("bridge:get-state", () => service.state());
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
  ipcMain.handle("bridge:complete-onboarding", () => service.completeOnboarding());
  ipcMain.handle("bridge:open-reports", async () => {
    const reports = path.join(app.getPath("userData"), "reports");
    await mkdir(reports, { recursive: true });
    await shell.openPath(reports);
  });
  ipcMain.handle("bridge:create-pair", (_event, counterpartPersonId: unknown) => service.createPair(counterpartPersonId));
  ipcMain.handle("bridge:join-pair", (_event, input: { invite?: unknown; counterpartPersonId?: unknown }) => service.joinPair(String(input?.invite ?? ""), input?.counterpartPersonId));
  ipcMain.handle("bridge:update-context-topic", (_event, input: unknown) => service.updateContextTopic(input));
  ipcMain.handle("bridge:update-context-topics", (_event, input: unknown) => service.updateContextTopics(input));
  ipcMain.handle("bridge:run-remote", (_event, topic: string) => service.runRemote(topic));
  ipcMain.handle("bridge:discuss-all-topics", () => service.discussAllTopics());
  ipcMain.handle("bridge:check-updates", async () => {
    if (!app.isPackaged) return;
    await autoUpdater.checkForUpdatesAndNotify();
  });
  if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-available", (info) => mainWindow?.webContents.send("bridge:event", { type: "update", available: true, version: info.version, downloading: true }));
    autoUpdater.on("update-downloaded", (info) => mainWindow?.webContents.send("bridge:event", { type: "update", available: true, version: info.version, downloading: false }));
    setTimeout(() => void autoUpdater.checkForUpdatesAndNotify(), 10_000);
  }
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") return;
});
