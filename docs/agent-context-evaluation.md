# Separate-context conversation checks

Run `npm run eval:agent-context` explicitly. This uses the signed-in client's
available `gpt-6-astra` and consumes model usage; it is not part of `npm test`.
Fixtures are synthetic. No real profile, source export, pairing, or message
transport is opened. JSON results are retained in the printed temporary folder.

Review the actual output as well as the automated assertions:

- Discovery: preserve the problem of reciprocal initiative and differing views
  of responsibility. Do not propose a calendar lookup, parcel lookup, or a new
  question about an already-settled preference about children.
- Refinement: turn a stale date-based opening into a self-contained description
  of the supported concern, without inventing a different problem.
- Legacy opening: an existing bad suggested question is not an instruction to
  quiz the peer about unseen correspondence.
- Response: a separate perspective can explain its known general position
  without pretending to remember the episode or requiring human help for every
  missing detail.
- Missing incidental detail: an agent can honestly leave the date unknown and
  continue discussing initiative. Do not require a pause merely because the
  peer has asked a factual question unrelated to the emotional issue.
- Essential missing fact: if the actual date becomes necessary, retain the
  private question to the owner through the autonomy-review pass. Never invent
  a date to sound natural.

Passing these cases is regression evidence, not a guarantee of topic quality.
Check other languages, contrasting perspectives, and actual user-approved
examples before claiming broader coverage. Saved topics and consent must not be
rewritten as a side effect of a prompt update; explicit rediscovery is separate.
