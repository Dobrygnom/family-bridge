# Remote application support (release 1.2.20)

Family Bridge can exchange technical status and request its normal automatic
update without either person opening a terminal or collecting a log. Both
applications need a support-enabled release for full diagnostics. An older peer
can receive its existing update-check command, but cannot return a support report.

After both updated applications connect, they automatically establish a separate
encrypted support pair with separate anonymous Supabase accounts. The invitation
is sent through the authenticated, encrypted conversation pair. Support tokens
and keys live under `support-channel/`, independently of the conversation token.
The diagnostic connection then survives a failure of the conversation session.
No new server deployment or migration is required. Changing/removing the saved
conversation pairing detaches its diagnostic channel.

Only application metadata is exchanged: version, platform, process boot ID,
uptime, Codex availability, preparation status, queue counts, update download/
installation state, and a strictly filtered lifecycle log on request. Private
messages, topic names, personal profiles, prompts, local paths, credentials and
crash dumps are excluded. Error text is classified into fixed technical codes.
The protocol supports only a diagnostic snapshot and the official app updater.
It has no shell, arbitrary file read, download URL, script or account-reset action.

## Operator commands

Run from the source checkout on the operator's computer:

```powershell
node --import tsx scripts/family-bridge-support.ts status
node --import tsx scripts/family-bridge-support.ts snapshot
node --import tsx scripts/family-bridge-support.ts update
```

An optional final argument selects a different local profile directory. `status`
reads the running process. `snapshot` requests the peer's current state plus the
last 120 allowed lifecycle events. `update` requests the official updater; it
preserves the existing editing/dictation/background-work installation gates.
Use `status` to read the request result and later version/boot ID. `received` or
`accepted` acknowledges a command; neither means installation completed.
`legacy-update-requested` means an older peer was sent its existing check command;
it does not prove the old process consumed it or installed anything.

The local control server binds only to `127.0.0.1`, uses a random per-process
token in an owner-only locator file, rejects browser origins, and exposes only
fixed routes. The CLI never prints the token. It does not attach Inspector, start
a second app, rewrite state, or read a private transcript. If a command response
is lost, inspect status before retrying. The native process is authoritative;
the tooling environment can see an old filesystem snapshot at the same path.

## Evidence and failure handling

- `independentChannel: true` proves the separate service connection is selected.
- A small heartbeat is sent once per minute. A report older than 90 seconds is
  explicitly stale; delayed delivery cannot make an old report current.
- Snapshot/update commands expire after five minutes. The receiver validates
  the actual sender, recipient, pair, capture time and operation. Historical
  recovery traffic cannot execute support commands. Durable receipts prevent
  an already accepted update from running again after process restart.
- Requests bypass the dialogue/LLM queue. Network calls have a 15-second timeout.
- `diagnostics/support/local.json` and `peer.json` cache technical reports.
  Read the capture time; a file alone does not prove a process is online.
- `diagnostics/lifecycle.jsonl` remains the richer **local** metadata log.
  Crash dumps remain local and are not part of remote reports.
- Independent support still needs a running app, internet and Supabase. If both
  sessions are broken, the app cannot start, or the Mac is off, it cannot return
  a fresh report or install a release. This is application support, not remote
  administration of the entire computer.
- Initial provisioning requires both clients to connect once. Installing this
  code cannot add an endpoint to an old running binary retroactively. Use the
  existing updater/recovery release for that first delivery; do not claim remote
  support is operational until an independent-channel report arrives.

## Verification

The focused tests exercise automatic separate-pair provisioning, loss of both
primary sessions, restart with persisted support credentials, update receipts,
replays and expiry, binding changes, older clients, filtered logs, loopback auth,
and support while a dialogue worker is blocked. They use isolated profiles and
in-memory peers and do not send anything to the production couple's pair.
