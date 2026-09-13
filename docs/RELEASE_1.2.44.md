# 1.2.44 — bounded remote conversation maintenance

- Adds authenticated local and peer maintenance endpoints outside the UI.
- Deletes one exact conversation on request and records a tombstone so delayed packets cannot restore it.
- Restarts a completed conversation from a zero-based message index as a new branch while retaining the original audit history.
- Persists request receipts and operation IDs for idempotent retries.
- Records metadata-only outcomes in `diagnostics/maintenance.jsonl`.
- Rejects unknown operations, malformed IDs, out-of-range indexes, browser origins, stale requests, wrong peers and clients older than 1.2.44.

Validation: production build succeeds; the complete 280-test suite passes, including focused deletion, restart, replay, version-gating and local-control tests.
