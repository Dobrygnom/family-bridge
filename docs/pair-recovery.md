# Automatic connection recovery

Lost anonymous Supabase credentials cannot be repaired by disabling a client-side
check. Membership is enforced by the server. This recovery uses the existing
server APIs and retains RLS and end-to-end encryption.

An authorized surviving participant provisions a replacement server pair. Its
one-time invitation is encrypted with the existing pair's shared secret and
included as a recovery capsule in the application. Only the matching saved pair
can open the capsule. No account credential or encryption secret is published.
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

Recovery capsules are pair-specific and must be kept in subsequent releases.
They are not a general-purpose account recovery service. Losing both account
identities, losing the shared encryption secret, or an app not running/updating
cannot be fixed by this mechanism alone.
