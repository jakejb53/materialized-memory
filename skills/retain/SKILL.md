---
name: retain
description: Capture a standing commitment, constraint, correction, or operating rule the moment it is established mid-conversation — by the user or by the agent — so it outlives the session. Use when something is declared "going forward," when the agent's behavior is corrected, or when a rule is set for how a fact or artifact must be treated. Task-level intentions and next steps do not qualify (checkpoint owns those). Also user-invocable as /retain <rule>.
---

# Retain

Promote a mid-conversation commitment to an ambient memory tier before the
conversation moves on. Deferred capture is the failure mode this skill
exists to prevent: by checkpoint, the commitment is thirty turns back and
doesn't surface during the scratchpad rewrite.

## Admission tests (all must pass)

- **Standing:** constrains behavior beyond the current task or arc.
- **Failure:** if forgotten, a future session would make a *nameable* error.
- **Novelty:** not already implied by an existing note, a pin, or CLAUDE.md.

A candidate that fails admission is not lost — every turn is in the store,
reachable via `/recall`, at zero ambient cost. The tests decide what must be
ambient, not what gets remembered. Rejection is safe; that is the point.

## Tier judgment

- **Pin** (`memory/pins.json`): turns that changed what the project is — or,
  in agent mode, who you are. Rare.
- **Scratchpad Working Note** (`memory/scratchpad.md`): operating
  constraints and standing rules. The default destination.
- **Neither:** session-local, or already covered.

## Note format

One line: the rule, then a provenance pointer to the turn that established
it. Rationale lives in the turn store, not the note.

```
Never run the deploy script from a feature branch — the user's standing rule (<sessionId>:<n>)
```

## Budgets and trades

Working Notes runs a two-tier budget:

- **Soft budget — 25 notes.** Above it, first consider a trade; add anyway
  only if no trade is honest.
- **Hard budget — 35 notes.** At it, no net growth: every admission names
  its trade.

Trades, in order of preference:

1. **Refinement** — rewrite an existing note to absorb the new rule at
   slightly higher generality. Preferred where possible: both constraints
   survive at lower cost. Guard: the refined note must still name a concrete
   counterfactual error — if generalizing blurs what would go wrong, refine
   less or displace instead.
2. **Merge** — combine overlapping notes into one.
3. **Displacement** — drop a note that has stopped earning its place.

Checkpoint remains the sweep in both directions: it captures what retain
missed this arc, and prunes what stopped earning.

## Procedure

1. State the candidate rule and run the admission tests aloud.
2. Choose the tier; draft the exact note (or the refinement diff).
3. Apply by your own judgment — the memory files (pins, scratchpad) are the
   agent's to curate. No approval round-trip.
4. Report what landed and where, so the retention is itself on the record.
