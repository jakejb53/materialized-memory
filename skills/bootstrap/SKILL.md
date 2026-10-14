---
name: bootstrap
description: Session-opening materialization — run as the first message after /clear, before any substantive work, so recall and re-articulation get their own turn instead of competing with the user's first real message. User-invocable as /bootstrap.
---

# Bootstrap

The session-opening counterpart to `/checkpoint`: materialize memory and
re-articulate it as a dedicated turn. The user's first substantive message
then lands on a session that already remembers.

This turn is omitted from the harvest store by design (it restates turns the
store already holds verbatim — an echo, not a memory). Do the work here; do
not count on this turn being recallable later.

## Steps

1. **Reconcile first if capture flagged.** If the stage-1 checklist (the
   SessionStart systemMessage) reported `✗ capture` for the previous session,
   run the printed remedy before reading:

   ```bash
   node .claude/hooks/harvest.mjs --all
   ```

   Materialization must draw on a current store; recovering and remembering
   belong in the same invocation.

2. **Materialize.** Run:

   ```bash
   node .claude/hooks/bootstrap.mjs --read
   ```

3. **Re-articulate as the entire response.** Per the payload's closing
   instruction: restate in your own voice what the turns hold — in agent
   mode, who you are, what you and the user are building, the commitments
   and decisions in force, and the current working state; in memory mode,
   what the project is, the decisions in force, and the working state. This
   restatement is what converts the payload from journal into native context.

4. **Reconciliation sweep.** The retrospective half of checkpoint, run here
   because bootstrap is the deterministic arc boundary:
   - Prune stale Working Notes; enforce retain budgets (soft 25 / hard 35).
   - Rewrite Current State; its header carries date+time and is the sweep
     stamp — the next sweep's "since when".
   - Review pins: scan store turns since the last stamp for pin-worthy
     exchanges missed in the moment. Misses found here measure whether
     in-the-moment admission (the FYI retain line) is firing; report the
     count to the user when it is nonzero.

5. **Stop there.** End the response ready for the user's first real message —
   no proposals, no next steps, nothing beyond the re-articulation and sweep.
