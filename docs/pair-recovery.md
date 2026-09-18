# Automatic connection recovery

Lost anonymous Supabase credentials cannot be repaired by disabling a client-side
check. Membership is enforced by the server. This recovery uses the existing
server APIs and retains RLS and end-to-end encryption.

Every successfully connected pair automatically provisions its own recovery
capsule. The capsule is a separate encrypted support pair with separate anonymous
Supabase identities, stored only in the two local profiles. Its invitation is
sent through the already authenticated and encrypted dialogue pair. Nothing
pair-specific is compiled into the application or committed to the repository,
and there is no vendor or master recovery key.

When the primary anonymous identity later becomes unusable, an authorized
surviving recovery participant provisions a replacement physical transport pair
through that independent capsule. Both applications keep the original logical
pair and conversation IDs, so existing reports, continuations, prepared replies
and message history remain the same conversations rather than becoming a new
chat. Only the physical server route changes.
The invited participant can join using a surviving identity or, if it has no
session, a replacement anonymous identity. Network failures alone never create
accounts. The creator must retain its verified existing identity.

The adapter preserves logical pair and conversation IDs. It maps physical
conversation UUIDs deterministically to avoid the server's cross-pair sequence
uniqueness constraint. Reports, topic choices, owner answers, drafts and ongoing
conversation state are not reset or rewritten. Both installations must receive
the update before their new transport can communicate.

Undelivered outgoing envelopes are copied idempotently by their original sender.
Their original inbox IDs are retained to prevent duplicate model turns. Pending
and claimed incoming rows addressed to the surviving identity are still drained
from the old pair; already durable local inbox entries continue normally. Old
deliveries never replace fresh peer-version/presence information. Old server rows
are retained, not deleted; history reads merge by logical sequence number.

`scripts/verify-pair-recovery.ts` verifies the protocol against the live service
with isolated anonymous accounts and synthetic text. It tests loss of all guest
credentials, automatic joining, queued-message recovery, a claimed row abandoned
before acknowledgement, both directions, history continuity and restart dedupe.

Recovery capsules are pair-specific local state and survive ordinary application
updates. They are not a general-purpose account recovery service. Losing the
whole local profile (including its shared encryption secret and local history),
or an app not running/updating, cannot be fixed without a user-held backup. A
master key is intentionally not present because it would allow cross-pair access.
