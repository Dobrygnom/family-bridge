import { CodexHistoryClient } from "./codex-history.js";

const ASTRA = "gpt-6-astra";

// Apply at invocation, not in cache identity: changing runtime effort must not
// discard completed extraction notes or force a full source-chat reanalysis.
export const CODEX_REASONING_ARGS = ["-c", 'model_reasoning_effort="medium"'];

/** One catalog request for concurrent jobs; failures keep the client's own default. */
export function createModelResolver(
  listModels: (command: string) => Promise<Array<{ model: string; hidden?: boolean }>>,
  now = Date.now,
) {
  const cache = new Map<string, { expires: number; pending: Promise<string | undefined> }>();
  return (command: string): Promise<string | undefined> => {
    const current = cache.get(command);
    if (current && current.expires > now()) return current.pending;
    const entry = { expires: Number.POSITIVE_INFINITY, pending: Promise.resolve(undefined) as Promise<string | undefined> };
    entry.pending = Promise.resolve().then(() => listModels(command)).then((models) => {
      entry.expires = now() + 5 * 60_000;
      return models.some((model) => model.model === ASTRA && !model.hidden) ? ASTRA : undefined;
    }, () => {
      entry.expires = now() + 30_000;
      return undefined;
    });
    cache.set(command, entry);
    return entry.pending;
  };
}

export const preferredCodexModel = createModelResolver((command) => new CodexHistoryClient(command).listModels());

export async function preferredModelArgs(command: string) {
  const model = await preferredCodexModel(command);
  return model ? ["--model", model] : [];
}
