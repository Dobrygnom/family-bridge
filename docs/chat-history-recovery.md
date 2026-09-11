# Chat history read recovery

Observed in Codex Desktop: the application tools pipe supports `tools/list`, while browser pipes with the same prefix return `No handler registered for method: tools/list`. The previous client continued discovery after an actual reading failure, overwriting that cause with the last browser error. Native `read_thread` requests returned both `Too many concurrent requests` and `reached concurrency limit` during this investigation.

The client now checks capabilities, then keeps reading errors attached to the selected app endpoint. Overload/timeout retries use delays of 2, 5 and 10 seconds, at most four attempts for each page. Requests use UUIDs (the installed app's pending-call registry is keyed by request ID), and timed-out requests receive `tools/cancel` with the same ID. Discovery and reading only call `list_threads`, `list_projects` and `read_thread`; no browser or login operation is invoked.

Explicit refresh skips full task enumeration. A complete native read of the selected source returned 578 user messages in 53 seconds after two automatic overload retries. Malformed pagination, repeated cursors and an empty result for a previously nonempty source cannot silently overwrite the saved history.

`node --import tsx scripts/family-bridge-support.ts refresh-context` starts the same refresh path as the application button for the already selected source. It accepts no chat ID, file path, prompt or command. Progress appears in the normal UI and support diagnostics (`context.read-progress`, `context.read-ready`, `context.read-failed`). HTTP access has the existing loopback/token/Origin restrictions.
