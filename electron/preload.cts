import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("familyBridge", {
  getState: () => ipcRenderer.invoke("bridge:get-state"),
  diagnoseUi: (input: { onboardingComplete: boolean; analysisStatus?: string }) => ipcRenderer.invoke("bridge:diagnose-ui", input),
  openDiagnostics: () => ipcRenderer.invoke("bridge:open-diagnostics"),
  getLocalContextState: () => ipcRenderer.invoke("bridge:get-local-context-state"),
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
  refreshContextNow: () => ipcRenderer.invoke("bridge:refresh-context-now"),
  completeOnboarding: (counterpartPersonId?: string) => ipcRenderer.invoke("bridge:complete-onboarding", counterpartPersonId),
  openReports: () => ipcRenderer.invoke("bridge:open-reports"),
  createPair: (counterpartPersonId: string) => ipcRenderer.invoke("bridge:create-pair", counterpartPersonId),
  joinPair: (invite: string, counterpartPersonId: string) => ipcRenderer.invoke("bridge:join-pair", { invite, counterpartPersonId }),
  updateContextTopic: (input: { topicId: string; aboutPersonIds?: string[]; discussWithPersonId?: string; approved?: boolean }) => ipcRenderer.invoke("bridge:update-context-topic", input),
  updateContextTopics: (input: { topicIds: string[]; approved: boolean }) => ipcRenderer.invoke("bridge:update-context-topics", input),
  runRemote: (topic: string) => ipcRenderer.invoke("bridge:run-remote", topic),
  discussAllTopics: () => ipcRenderer.invoke("bridge:discuss-all-topics"),
  continueReport: (input: { reportId: string; requestId: string; prompt: string }) => ipcRenderer.invoke("bridge:continue-report", input),
  retryContinuation: (id: string) => ipcRenderer.invoke("bridge:retry-continuation", id),
  answerOwnerQuestion: (input: { id: string; disposition: "answer" | "unknown" | "decline"; answer?: string }) => ipcRenderer.invoke("bridge:answer-owner-question", input),
  requestMicrophone: () => ipcRenderer.invoke("bridge:request-microphone"),
  transcribeAudio: (input: { id: string; audio: Uint8Array }) => ipcRenderer.invoke("bridge:transcribe-audio", input),
  cancelDictation: (id: string) => ipcRenderer.invoke("bridge:cancel-dictation", id),
  checkForUpdates: () => ipcRenderer.invoke("bridge:check-updates"),
  checkPairVersions: () => ipcRenderer.invoke("bridge:check-pair-versions"),
  installUpdate: () => ipcRenderer.invoke("bridge:install-update"),
  onEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
    ipcRenderer.on("bridge:event", handler);
    return () => ipcRenderer.removeListener("bridge:event", handler);
  },
});
