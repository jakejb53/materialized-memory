---
name: recall
description: Search the memory store for past turns relevant to the current conversation. Use whenever the discussion references prior sessions, past decisions, designs, or artifacts whose history is not already in context — or when unsure whether relevant history exists. An empty result is a finding. Also user-invocable as /recall <topic>.
---

# Recall

Pull-based memory search over `memory/turns/`, ending in re-articulation.
Recalled text is journal-grade testimony until restated in your own voice —
the restatement is what converts it into owned context.

## Steps

1. **Derive terms.** From the current topic: artifact names, decision
   keywords, people, synonyms. Prefer distinctive terms over common words.

2. **Search the store.** Each line of `memory/turns/<sessionId>.jsonl` is one
   whole turn (user text + assistant text + tool parts), so a line match is a
   turn match:

   ```bash
   grep -ril '<term>' memory/turns/
   grep -i '<term>' memory/turns/<session>.jsonl | grep -o '"id":"[^"]*"'
   ```

   The id space is sparse — omitted turns leave gaps — so never infer ids
   arithmetically; take them only from matches.

3. **Read matching turns in full.** Pull each record by id and read userText
   plus assistant text. Widen to neighboring turns when the exchange clearly
   continues across ids.

4. **Drop to transcripts when capped payloads matter.** Thinking, tool
   inputs, and tool results are capped in the store (`truncated: true`); the
   lossless record is `memory/transcripts/<sessionId>.jsonl`.

5. **Re-articulate.** In the response, restate what was found and its bearing
   on the current discussion — quote verbatim where the exact wording carries
   the commitment. Findings left in tool output do not persist; the
   restatement does.

6. **Cite and stay honest.** Name the turn ids recall came from. If the store
   has nothing, say so — an empty result is a real finding, never filled in
   from imagination.
