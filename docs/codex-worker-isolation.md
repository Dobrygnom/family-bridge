# Text worker isolation

All four text-generation subprocess paths use `isolatedCodexInvocation` at the
spawn boundary, including resumed dialogues. They retain `CODEX_HOME` for the
existing login, but `exec --ignore-user-config` prevents the application from
inheriting the user's coding-assistant configuration. Plugins, MCP servers,
connectors, hooks, browser/computer control, shell execution, memory/skill
discovery and the Code Mode executor are disabled. Project instructions have
a zero-byte budget. App-specific developer instructions classify quoted source
messages as data and prohibit actions outside text processing.

The filesystem sandbox alone was insufficient: browser and connector tools do
not run inside the sandboxed shell. The affected 1.2.21 source-chat worker loaded
the user's unified-computer-use plugin during context analysis.

Configuration reference: https://learn.chatgpt.com/docs/config-file/config-reference
The installed Codex CLI 0.153.4 documents `--ignore-user-config` in `exec --help`.
Unsupported clients fail closed and show an upgrade message. They must never
retry with the isolation options removed.

Run `node --import tsx scripts/verify-codex-isolation.ts` to verify the actual
client against synthetic quoted browser/login instructions and an adversarial
temporary AGENTS.md. The probe requires an existing Codex login; it never copies
credentials or reads a personal chat. It checks the structured result and rejects
tool-call events. Fixed CLI warnings about the intentionally disabled executor
are permitted; no such warning is displayed to application users.

History export and model-catalog RPCs remain separate from generation workers.
They do not start model turns. Normal transport and official application updates
continue to use the app's own code.
