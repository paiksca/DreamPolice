# Shadow-dreamer — design sketch for collaborative dreaming

## What the user asked for

> Is there a way we could make a multi-dream mode where multiple agents
> collaborate on dreaming?

Short answer: **partial yes, in two layers**.

1. **Verifier quorum** — shipped in v0.2. Multiple verifier models evaluate
   the same proposed promotion in parallel and their verdicts are combined
   under a configurable policy (`conservative` / `majority` / `unanimous`).
   This is already a form of "multi-agent dreaming review" and catches cases
   where a single hallucinating verifier would either over-reject or
   rubber-stamp.

2. **Shadow-dreamer** — a second model produces an alternative consolidation
   of the same raw source, and an arbiter model chooses (or merges). This is
   what true collaborative dreaming would look like end-to-end. **Not
   shipped yet.** This doc explains what would need to change and why it
   isn't in the plugin today.

## Why the full version can't live entirely in the plugin

`memory-core` owns the dream phase. When memory-core promotes, it:

1. Pulls ranked candidates from the short-term recall store.
2. Consolidates them into `MEMORY.md` via its own LLM call.
3. Emits `memory.promotion.applied` to `memory/.dreams/events.jsonl`.

DreamPolice only sees step 3. It has no access to:

- The raw recall store before consolidation.
- The prompt memory-core used.
- The claims memory-core *didn't* promote.

So the plugin can't independently produce a comparably-informed alternate
dream — it can only react to what memory-core already wrote.

**A real collaborative-dreaming feature would need to live in memory-core**
as a pluggable `dreamer` capability (the way OpenClaw already has pluggable
providers). Two paths:

- **Upstream PR** to memory-core adding `MemoryDreamerProvider` with a
  contract like `consolidate(candidates, context) => Promotions`. Multiple
  providers could then run in parallel and memory-core would combine them.
- **Replacement plugin** that calls `registerMemoryCapability` to take over
  the whole memory surface. Too invasive for DreamPolice's scope.

## Plugin-side approximation (what we *can* ship without upstream changes)

After memory-core promotes, DreamPolice can trigger a "shadow dreamer"
consolidation using only the information available in the event:

1. The plugin extracts the promoted candidate snippets (what memory-core
   just wrote).
2. It asks a second model: *"Here is a block that was just consolidated into
   a memory file. Rewrite it for clarity/conciseness/structure while
   preserving the supported claims."*
3. Both the original (memory-core's) and the shadow (DreamPolice's) versions
   are sent to the existing verifier with a prompt variant:
   *"Which version better represents the source material? Or are both
   flawed? Return `{chosen: "original" | "shadow" | "neither", rationale}`"*.
4. If `shadow` wins, apply it as a rewrite via the corrector.
5. If `neither` wins, flag as usual.

### What this buys us

- A second opinion on the *structure* and *wording* of the consolidation
  itself, not just its factual claims.
- A natural experimentation surface: compare styles across models.

### What it doesn't buy

- Doesn't see what memory-core *didn't* promote (the real consolidation
  decision is already locked in).
- Doubles verifier cost and can double correction latency.

### Config surface we'd add

```jsonc
{
  "shadowDreamer": {
    "enabled": false,
    "provider": { /* same shape as verifier.provider */ },
    "arbiter": { /* same shape; defaults to verifier */ },
    "maxAttempts": 1
  }
}
```

### Open questions

1. Should the shadow-dreamer see the prior memory tail (like the verifier
   does today) so it can match voice?
2. Should it be allowed to propose splits (one promoted block becomes two
   separate entries) or is rewrite-in-place enough?
3. How does quorum interact with a shadow-dreamer? If both `quorum.providers`
   and `shadowDreamer` are set, do we get N verifiers reviewing 2 variants
   (2N calls per dream)? That's expensive.

## Recommendation

Defer to v0.3. Verifier quorum (v0.2) already covers the biggest practical
win from multi-agent review — catching a single verifier's blind spots. The
shadow-dreamer is more ambitious, more expensive, and mostly benefits users
who have opinions about *consolidation style*, not users worried about
hallucination. Ship quorum first, collect data on which kinds of issues
users actually wish had a second consolidation attempt, then decide whether
shadow-dreamer is worth its weight.

The real "multi-agent dreaming" feature belongs upstream in `memory-core`.
When we scope the upstream PR (`memory.promotion.candidates` pre-promotion
hook is already on our roadmap), we should also scope `MemoryDreamerProvider`
as a companion.
