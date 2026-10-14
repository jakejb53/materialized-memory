---
name: checkpoint
description: End-of-arc memory checkpoint — update scratchpad, review pins, harvest turns. Run before /clear so the next session bootstraps from current state.
---

# Checkpoint

The end-of-arc discipline: persist working state deliberately, then tell the
user it is safe to `/clear`. Capture itself is continuous (hooks harvest at
session end and before compaction); checkpoint is the reconciliation.

## Steps

1. **Update `memory/scratchpad.md`.** Rewrite the Current State section:
   active task, decisions made this arc, precise next steps. Keep Working
   Notes for durable observations only; prune stale ones. Short and current
   beats long and complete — verbatim history lives in turns, not here.
   Backstop for `/retain`: scan the arc for standing commitments made
   mid-conversation that were never captured, and promote them per retain's
   admission tests and budgets.

2. **Review pins (`memory/pins.json`).** Did any turn this arc change what
   the project is — or, in agent mode, who you are? Pin it with a one-line
   note. Did a pinned turn get superseded? Unpin it. Pins are injected at
   every bootstrap — each one must earn its tokens.

3. **Harvest.** Run:

   ```bash
   node .claude/hooks/harvest.mjs --all
   ```

   Confirm the current session appears with a plausible turn count and no
   unknown-entry-type warnings. Warnings mean transcript format drift — fix
   `harvest.mjs` before trusting the store.

4. **Verify bootstrap freshness.** Run
   `node .claude/hooks/bootstrap.mjs --read | head -40` and confirm it renders
   pins and recent turns without errors.

5. **Report.** Tell the user checkpoint is complete and `/clear` is safe.
