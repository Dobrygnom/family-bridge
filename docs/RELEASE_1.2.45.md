# 1.2.45 — updater recovery cannot be pinned by a broken renderer

- macOS continues checking the latest published release after an older update was already prepared and replaces the stale staged bundle when a newer release exists.
- A preload failure or renderer crash releases the renderer update gate; a verified prepared update may install once the existing background safety barriers are quiet.
- Conversation maintenance from 1.2.44 remains unchanged.

This closes both conditions that stranded 1.2.42: a failed preload could hold the update gate forever, and its already prepared 1.2.43 prevented discovery of later releases.
