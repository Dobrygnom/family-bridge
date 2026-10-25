# 2.1.5 — deterministic manual replies

- Adds a persistent conversation reply setting: automatic assistant replies or owner-only manual replies.
- In manual mode every incoming message is written to the durable conversation transcript before the owner is prompted.
- The assistant is never invoked for a manual reply. The exact owner-entered text is sent verbatim and survives an interrupted delivery for idempotent retry.
- Manual follow-ups to completed conversations also bypass the assistant and send the visible draft verbatim.
- Incoming messages marked complete by the other side still wait for the owner instead of silently ending or generating an automatic answer.
- Diagnostics now expose the active reply mode and pending manual replies.
- The authenticated loopback support endpoint can switch reply mode and submit an exact manual continuation without exposing either operation to browsers or remote users.
