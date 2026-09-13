# Reliability architecture

Family Bridge is a modular desktop application, not a collection of network microservices. Its privacy boundary, two-person scale, offline operation, and unattended updates favour one deployable process with explicit internal service contracts. New features should extend these contracts rather than add another network hop.

## Service boundaries

- **Conversation protocol** owns the versioned encrypted payload schema and rejects malformed or unsupported payloads at the transport boundary.
- **Transport** owns authentication, encryption, server insertion, claiming and acknowledgement. It does not run agents or interpret conversation content.
- **Durable conversation state** owns transcripts, prepared outgoing replies, idempotency keys, retry evidence and quarantined payloads. A generated reply and its send timestamp are persisted before transmission and reused after lost responses.
- **Conversation runtime** schedules independent conversations, calls the local agent and advances delivery state. One slow conversation must not block support traffic or another conversation.
- **History projection and archive** reconstruct inherited legacy reports without rewriting them. Readable exports contain each logical message once; raw reports remain available for recovery.
- **Update service** waits for active writes, dictation and conversations, then installs without user intervention. A release is installed only when a fresh report from that device says so.
- **Support service** is a separate encrypted operator lane. Periodic heartbeats and ordinary snapshots remain metadata-only. An explicit deep-diagnostics request may additionally expose app-derived personal state needed to identify a stuck workflow, but never credentials, local paths, or the raw selected source chat.

## Diagnostic API

Deep application diagnostics are a separate, explicit capability. The local authenticated control endpoint exposes `GET /local/application-diagnostics`; the encrypted peer support lane requests the same contract through `POST /peer/diagnostics`. It contains analyzed, pending, in-flight and active topics; prepared launches and messages; owner questions; conversation state; continuations; delivery/quarantine state; reports; and consistency invariants.

This content is never attached to periodic heartbeats or ordinary snapshots. It is captured only for an explicit diagnostic request, is size-bounded, and is accepted only from the currently paired peer. Pairing secrets, credentials, local paths, and the original selected chat remain outside the contract. Topic names and other derived application content are intentionally included because they are required to identify exactly which workflow is stuck.

The preload boundary observes every visible error surface (`role=alert` and the application's error classes). It reports only visibility, count, and a random occurrence identifier—not rendered text. Shown, updated, and cleared transitions are persisted independently of application state and included in explicit application diagnostics, so an operator can distinguish “no error is visible” from “an error was shown and later disappeared”. Main-process failures, renderer crashes, update failures, transport failures, and startup failures continue to use the lifecycle log and are correlated by timestamp.

## Delivery state machine

```text
received from server
  -> durably copied locally
  -> server acknowledged
  -> agent response prepared and durably saved
  -> send with stable conversation/sequence/idempotency key/timestamp
  -> local transcript committed
  -> completed report committed
```

Temporary failures retain the prepared response and use capped exponential backoff. A genuine application restart is allowed one immediate recovery attempt. Invalid protocol payloads are acknowledged into a bounded local quarantine so one poison message cannot block the inbox.

Protocol 2 adds an explicit version and message timestamp. Readers continue to accept structurally valid legacy payloads without a protocol field. New optional fields must be ignored by older versions; semantic changes that would lose context require a peer capability/version gate. Unknown historical time stays unknown.

## Extension rules

1. Add a typed contract and validator before adding a handler.
2. Persist intent before any non-idempotent external operation.
3. Keep user-visible projection separate from private durable state.
4. Add metadata-only support evidence for every new background operation.
5. Test lost-response retry, restart, old-peer compatibility, malformed input, sleep/offline recovery and update interruption.
6. Prefer an internal module over a new process. Split deployment only when isolation, independent scaling or a different trust boundary is demonstrated by measurements.
