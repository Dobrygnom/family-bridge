# Encrypted compute channel

Family Bridge 2 can use a trusted helper computer for model work without an API key and without transferring ChatGPT credentials.

## Trust and isolation

- The helper explicitly enables hosting and creates a separate, one-time invitation for each client.
- Each invitation creates an independent two-member Supabase pair, anonymous identity, and client-side encryption secret. It is not the dialogue pair and does not grant diagnostic access to any other pair.
- The public desktop contains only the Supabase publishable key. It contains no service-role key, master key, helper identity, or reusable invitation.
- The helper can see the plaintext text tasks it chooses to process. The UI states this before setup.
- A task can select only a fixed operation and one of the bundled JSON schemas. It cannot submit command-line arguments, file paths, model names, tools, URLs, or shell commands.
- The helper constructs the Codex invocation locally. It always uses GPT-5.6 Luna with medium reasoning, the bundled schema, an empty per-job workspace, read-only sandboxing, and the existing text-worker isolation that disables tools, files, browser, MCP, plugins, hooks, memories, and project instructions.

## Delivery and recovery

Client jobs are written atomically to local disk before transport. Supabase receives only an encrypted payload. A deterministic local job key and transport idempotency key prevent a lost response from charging twice. The helper writes the completed result to disk before sending and acknowledges the request only after the response is durable and sent.

Realtime notifications wake normal work. A metadata-only one-minute poll recovers after sleep, offline periods, or a dropped subscription. This avoids continuously downloading message history. If the helper is offline or a usage limit is reached, the claimed or queued task remains durable and is retried later.

The switch has three explicit states:

- `off` — no compute transport is active;
- `host` — this computer accepts jobs only from enabled per-client channels;
- `client` — this computer submits text jobs through one configured helper.

Revoking a host channel prevents further processing for that client. Turning the client mode off closes its transport but keeps already saved local jobs, so re-enabling the same invitation can recover them.

## Supported remote work

The channel covers dialogue turns, new-topic drafting, topic refinement, and portrait updates. Initial analysis of an existing private ChatGPT/Codex history remains local; users without such a history use the manual-profile onboarding path.
