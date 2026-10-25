# 2.1.4 — recovery delivery is durable across repeated repairs

- Treat `2.x` peers as newer than the `1.2.47` recovery protocol instead of comparing only the patch component.
- Retry the dialogue pump immediately after replacing a physical route, even when the previous poll was still unwinding.
- Carry the previous physical route in a version 2 recovery capsule and migrate each participant's own pending non-service messages without changing their logical conversation or original inbox identity.
- Prevent a diagnostic transcript reconciliation racing normal transport delivery from duplicating the same timestamped turn.
- Add an authenticated force-recovery utility that backs up local state, replaces a mismatched route through the independent support channel, and migrates pending dialogue messages while ignoring stale service traffic.
