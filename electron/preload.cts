import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("familyBridge", {
  getState: () => ipcRenderer.invoke("bridge:get-state"),
  runConversation: (topic: string, realCodex: boolean) =>
    ipcRenderer.invoke("bridge:run-conversation", { topic, realCodex }),
  addTopic: (topic: string) => ipcRenderer.invoke("bridge:add-topic", topic),
  blockTopic: (topic: string) => ipcRenderer.invoke("bridge:block-topic", topic),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke("bridge:set-autostart", enabled),
  setDisplayName: (name: string) => ipcRenderer.invoke("bridge:set-display-name", name),
  setLanguage: (language: "ru" | "en" | "cs" | "fr") => ipcRenderer.invoke("bridge:set-language", language),
  listContextThreads: () => ipcRenderer.invoke("bridge:list-context-threads"),
  selectContextThread: (threadId: string) => ipcRenderer.invoke("bridge:select-context-thread", threadId),
  syncContext: () => ipcRenderer.invoke("bridge:sync-context"),
  completeOnboarding: () => ipcRenderer.invoke("bridge:complete-onboarding"),
  openReports: () => ipcRenderer.invoke("bridge:open-reports"),
  createPair: (counterpartPersonId: string) => ipcRenderer.invoke("bridge:create-pair", counterpartPersonId),
  joinPair: (invite: string, counterpartPersonId: string) => ipcRenderer.invoke("bridge:join-pair", { invite, counterpartPersonId }),
  updateContextTopic: (input: { topicId: string; aboutPersonIds?: string[]; discussWithPersonId?: string; approved?: boolean }) => ipcRenderer.invoke("bridge:update-context-topic", input),
  updateContextTopics: (input: { topicIds: string[]; approved: boolean }) => ipcRenderer.invoke("bridge:update-context-topics", input),
  runRemote: (topic: string) => ipcRenderer.invoke("bridge:run-remote", topic),
  discussAllTopics: () => ipcRenderer.invoke("bridge:discuss-all-topics"),
  checkForUpdates: () => ipcRenderer.invoke("bridge:check-updates"),
  onEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
    ipcRenderer.on("bridge:event", handler);
    return () => ipcRenderer.removeListener("bridge:event", handler);
  },
});
