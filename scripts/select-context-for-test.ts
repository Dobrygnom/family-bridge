import assert from "node:assert/strict";

const port = process.env.FAMILY_BRIDGE_CDP_PORT ?? "9223";
const expectedProject = process.env.FAMILY_BRIDGE_EXPECT_PROJECT;
const expectedChat = process.env.FAMILY_BRIDGE_EXPECT_CHAT;
assert.ok(expectedProject && expectedChat, "Set FAMILY_BRIDGE_EXPECT_PROJECT and FAMILY_BRIDGE_EXPECT_CHAT");

const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
const endpoint = pages.find((page) => page.type === "page")?.webSocketDebuggerUrl;
assert.ok(endpoint, "Family Bridge renderer was not exposed through CDP");
const socket = new WebSocket(endpoint);
await new Promise<void>((resolve, reject) => {
  socket.addEventListener("open", () => resolve(), { once: true });
  socket.addEventListener("error", () => reject(new Error("Could not connect to Family Bridge")), { once: true });
});

let nextId = 1;
async function evaluate<T>(expression: string): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const listener = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } }; error?: { message?: string } };
      if (message.id !== id) return;
      socket.removeEventListener("message", listener);
      if (message.error || message.result?.exceptionDetails) reject(new Error(message.error?.message ?? message.result?.exceptionDetails?.exception?.description ?? "Renderer evaluation failed"));
      else resolve(message.result?.result?.value as T);
    };
    socket.addEventListener("message", listener);
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

const result = await evaluate<{ project: string; chat: string; contextStatus?: string; messages?: number; analysisStatus?: string; people: number; topics: number; approved: number; grouped: number[] }>(`(async () => {
  const threads = await window.familyBridge.listContextThreads();
  const matches = threads.filter((thread) => thread.project.toLocaleLowerCase() === ${JSON.stringify(expectedProject.toLocaleLowerCase())} && thread.title.toLocaleLowerCase() === ${JSON.stringify(expectedChat.toLocaleLowerCase())});
  if (matches.length !== 1) throw new Error('Expected exactly one matching context chat; found ' + matches.length);
  const state = await window.familyBridge.selectContextThread(matches[0].id);
  return {
    project: state.context?.project ?? '', chat: state.context?.title ?? '', contextStatus: state.context?.status,
    messages: state.context?.messageCount, analysisStatus: state.contextAnalysis?.status,
    people: state.contextAnalysis?.people.length ?? 0, topics: state.contextAnalysis?.topics.length ?? 0,
    approved: state.contextAnalysis?.topics.filter((topic) => topic.approved).length ?? 0,
    grouped: (state.contextAnalysis?.people ?? []).map((person) => state.contextAnalysis?.topics.filter((topic) => topic.discussWithPersonId === person.id).length ?? 0)
  };
})()`);
assert.equal(result.project.toLocaleLowerCase(), expectedProject.toLocaleLowerCase());
assert.equal(result.chat.toLocaleLowerCase(), expectedChat.toLocaleLowerCase());
assert.equal(result.contextStatus, "ready");
assert.equal(result.analysisStatus, "ready");
assert.ok((result.messages ?? 0) > 0, "The selected chat had no user messages");
assert.ok(result.people > 0, "No people were identified");
assert.ok(result.topics > 0, "No topics were identified");
assert.equal(result.approved, 0, "A newly analyzed context approved topics automatically");
assert.equal(result.grouped.reduce((sum, count) => sum + count, 0), result.topics);
console.log(JSON.stringify(result));
socket.close();
