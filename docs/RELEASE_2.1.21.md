# 2.1.21 — self-healing conversation report index

- Identifies completed conversations by their stable conversation ID instead of by the filename of a restored copy.
- Repairs duplicate report references automatically during startup before the interface can observe them.
- Keeps every underlying report file on disk as recovery evidence; only the active index is deduplicated.
- Prevents peer reconciliation and future report writes from reintroducing duplicate conversation references.
- Adds a deep-diagnostics invariant that names duplicate conversation IDs without exposing report paths or message text.
- Rejects malformed report-index entries at the storage boundary and falls back to the previous durable state generation.
- Adds regression coverage for duplicate diagnostics, index repair semantics and preservation of archived files.
