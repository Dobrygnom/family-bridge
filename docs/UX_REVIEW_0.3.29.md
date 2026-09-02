# UX review — 0.3.29

Scope: source-code review of existing user flows. No claim of a live macOS or visual UI test.

## Implemented in this update

- Dictation in owner answers and new topics: explicit start, microphone level, elapsed time, stop/transcribe, cancellation, actionable failures, retry of the same in-memory recording. The result is an editable draft; it is never submitted automatically.
- Show the OpenAI audio-transfer notice before recording. Credentials stay in Electron's main process. No persistent audio files.
- Stop recording when the app is hidden/minimized or the field is unmounted. Warn before navigating away from active dictation.
- Save owner-answer drafts locally through restarts; delete a draft only after a successful answer submission. Preserve drafts when an operation fails.
- New owner questions no longer steal navigation. A badge and an explicit cross-screen link replace the forced page switch.
- A completed-topic link scrolls to and highlights its exact report, not just the top of the results page.
- Show the Family Bridge version in the sidebar separately from the Codex version.

## Next UX priorities (not changed here)

1. **Compact question inbox.** Currently every pending owner question occupies a full card. Use a compact list with one expanded answer editor, topic/person grouping, and a visible remaining count. Keep any active recording and drafts stable when new questions arrive.
2. **Truthful, per-topic activity.** The main hero currently conflates local request activity, waiting for a remote agent, and having no pending work. Derive the headline from persisted topic states and unanswered questions, with a clear next action. Do not present a paired device as currently online solely because pairing exists.
3. **Findable results.** Add search and filters for “proposed by me / partner / both” and unread results. Keep the exact-report navigation added here.
4. **Honest update status.** “Latest version installed” must require a completed update check with a visible check time; the current idle default does not prove that.
5. **Recoverable controls.** Let users pause/resume individual discussions and remove mistaken blocked phrases with confirmation. These need explicit persisted state and transport semantics, not just new buttons.

Avoid another full navigation redesign in the same release as dictation. Validate these changes with the two actual users before changing conversation policy or privacy defaults.
