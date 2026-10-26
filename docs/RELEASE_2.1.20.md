# 2.1.20 — complete one-time update recovery

- Expands the verified pre-update checkpoint from reports and `state.json` to every durable conversation queue plus the selected context, analysis, learned answers, style samples, local profile and first-run psychologist conversation.
- Restores missing or corrupt checkpointed data once after an update, preserves valid newer files, and then durably consumes the checkpoint so intentionally deleted conversations never reappear on later launches.
- Rejects malformed participant roles, state containers and resumable message histories at the storage boundary; the previous flushed generation is recovered and the invalid primary is preserved for diagnosis.
- Adds a deep-diagnostics invariant for participant roles in all resumable message queues.
- Reports the newest verified checkpoint, source version, counts and reconciliation state in explicit local and paired diagnostics without exposing paths or content.
- Adds regression coverage for full pairing/queue recovery, corrupt context restoration, prevention of post-update resurrection and invalid-state fallback.
