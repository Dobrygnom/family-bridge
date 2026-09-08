# Topic coverage and conversational grouping

The production analyzer reuses unchanged extraction notes, selects grounded
questions across every fragment, then groups related questions into natural
multi-turn conversations. Neither schema defines a topic-count quota.

Selection receives recent and referenced original messages inline. An explicit
refusal, a closed question, and unknown present relevance are different states.
Unknown relevance is retained as `check_relevance`, never silently approved.

Both model stages persist `decisions` in the private analysis cache. Every input
must have exactly one disposition and every output must be referenced. Grouping
cannot split an input or merge different recipients. Invalid mappings get one
bounded repair pass; a second invalid result fails without applying a partial
agenda. Only decisions contain provenance links, avoiding contradictory inverse
links observed in the prototype.

The UI preserves generated order, shows relevance review in the existing list,
and excludes those proposals from bulk approval. Expanded descriptions retain up
to the existing 800-character transport boundary. Ordinary refresh still retains
saved choices and refinements; an explicitly accepted preview can be installed
separately with source-hash and saved-state guards.

Checks: `npm test`, `npm run typecheck`, `npm run eval:topic-coverage` (opt-in real
model, synthetic source, no pairing/profile). Real responses require semantic
review in addition to deterministic checks. Prompt revisions are evaluated on
fixed evidence, following [OpenAI prompt engineering guidance](https://developers.openai.com/api/docs/guides/prompt-engineering).
