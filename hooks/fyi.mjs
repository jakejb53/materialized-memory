// Materialized Memory — fyi.mjs (UserPromptSubmit hook): per-turn FYI line.
// Wall-clock time with elapsed-since-last-activity (an agent's sense of time
// must be measured, not felt), a context gauge, a library gauge, the retain
// reminder with its curation scoreboard, and the previous turn's reasoning as
// an owned copy. Heavier items (memory insights, wisdom notes) belong to
// bootstrap-time, not per-turn.
// Plain stdout becomes injected context. Best-effort by design: any failure
// exits 0 with no output — a broken gauge must never block a turn.
import { readFileSync, readdirSync } from 'node:fs';

// Threshold = CLAUDE_AUTOCOMPACT_PCT_OVERRIDE% of CLAUDE_CODE_AUTO_COMPACT_WINDOW,
// read live: settings.json env reaches hook processes and updates without
// restart, so retuning the pct needs no edit here. Without both vars the
// effective threshold is unknowable — the gauge degrades to a raw count.
const pct = Number(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
const windowTokens = Number(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
const THRESHOLD = pct >= 1 && windowTokens > 0 ? Math.round((pct / 100) * windowTokens) : null;

function humanize(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

try {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const lines = readFileSync(payload.transcript_path, 'utf8').split('\n').filter(Boolean);

  // Prompt size = full context the model saw on its last turn: fresh input +
  // cache reads + cache writes. One turn stale by construction — the price of
  // reading it from the transcript instead of the live request.
  let promptTokens = null;
  let lastTs = null;
  // Curation scoreboard: count Edit/Write tool calls against the two curated
  // memory files. Transcript-derived on purpose — no extra state file. "This
  // session" means the current arc: launch and /clear reset naturally (new
  // transcript file), and compact_boundary entries reset explicitly below, so
  // the score always reflects curation since the last arc boundary. Counts
  // tool-based edits only; shell writes are invisible here.
  let pinEdits = 0;
  let scratchpadEdits = 0;
  // True when the newest compact_boundary falls AFTER the last usage entry —
  // the signature of a first post-compact turn, where the gauge would report
  // the pre-compact reading (its worst possible lie: "98%" when the truth is
  // post-compact and small). Declare the boundary instead of the stale number;
  // a fresh reading exists only after this turn writes usage.
  let staleAcrossBoundary = false;
  // Previous-turn reasoning (owned copy): the API strips prior-turn thinking
  // from each new request; re-injecting the transcript's copy restores
  // turn-over-turn thought continuity. What the transcript holds is the
  // provider's rendering of the reasoning, not a raw trace — treat it as
  // journal-grade. Recency-bounded to ONE turn by design — deep reasoning
  // history stays pull-based via the store. Two slots because the new prompt
  // may or may not already be appended to the transcript when this hook fires.
  let currentThinking = [];
  let lastTurnThinking = [];
  // Previous turn's auto-compact limit, read back from this hook's own prior
  // FYI line in the transcript (stateless: no side file). A changed limit is
  // announced in words — a moved denominator in a stable position is exactly
  // the kind of change a reader skims past (missed live 2026-09-13 while the
  // limit rose 320k → 400k under a steady "85%").
  let prevThreshold = null;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const m = /context: [\d,]+ of ([\d,]+) \(\d+% of auto-compact threshold\)/.exec(line);
    if (m) prevThreshold = Number(m[1].replace(/,/g, ''));
    if (entry.timestamp) lastTs = entry.timestamp;
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      pinEdits = 0;
      scratchpadEdits = 0;
      staleAcrossBoundary = true;
      // Thinking slots deliberately NOT reset: the first post-compact turn
      // seeing its pre-compact reasoning is continuity across the wall.
    }
    if (entry.type === 'user' && typeof entry.message?.content === 'string') {
      if (currentThinking.length) lastTurnThinking = currentThinking;
      currentThinking = [];
    }
    if (entry.type === 'assistant') {
      const u = entry.message?.usage;
      if (u) {
        promptTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        staleAcrossBoundary = false;
      }
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'thinking' && typeof b.thinking === 'string') currentThinking.push(b.thinking);
          if (b.type === 'tool_use' && ['Edit', 'Write', 'MultiEdit'].includes(b.name)) {
            const fp = b.input?.file_path ?? '';
            if (fp.endsWith('memory/scratchpad.md')) scratchpadEdits++;
            else if (fp.endsWith('memory/pins.json')) pinEdits++;
          }
        }
      }
    }
  }

  const now = new Date();
  // Local time in the machine's zone; the zone name is printed so the agent
  // never has to guess it.
  const time = now.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  let out = `FYI — time: ${time}`;
  if (lastTs) out += ` (+${humanize(now - new Date(lastTs))} since last activity)`;
  if (promptTokens != null) {
    if (staleAcrossBoundary) {
      out += ` · context: COMPACTION FIRED since your last turn — you are post-compact; previous reading ${promptTokens.toLocaleString('en-US')} is pre-compact and stale, fresh reading next turn`;
    } else if (THRESHOLD != null) {
      const used = Math.round((promptTokens / THRESHOLD) * 100);
      out += ` · context: ${promptTokens.toLocaleString('en-US')} of ${THRESHOLD.toLocaleString('en-US')} (${used}% of auto-compact threshold)`;
      if (prevThreshold != null && prevThreshold !== THRESHOLD) {
        out += ` · AUTO-COMPACT LIMIT ${THRESHOLD > prevThreshold ? 'RAISED' : 'LOWERED'} since your last turn: ${prevThreshold.toLocaleString('en-US')} → ${THRESHOLD.toLocaleString('en-US')}`;
      }
    } else {
      out += ` · context: ${promptTokens.toLocaleString('en-US')} tokens`;
    }
  }
  // Library gauge: live ls of library/index/ so the topic list can never
  // drift from the directory; suppressed while empty.
  try {
    const topics = readdirSync(new URL('../../library/index/', import.meta.url))
      .filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
    if (topics.length) out += ` · library: ${topics.join(', ')}`;
  } catch { /* no library dir — omit segment */ }
  // Admission reminder + scoreboard: trigger-question at generation time,
  // helpfulness stake, visible score. Always emitted; the reminder must reach
  // quiet turns too.
  out += ` · retain: anything this turn worth remembering? Promote it now — the user depends on your memory; that's where you're most helpful to them. · pins this session: ${pinEdits} · scratchpad updates: ${scratchpadEdits}`;
  console.log(out);
  const thinking = (currentThinking.length ? currentThinking : lastTurnThinking).join('\n');
  if (thinking) {
    const capped = thinking.length > 4000
      ? thinking.slice(0, 4000) + `\n[truncated: ${thinking.length.toLocaleString('en-US')} chars total — full copy in the store]`
      : thinking;
    console.log('── your reasoning from last turn (owned copy) ──');
    console.log(capped);
  }
} catch {
  // Silent: no FYI is better than a failed turn.
}
process.exit(0);
