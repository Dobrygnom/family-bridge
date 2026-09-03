# 0.3.30 — saved startup state and conversation follow-ups

- The saved profile is read locally without waiting for Codex health or a remote pair check. IPC handlers are registered before the renderer opens.
- Loading is a separate state. A failed or timed-out load has an explicit retry and is never presented as a fresh installation.
- Interrupted analysis without results becomes an actionable error; existing prepared people and topics remain available. Parallel checkpoint writes are serialized. Selecting the same chat does not reset onboarding.
- Corrupt/unreadable state is not replaced with fresh-install defaults.
- Lifecycle diagnostics record boot, renderer and analysis metadata only, never chat text, owner instructions, credentials or names. Find the log under `diagnostics/lifecycle.jsonl` in app data, or use the diagnostics button in settings.
- Each completed result has “Continue this conversation”: an editable, persistent prompt with dictation. The agent reads the previous shared dialogue and prepares a new message; the other agent also receives the prior shared dialogue. The original report remains intact.
- Continuations show preparation, waiting, failure/retry and completion states. A restart during preparation retains the instruction for an explicit retry. A failed send reuses the prepared message; duplicate transport requests are idempotent.
- Both devices need 0.3.30+ for conversation-history continuation. This is not an anonymous/private chat feature: the agent's new reply is sent to the partner.

Validation: unit/integration tests for preserved state, unavailable backend, checkpoint writes, corruption, continuation history, original report preservation, retries and version gating. A separate opt-in `scripts/verify-continuation-live.ts` exercises two real Codex agents using synthetic context. No personal conversation is regenerated or cleared during validation.

An earlier user screenshot and saved on-disk state did not match. The exact historical cause was not proven; lifecycle logs are included to make a recurrence diagnosable. Real macOS UI/microphone and a live two-device session require device-side verification; Windows automated tests do not establish those results.
