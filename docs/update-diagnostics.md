# Update preparation and diagnosis

The inbox timer and updater both run every two seconds. Previously, preparation returned false while the inbox was busy, but allowed the next poll to start immediately. The same timer ordering could postpone installation indefinitely. Preparation now claims a persistent pause before checking existing operations. New polls, automatic launches and inbox workers cannot start while paused. Existing work and queued writes drain before installation. Editing/dictation or an installation failure releases the pause. Cancellation while the save barrier is pending invalidates that installation attempt.

`node --import tsx scripts/family-bridge-support.ts diagnostics` reads the running local process without waiting for the application state store. It reports the boot/version, gate phase, actual operation start times, oldest remaining operation age, counts, IPC channel names and renderer activity. `status` includes the same structured diagnostics in local and compatible peer support reports. `snapshot` requests a fresh peer report. Older peers omit these new fields.

`local-update` requests the existing safe installation gate for an already downloaded local update; `update` still targets the peer. Neither command exits the application directly or skips persistence/activity checks. The local HTTP routes remain loopback-only, token-protected, reject browser Origins and accept only fixed commands.

`updater.gate`, `updater.blocker` and `updater.ipc` are recorded on changes and at least every thirty seconds while waiting. Blocker names and IPC channels use explicit allowlists for remote reports; arguments, conversation contents, credentials and local paths are excluded. Technical analysis failures include their error category and exit code.

Regression coverage reproduces a busy inbox when an update becomes ready, with the inbox timer running before the next updater tick. The old preparation implementation fails this test. Coverage also checks late inbox reads, preserved pending deliveries, cancellation during saving, editing after quiescence, diagnostics while paused, and diagnostics independent of a blocked normal status call.
