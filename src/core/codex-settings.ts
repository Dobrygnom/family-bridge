export const DEFAULT_CODEX_MODEL = "auto";
export const DEFAULT_CODEX_REASONING_EFFORT = "medium";
export const CODEX_MODELS = ["auto", "gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"] as const;
export const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CodexModel = typeof CODEX_MODELS[number];
export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];

export function supportsCodexConfig(model: CodexModel, effort: CodexReasoningEffort) {
  if (model === "gpt-5.5") return ["low", "medium", "high", "xhigh"].includes(effort);
  if (model === "gpt-5.6-luna") return effort !== "ultra";
  return true;
}

export const codexModelArgument = (model: CodexModel | undefined) => !model || model === "auto" ? null : model;
