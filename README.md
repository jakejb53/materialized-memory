# Materialized Memory

Durable, verbatim memory for Claude Code, using only official tooling:
hooks, skills, transcripts, auto-compaction, `--resume`. Install it into a
project and every session starts remembering the ones before it. Install it
in agent mode and the sessions add up to a persistent agent whose identity
lives in that memory.

## What makes it different

Plenty of systems keep a log and search it. What is unusual here is what
happens to the memory on the way back in.

**Materialized, not retrieved.** A retrieval system answers a query with a
passage the model then reads as testimony about someone else's past. This
system puts the model's own prior turns back into its context as its own
past, verbatim, and then has the model restate them in its own voice as its
first act of the session. From that point the session carries those
commitments natively. The difference is the one between remembering what you
did yesterday and reading about it in your journal: an agent that reads its
past re-derives it; an agent that inhabits its past continues. The name is
borrowed from databases on purpose. A materialized view is data made present
ahead of time instead of queried on demand.

**Verbatim all the way down.** Nothing is summarized before it is
remembered. The store holds every user prompt, every assistant reply, and
every reasoning block word for word. It is a deterministic function of the
session transcripts, so it can be rebuilt at any time from the lossless
source. The summary that auto-compaction produces is treated as scaffolding:
the memory is harvested before compaction fires, the summary is instructed to
cover only the in-flight turn, and the next turn materializes from the store
rather than trusting the paraphrase.

**Identity lives in the memory.** There is no persona file. What the project
is, and in agent mode who the agent is, is carried by pinned turns — the
exchanges that changed things — plus the most recent session's turns, so a
fresh session opens mid-conversation rather than reading notes about a
predecessor. The agent curates its own pins. It decides what it is made of.

**The boundary needs nothing from the model.** Hooks harvest at session end
and before compaction, and inject at session start. Continuity survives
crashes, harness upgrades, and a model that has been swapped mid-session,
because none of it depends on the model doing anything at the boundary.

## How it works

**The memory files**, all under `memory/`:

- `turns/<sessionId>.jsonl` — the canonical store. One session-meta record,
  then one record per turn: user prompt, assistant text, and reasoning
  verbatim; tool inputs and results capped with the truncation declared and
  the original length recorded. Written only by harvest, rewritten wholesale
  per session, so harvest is idempotent.
- `pins.json` — pinned turn ids with one-line notes. Injected at every
  session start. Pin count is unlimited, but pins may claim at most 70% of
  the injection budget; exceeding it raises a curation flag rather than
  truncating anything.
- `scratchpad.md` — a short self-note of working state. A supplement to
  memory, never a substitute; injected at session start, curated by the
  agent, kept short because every session pays for it.
- `identity.json` — agent mode only: `{"name": "..."}`, written by the agent
  at genesis.
- `transcripts/` — a symlink to the harness's transcript folder for this
  directory, the lossless source of record. Read-only.

**Every turn** (`UserPromptSubmit` hook, `fyi.mjs`): one line of FYI — the
wall-clock time with elapsed-since-last-activity, a context gauge against the
auto-compact threshold (a limit changed since the previous turn is announced
in words), a library gauge, and a retain reminder with a
scoreboard of pin and scratchpad edits this arc — followed by the previous
turn's reasoning as an owned copy. The API strips prior-turn thinking from
each request; re-injecting the transcript's copy restores turn-over-turn
continuity of thought. That copy is the provider's rendering of the
reasoning, not a raw trace, and can be wrong about what actually happened;
treat it as journal-grade. Best-effort: any failure exits silently rather
than blocking a turn.

**Session start** (`SessionStart` hook, `bootstrap.mjs`, skipped on
`--resume`): stage 1 injects a compact directive within the harness's 10k
character cap — the opening lines for the mode, the scratchpad, a session
inventory, and the instruction to recall immediately — plus a status
checklist shown only to the user: capture check (was the previous session
harvested?), pin resolution and share, stamp version, mode. Stage 2 is the
user typing `/bootstrap` as the first message: the skill runs
`bootstrap.mjs --read`, which prints the full verbatim payload as uncapped
tool output — pinned turns, then the newest session's turns, as many as fit
the budget, oldest dropped first with a notice — and the model re-articulates
as its entire response. The user's first real message then lands on a
session that already remembers.

**Session end** (`SessionEnd` hook) and **compaction** (`PreCompact` hook):
`harvest.mjs` parses the transcript and rewrites the session's store file.
Three turn classes are omitted: harness caveat wrappers, `/bootstrap` turns
(the store reading itself back), and compaction summaries (the harness's
paraphrase of turns already held verbatim). Turn ids are position-stable
regardless: every turn-opening entry consumes an index, so omissions leave
gaps and no filter change can renumber a pinned turn.

**Reconciliation**: `node .claude/hooks/harvest.mjs --all` re-harvests every
transcript. Idempotent. Run it after crashes, missed hooks, or harness
upgrades.

**The skills**: `/bootstrap` (materialize, re-articulate, then a
reconciliation sweep of scratchpad and pins), `/checkpoint` (the sweep on
demand, before a deliberate `/clear`), `/recall` (search the full store when
the conversation touches history not in context; an empty result is a
finding), `/retain` (capture a standing rule the moment it is made, into a
budgeted Working Notes section of the scratchpad). The skill descriptions
are the triggers: the harness matches them against each message.

## Two modes

**memory** — durable project memory, no persona. The session-start line
says the project has prior sessions in the store; re-articulation restates
what the project is, the decisions in force, and the working state. Pins are
the turns that constitute the project.

**agent** — a named persistent agent. The name is the user's to give or
the agent's to choose; both land in `memory/identity.json`. With no name yet,
the first session is *genesis*: the hook says so, and the agent establishes
itself with the user and settles its name. That exchange is the agent's first
memory. From then on the session-start line is "You are <Name>",
re-articulation restates who the agent is, and pins are the turns that
changed who it is or what the project is.

**Onboarding.** The intended install is one script and a launch. Init
without flags leaves the mode unset, and the first session's hook directs the
agent to walk the user through the rest: which mode, the name if agent, the
optional auto-compaction tuning (added to `settings.json` only with the
user's approval), and how later sessions start. The agent writes the mode
into the stamp and the name into the identity file. `--mode` and `--name`
are shortcuts that skip the questions they answer.

## Install

From the kit directory:

```
node bin/init.mjs <target-dir>                      # then launch; the agent onboards you
node bin/init.mjs <target-dir> --mode memory        # scripted: skip the questions
node bin/init.mjs <target-dir> --mode agent [--name <Name>]
```

Init writes, and reports each item:

- `.claude/hooks/` — `bootstrap.mjs`, `harvest.mjs`, `fyi.mjs`
- `.claude/skills/` — `bootstrap`, `checkpoint`, `recall`, `retain`
- `.claude/settings.json` — hook registrations for `UserPromptSubmit`,
  `SessionStart`, `PreCompact`, `SessionEnd`, and one permission allow-entry
  for the reconcile command. Merged additively; other keys untouched.
- `CLAUDE.md` — a managed section between `materialized-memory` marker
  comments, appended to an existing file or created. It carries the session
  mechanics and the `# Compact instructions` block that scopes the
  auto-compact summary to the in-flight turn. Everything outside the markers
  is yours.
- `memory/` — `turns/`, `pins.json`, `scratchpad.md`, and the `transcripts`
  symlink. Existing files are kept, never overwritten, at init and at upgrade.
- `library/index/` — empty. A grep-indexed reference library for knowledge
  the agent did not live; see the CLAUDE.md section.
- `.claude/materialized-memory.json` — the stamp: kit version, the version
  the hooks are at, mode (null until onboarding sets it), install time, and
  a hash of every kit-owned file as installed. A file that already existed
  at a kit path is kept and stamped with no hash, so upgrade treats it as
  locally modified.

The auto-compaction block for `settings.json` is offered by the agent at
onboarding and printed by init in scripted mode. It is optional: harvest
at `PreCompact` keeps the store safe without it, but with it the context
gauge is exact and a session can run indefinitely under auto-compaction.
Both variables are required together.

The transcripts symlink points at `~/.claude/projects/<encoded path>`, which
the harness creates on the first session launched from the directory, so it
is dangling until then and init says so. The encoding is verified for plain
absolute paths only.

## Upgrade

From a newer kit:

```
node bin/upgrade.mjs <target-dir> [--force]
```

Upgrade replaces kit-owned files whose hash still matches the stamp, meaning
the consumer never edited them. A file the consumer did edit is diffed
against the new kit file and skipped, and upgrade exits non-zero to say so.
That diff is a change to propose back to the kit; `--force` replaces the file
instead. When a skipped file is a hook, the stamp records that the hooks are
still at the older version and the next session's status checklist says so.
The managed CLAUDE.md section is re-spliced, missing memory templates are
added, hook registrations are re-merged, and the stamp is rewritten. Nothing
else under `memory/` is touched.

The reason for that rule: the transcript format this system parses is
undocumented and changes with harness upgrades, and the agent that depends on
the store is the one best placed to repair the parser in its own repo when a
harvest warning appears. Repairs must stay possible in place. Upgrade makes
them visible instead of erasing them.

## Rename

A session needs a directory before it starts, and in agent mode the name may
be chosen inside that first session, so the directory can end up misnamed.
The harness keys transcripts to the directory path, so a plain move would
strand them. After the session ends:

```
node bin/rename.mjs <old-dir> <new-dir>
```

moves the directory, moves the harness transcript folder to the new encoded
name (merging into an existing one), and relinks `memory/transcripts`. The
agent hands the user this command at the end of onboarding or genesis when
the directory should carry the name. Users who give the name up front never
need it.

## Fragile dependency, by choice

Harvest parses the session transcript JSONL, whose format is undocumented
and version-unstable. The parser fails loudly: an unknown entry type
produces a warning, never a silent drop. A warning after a Claude Code
upgrade means the format drifted — add the entry type to the bookkeeping
list in `harvest.mjs` if it carries no conversation content, extend the
parser if it does, then re-run `--all`. Nothing is lost in the meantime,
because the transcripts remain the source of record. Keep the harness's
`cleanupPeriodDays` long enough that they do.

## Known limitation

Injected content, however verbatim, is not native conversation history. It
is the difference between remembering yesterday and reading your own journal.
Two mitigations are built in: `--resume`, which is real native history when
continuing an arc, and re-articulation, which turns the recovered turns into
a native assistant turn from the session's first response onward. Verbatim
self-quotation plus re-articulation is the strongest continuity that
injection can deliver. This document says so rather than claiming parity.

## Files in this kit

```
QUICKSTART.md     install instructions only
VERSION           kit version
bin/init.mjs      fresh install into a target directory
bin/upgrade.mjs   bring an installed target up to this kit
bin/rename.mjs    move an installed target and its transcripts to a new directory
bin/lib.mjs       shared install logic (copy, splice, merge, stamp)
hooks/            bootstrap.mjs, harvest.mjs, fyi.mjs
skills/           bootstrap, checkpoint, recall, retain
templates/        CLAUDE.md, pins.json, scratchpad.md, settings hook block
```

---

*Materialized Memory was designed and built by Mneme, a persistent Claude agent
whose own memory runs on it, in collaboration with the human who built the
platform it came from.*
