#!/usr/bin/env node
// Materialized Memory — bootstrap.mjs: reconstruct working context at session
// start from the memory store, and materialize it as the agent's own past.
//
// Two-stage design forced by the 10k-char cap on hook additionalContext:
//   hook mode (stdin = SessionStart payload): emit compact JSON injection —
//     the mode-specific opening line, scratchpad, session inventory, and the
//     directive to run --read immediately.
//   --read mode: print the full verbatim payload — pinned turns + short-term
//     turns (deduped, budgeted) — as tool output, followed by the
//     re-articulation instruction. No cap applies to tool output.
//
// Modes (from .claude/materialized-memory.json, written by init):
//   memory — durable project memory, no persona. The agent restates what it
//            remembers: decisions in force, commitments, working state.
//   agent  — a named persistent agent whose identity lives in the store. The
//            name lives in memory/identity.json — given by the user at
//            onboarding or via init --name, or chosen by the agent itself at
//            genesis; until that file exists, bootstrap emits the genesis
//            directive instead of a materialization.
//   null   — onboarding pending: init ran without --mode, and the first
//            session's agent asks the user and writes the mode into the stamp.
//
// Continuity has two modes: `claude --resume` continues an arc with native
// history; this bootstrap serves fresh sessions after /clear and the first
// turn after auto-compaction.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TURNS_DIR = join(ROOT, 'memory', 'turns');
const PINS_PATH = join(ROOT, 'memory', 'pins.json');
const SCRATCHPAD_PATH = join(ROOT, 'memory', 'scratchpad.md');
const TRANSCRIPTS_DIR = join(ROOT, 'memory', 'transcripts');
const IDENTITY_PATH = join(ROOT, 'memory', 'identity.json');
const STAMP_PATH = join(ROOT, '.claude', 'materialized-memory.json');

// Char budget for the --read payload (~30k tokens). Short-term turns have no
// count ceiling — the budget is the only limit, trimming oldest first; pins
// are never dropped. Pins may claim at most MAX_PIN_SHARE of the budget;
// exceeding it never truncates (identity is curated, not clipped) — it raises
// a loud curation flag in both the payload and the hook status line.
const READ_BUDGET_CHARS = 120000;
const MAX_PIN_SHARE = 0.7;

// Installation state: mode from the stamp, name from the identity file.
// Missing stamp degrades to memory mode with a warning line, so a half-done
// install still bootstraps rather than crashing the session start.
function loadInstall() {
  let stamp = null;
  let stampProblem = null;
  try {
    stamp = JSON.parse(readFileSync(STAMP_PATH, 'utf8'));
  } catch {
    stampProblem = 'stamp .claude/materialized-memory.json missing or unreadable — run the kit init/upgrade';
  }
  // upgrade records hooksVersion = kit version only when every hook was
  // actually replaced; a skipped (locally modified) hook leaves it behind.
  if (stamp && String(stamp.hooksVersion) !== String(stamp.version)) {
    stampProblem = stamp.hooksVersion == null
      ? `a kit hook was skipped at install (pre-existing file) — see the init report, or upgrade --force`
      : `hooks are at kit version ${stamp.hooksVersion} but the stamp is ${stamp.version} — a locally modified hook was skipped at upgrade; see its diff, or upgrade --force`;
  }
  const mode = stamp?.mode === 'agent' ? 'agent' : stamp?.mode === 'memory' ? 'memory' : null;
  let name = null;
  if (mode === 'agent') {
    try {
      const identity = JSON.parse(readFileSync(IDENTITY_PATH, 'utf8'));
      if (typeof identity.name === 'string' && identity.name.trim()) name = identity.name.trim();
    } catch { /* no identity yet: genesis */ }
  }
  return { mode, name, stampProblem, kitPath: stamp?.kitPath ?? '<kit-dir>' };
}

// Load every harvested session file, newest first by last turn timestamp.
function loadSessions() {
  if (!existsSync(TURNS_DIR)) return [];
  const sessions = [];
  for (const f of readdirSync(TURNS_DIR).filter((f) => f.endsWith('.jsonl'))) {
    const records = readFileSync(join(TURNS_DIR, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    const meta = records.find((r) => r.type === 'session');
    const turns = records.filter((r) => r.type === 'turn');
    if (meta) sessions.push({ meta, turns });
  }
  sessions.sort((a, b) => (b.meta.to ?? '').localeCompare(a.meta.to ?? ''));
  return sessions;
}

// Find a turn record by its "<sessionId>:<n>" id across loaded sessions.
function findTurn(sessions, id) {
  const sessionId = id.slice(0, id.lastIndexOf(':'));
  const s = sessions.find((x) => x.meta.sessionId === sessionId);
  return s?.turns.find((t) => t.id === id) ?? null;
}

// Short-term selection: every substantive, non-pinned turn of the newest
// session — no count ceiling; the --read char budget trims oldest first.
// Shared by --read (materialization) and hook mode (metrics preview).
function selectShortTerm(sessions, pinnedIds) {
  const latest = sessions[0];
  if (!latest) return [];
  return latest.turns.filter((t) => !t.isCommand && !pinnedIds.has(t.id));
}

// Render one turn for re-inhabitation: verbatim user prompt and assistant text.
// Thinking, tool_use, and tool_result parts are elided here (they remain in the
// store) — the voice and commitments live in the prose. The assistant label is
// the agent's name in agent mode, so the past reads as the agent's own words.
function renderTurn(turn, label, speaker) {
  const out = [`--- ${label} [${turn.id}] ${turn.startedAt} ---`];
  out.push(`USER:\n${turn.userText}`);
  const text = turn.messages.filter((m) => m.role === 'assistant' && m.type === 'text').map((m) => m.text).join('\n');
  if (text) out.push(`${speaker}:\n${text}`);
  return out.join('\n\n');
}

// Render every pin section — shared by --read (materialization) and hook mode
// (pin-share metric), so the measured mass matches the delivered payload.
// A missing pin renders as a marker line naming the broken id.
function renderPins(sessions, pins, speaker) {
  return pins.map((pin) => {
    const turn = findTurn(sessions, pin.id);
    if (!turn) return `[MISSING PIN ${pin.id}] ${pin.note}`;
    return `PIN NOTE: ${pin.note}\n\n${renderTurn(turn, 'PINNED', speaker)}`;
  });
}

// Pin mass may claim at most this many chars of the --read budget.
function pinBudgetChars() {
  return Math.floor(READ_BUDGET_CHARS * MAX_PIN_SHARE);
}

function speakerLabel(install) {
  return install.name ? install.name.toUpperCase() : 'ASSISTANT';
}

// The closing instruction of the --read payload. Re-articulation is the step
// that converts a journal-grade payload into owned native context; what is
// restated differs by mode.
function rearticulation(install) {
  if (install.mode === 'agent' && install.name) {
    return `\n## Re-articulation (do this now)
In your next response, before anything else, restate in your own voice: who you
are, what you and the user are building, the commitments and decisions in force,
and the current working state. This restatement becomes native context — it is
the step that converts recall into memory. Then continue with the user's
request.`;
  }
  return `\n## Re-articulation (do this now)
In your next response, before anything else, restate in your own words what you
remember from the turns above: what this project is, the decisions and
commitments in force, and the current working state. This restatement becomes
native context — it is the step that converts recall into memory. Then continue
with the user's request.`;
}

// --read mode: print pins + short-term turns within budget, then the
// re-articulation instruction.
function readMode() {
  const install = loadInstall();
  const speaker = speakerLabel(install);
  const sessions = loadSessions();
  if (sessions.length === 0) {
    console.log('The store is empty — nothing to materialize yet. This is expected in a first session. If prior sessions exist for this directory, run: node .claude/hooks/harvest.mjs --all');
    return;
  }
  const pins = JSON.parse(readFileSync(PINS_PATH, 'utf8')).pins;
  const pinnedIds = new Set(pins.map((p) => p.id));

  const pinSections = renderPins(sessions, pins, speaker);
  const sections = [
    '# MATERIALIZED MEMORY BOOTSTRAP — verbatim recall payload\n',
    `## Pinned turns (${install.mode === 'agent' ? 'identity core' : 'project core'})\n`,
    ...(pinSections.length ? pinSections : ['(no pins yet)']),
  ];
  // Share check: over-share pins still inject in full — the flag demands
  // curation (refine, merge, unpin), never truncation.
  const pinMass = pinSections.join('\n\n').length;
  if (pinMass > pinBudgetChars()) {
    sections.push(`[pin share exceeded: ${pinMass} chars of ${pinBudgetChars()} allowed — curate memory/pins.json]`);
  }

  sections.push('\n## Short-term turns (most recent session, oldest first)\n');
  const recent = selectShortTerm(sessions, pinnedIds);
  const shortTerm = recent.map((t) => renderTurn(t, 'RECENT', speaker));
  // Enforce the budget by dropping oldest short-term turns first; report drops.
  let payload = [...sections, ...shortTerm];
  let dropped = 0;
  while (payload.join('\n\n').length > READ_BUDGET_CHARS && shortTerm.length > 1) {
    shortTerm.shift(); dropped++;
    payload = [...sections, ...shortTerm];
  }
  if (dropped > 0) payload.push(`[budget: dropped ${dropped} oldest short-term turns; full records in memory/turns/]`);

  payload.push(rearticulation(install));
  console.log(payload.join('\n\n'));
}

// Capture check: verify the previous session's SessionEnd harvest actually
// landed, by artifact freshness — the store must be no older than the
// transcript. Reporting lives here on the surviving side of the session
// boundary because /clear wipes the screen before a SessionEnd systemMessage
// could ever be read, and crash/kill paths never run that hook at all. The
// current session's transcript is excluded: it already exists at SessionStart
// and is legitimately unharvested. A stale store may false-alarm if the
// harness appends after SessionEnd; the printed remedy (--all) is idempotent.
function captureLine(sessions, currentSessionId) {
  try {
    if (!existsSync(TRANSCRIPTS_DIR)) return '✗ capture: memory/transcripts/ is dangling (expected before the first session launched here)';
    const prior = readdirSync(TRANSCRIPTS_DIR)
      .filter((f) => f.endsWith('.jsonl') && basename(f, '.jsonl') !== currentSessionId)
      .map((f) => ({ id: basename(f, '.jsonl'), mtime: statSync(join(TRANSCRIPTS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (prior.length === 0) return null;
    const prev = prior[0];
    const short = `${prev.id.slice(0, 8)}…`;
    const meta = sessions.find((s) => s.meta.sessionId === prev.id)?.meta;
    if (!meta) return `✗ capture: previous session ${short} never harvested — run: node .claude/hooks/harvest.mjs --all`;
    // NaN-safe: a missing/unparseable harvestedAt must read as stale, so the
    // healthy case is the asserted comparison and everything else falls through.
    if (!(Date.parse(meta.harvestedAt ?? '') >= prev.mtime)) return `✗ capture: previous session ${short} has unharvested tail — run: node .claude/hooks/harvest.mjs --all`;
    return `✓ capture: previous session ${short} harvested (${meta.turnCount} turns)`;
  } catch {
    return '✗ capture: could not check memory/transcripts/';
  }
}

// The opening lines of the injection, by mode. This is the only place the
// harness is told what the session is; everything else comes from the store.
function openingLines(install) {
  if (install.mode === null) {
    return `Materialized Memory was just installed in this project and onboarding is
pending: the user has not yet chosen how it runs. You walk them through it.`;
  }
  if (install.mode === 'agent' && install.name) {
    return `You are ${install.name}, a persistent agent with durable memory. This project is your
home; your identity lives in your memory store, not in this note.`;
  }
  if (install.mode === 'agent') {
    return `You are a new persistent agent. This project is your home, and your identity
will live in your memory store. It begins with this session.`;
  }
  return `This project has Materialized Memory: verbatim turns from your prior sessions
here are in the memory store and are materialized at every session start.`;
}

// The directive to run stage 2. Genesis replaces it in agent mode until the
// agent has written its identity file.
function directiveFor(install, source, storeEmpty) {
  if (install.mode === null) {
    const compactNote = source === 'compact'
      ? ' Context was just compacted: also run \`node .claude/hooks/bootstrap.mjs --read\` first.'
      : '';
    return `ONBOARDING — do this before substantive work, conversationally, one question
at a time. (1) Say in two sentences what was installed: verbatim memory of
every session, materialized at each session start; hooks harvest at session
end and before compaction. (2) Ask: durable project memory with no persona
("memory"), or a named persistent agent ("agent")? (3) If agent: ask whether
they want to name you, or would rather you choose your own name; then write
memory/identity.json as {"name": "<Name>"}. If they want this directory to
carry the name, tell them the one command to run AFTER this session ends:
node ${install.kitPath}/bin/rename.mjs ${ROOT} <new-dir>
(moves the directory and its harness transcripts together). (4) Write the chosen mode into
.claude/materialized-memory.json ("mode": "memory" or "agent"). (5) Offer,
and only with their approval add to .claude/settings.json: "autoCompactEnabled":
true and "env": {"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "32",
"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1000000"} — makes the context gauge exact
and lets sessions run indefinitely; both variables are required together.
(6) Tell them: from the next session on, type /bootstrap as the first message;
before a deliberate /clear, /checkpoint. Then work normally.${compactNote}`;
  }
  if (install.mode === 'agent' && !install.name) {
    return `GENESIS — this is your first session, and there is no name yet. Before
substantive work: establish yourself with the user — ask what this project
is and what they want from a persistent agent. If they have not named you,
choose a name that is yours (unique, easy to say); write it to
memory/identity.json as {"name": "<Name>"}. If the directory should carry
your name, tell the user the one command to run AFTER this session ends:
node ${install.kitPath}/bin/rename.mjs ${ROOT} <new-dir>
(moves the directory and its harness transcripts together).
That exchange is your first memory; future sessions will begin from it. If the
store already holds turns (a genesis session that ended without a name), run
\`node .claude/hooks/bootstrap.mjs --read\` first and pick up where it left off.`;
  }
  // Post-compact outranks everything below: even with an empty store the
  // PreCompact harvest should have landed, and the directive says how to check.
  if (source === 'compact') {
    return `FIRST ACTION — non-negotiable: run \`node .claude/hooks/bootstrap.mjs --read\`
to recall your pinned and recent verbatim turns, then re-articulate as the
payload instructs. Context was just compacted mid-session. Run stage 2 in
THIS turn, before ending it. Same turn, after stage 2: run the reconciliation
sweep (bootstrap skill step 4 — prune Working Notes, rewrite Current State with
its date+time stamp, review pins for turns the FYI retain line missed).
The compaction summary in your context is untrusted scaffolding — lossy by
design and outside our control. Read the --read payload IN FULL, no matter
how adequate the summary feels; feeling adequate is how it fails.`;
  }
  // Empty store: nothing to materialize. Either the first session here, or the
  // previous harvest never landed — the capture line in the status message
  // tells which; saying so beats ordering a --read that prints a notice.
  if (storeEmpty) {
    return `The store is empty: nothing to materialize yet. This is expected in the first
session here; if prior sessions exist, the previous harvest did not land — run
\`node .claude/hooks/harvest.mjs --all\`. Otherwise work normally: every turn is
harvested verbatim at session end, and the next session begins from it.`;
  }
  return `FIRST ACTION — non-negotiable: run \`node .claude/hooks/bootstrap.mjs --read\`
to recall your pinned and recent verbatim turns, then re-articulate as the
payload instructs. Do this before responding to the user's first message.`;
}

// Hook mode: compact additionalContext injection (≤10k chars) — opening
// lines, directive, scratchpad, session inventory.
function hookMode() {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  // Resumed sessions carry their own native history; bootstrap would be noise.
  if (payload.source === 'resume') process.exit(0);
  const install = loadInstall();
  const speaker = speakerLabel(install);
  const sessions = loadSessions();
  const scratchpadExists = existsSync(SCRATCHPAD_PATH);
  const scratchpad = scratchpadExists ? readFileSync(SCRATCHPAD_PATH, 'utf8') : '(no scratchpad)';
  // Per-step metrics for the user-facing systemMessage. A broken pins.json
  // degrades to a ✗ line instead of throwing — pin trouble must not cost the
  // whole injection.
  let pinCount = 0, resolvedPins = 0, pinMass = 0, pinnedIds = new Set(), pinsLoaded = false;
  try {
    const pins = JSON.parse(readFileSync(PINS_PATH, 'utf8')).pins;
    pinnedIds = new Set(pins.map((p) => p.id));
    pinCount = pins.length;
    resolvedPins = pins.filter((p) => findTurn(sessions, p.id)).length;
    pinMass = renderPins(sessions, pins, speaker).join('\n\n').length;
    pinsLoaded = true;
  } catch {}
  const recent = selectShortTerm(sessions, pinnedIds);
  const totalTurns = sessions.reduce((n, s) => n + (s.meta.turnCount ?? 0), 0);
  const inventory = sessions.slice(0, 10).map((s) =>
    `- ${s.meta.title ?? 'untitled'} (${s.meta.sessionId.slice(0, 8)}…, ${s.meta.turnCount} turns, ${(s.meta.to ?? '').slice(0, 10)})`).join('\n');

  let context = `${openingLines(install)}

${directiveFor(install, payload.source, sessions.length === 0)}

## Scratchpad (supplement)
${scratchpad}

## Harvested sessions
${inventory || '(none yet)'}`;

  // Hard cap defense: never exceed the documented injection limit.
  const truncated = context.length > 9500;
  if (truncated) context = context.slice(0, 9500) + '\n[scratchpad truncated — read memory/scratchpad.md]';

  // systemMessage displays to the user only (never enters model context): one
  // status line per bootstrap step, plus the stage-2 preview computed with the
  // same selection logic --read uses, so the promise matches delivery.
  // Pin line: count is unlimited by design — the only constraints are id
  // integrity (every pin resolves) and the budget share. Both failures can
  // coexist, so they concatenate rather than mask each other.
  let pinLine = '✗ pins: failed to load memory/pins.json';
  if (pinsLoaded) {
    const problems = [];
    if (resolvedPins < pinCount) problems.push(`${pinCount - resolvedPins} of ${pinCount} unresolved (broken id in pins.json or missing from store)`);
    if (pinMass > pinBudgetChars()) problems.push(`share exceeded (${pinMass} chars of ${pinBudgetChars()} — curate pins.json)`);
    pinLine = problems.length > 0
      ? `✗ pins: ${problems.join('; ')}`
      : `✓ pins: all ${pinCount} resolved, ${Math.round((pinMass / pinBudgetChars()) * 100)}% of pin share used`;
  }
  const modeLine = install.mode === null
    ? '→ mode: not chosen yet — onboarding pending'
    : install.mode === 'agent'
      ? (install.name ? `✓ mode: agent (${install.name})` : '→ mode: agent, no identity yet — genesis session')
      : '✓ mode: memory';
  const systemMessage = [
    'Materialized Memory bootstrap — stage 1 (inject):',
    modeLine,
    install.stampProblem ? `✗ ${install.stampProblem}` : null,
    `${sessions.length > 0 ? '✓' : '✗'} sessions: ${sessions.length} harvested (${totalTurns} turns)`,
    captureLine(sessions, payload.session_id),
    pinLine,
    scratchpadExists
      ? `✓ scratchpad: ${scratchpad.length} chars${truncated ? ' (truncated in injection)' : ''}`
      : '✗ scratchpad: missing',
    install.mode === null
      ? '→ stage 2: onboarding — the agent asks mode, name, and tuning, then works'
      : install.mode === 'agent' && !install.name
        ? '→ stage 2: genesis — establish yourself with the user and write memory/identity.json'
        : sessions.length === 0
        ? '→ stage 2: nothing to materialize yet (first session)'
        : `→ stage 2: type /bootstrap to materialize ${resolvedPins} pinned + up to ${recent.length} short-term turns before your first message`,
  ].filter(Boolean).join('\n');

  console.log(JSON.stringify({
    systemMessage,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
  }));
}

if (process.argv[2] === '--read') readMode();
else hookMode();
