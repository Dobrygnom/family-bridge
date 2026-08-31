import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("familyBridge", {
  getState: () => ipcRenderer.invoke("bridge:get-state"),
  runConversation: (topic: string, realCodex: boolean) =>
    ipcRenderer.invoke("bridge:run-conversation", { topic, realCodex }),
  addTopic: (topic: string) => ipcRenderer.invoke("bridge:add-topic", topic),
  blockTopic: (topic: string) => ipcRenderer.invoke("bridge:block-topic", topic),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke("bridge:set-autostart", enabled),
  setOwner: (owner: "dima" | "katya") => ipcRenderer.invoke("bridge:set-owner", owner),
  setLanguage: (language: "ru" | "en" | "cs" | "fr") => ipcRenderer.invoke("bridge:set-language", language),
  openReports: () => ipcRenderer.invoke("bridge:open-reports"),
  createPair: () => ipcRenderer.invoke("bridge:create-pair"),
  joinPair: (invite: string) => ipcRenderer.invoke("bridge:join-pair", invite),
  runRemote: (topic: string) => ipcRenderer.invoke("bridge:run-remote", topic),
  checkForUpdates: () => ipcRenderer.invoke("bridge:check-updates"),
  onEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
    ipcRenderer.on("bridge:event", handler);
    return () => ipcRenderer.removeListener("bridge:event", handler);
  },
});
