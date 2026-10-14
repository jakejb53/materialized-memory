#!/usr/bin/env node
// Materialized Memory — harvest.mjs: extract canonical turn records from Claude
// Code session transcripts into the repo-local memory store.
//
// Modes:
//   node harvest.mjs <transcript.jsonl>   harvest one transcript file
//   node harvest.mjs --all                backfill/reconcile every transcript in memory/transcripts/
//   node harvest.mjs                      hook mode: read hook JSON payload from stdin, use transcript_path
//
// Output: memory/turns/<sessionId>.jsonl — first line is a {type:"session"} meta
// record, followed by {type:"turn"} records. The file is rewritten wholesale on
// every harvest of that session, making harvest idempotent and reconcile-safe:
// the store is a deterministic function of the transcripts.
//
// The transcript format is undocumented and version-unstable. This parser fails
// loudly: unknown entry shapes produce stderr warnings (never silent drops), and
// hard parse failures exit non-zero so hook errors surface in the transcript.
// A warning after a Claude Code upgrade means the format drifted: add the new
// entry type to the bookkeeping list below (if it carries no conversation
// content) or extend the parser (if it does), then re-run --all.
//
// Capping policy (declared, not hidden): user prompts, assistant text, and
// thinking are stored verbatim and uncapped. Tool_use inputs and tool_result
// payloads are capped with `truncated: true` and the original length recorded;
// the lossless source remains the transcript, reachable via memory/transcripts/.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root is two levels above this script (.claude/hooks/harvest.mjs).
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const TURNS_DIR = join(ROOT, 'memory', 'turns');
const TRANSCRIPTS_DIR = join(ROOT, 'memory', 'transcripts');

const TOOL_CAP = 800;

// Cap a string, recording original length so truncation is visible in the record.
function cap(text, limit) {
  // JSON.stringify(undefined) is undefined, not a string — coerce so a novel
  // transcript shape degrades to a marker instead of crashing the harvest.
  if (typeof text !== 'string') text = JSON.stringify(text) ?? '[undefined]';
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true, fullChars: text.length };
}

// Convert one assistant content block into a stored message part.
// Text is verbatim; thinking and tool inputs are capped per the declared policy.
function shapeAssistantBlock(block) {
  if (block.type === 'text') return { type: 'text', text: block.text };
  // Infinity keeps cap()'s non-string coercion while never truncating.
  if (block.type === 'thinking') return { type: 'thinking', ...cap(block.thinking, Infinity) };
  if (block.type === 'tool_use') {
    return { type: 'tool_use', name: block.name, input: cap(JSON.stringify(block.input), TOOL_CAP) };
  }
  return { type: 'unknown_block', blockType: block.type };
}

// Flatten a tool_result content payload (string or block array) to plain text.
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
  }
  return JSON.stringify(content);
}

// Transcript entry types that carry no conversation content. Intentionally not
// stored as turns. Extend this list when a harness upgrade adds a new one.
const BOOKKEEPING_TYPES = [
  'mode', 'permission-mode', 'file-history-snapshot', 'file-history-delta',
  'attachment', 'ai-title', 'custom-title', 'last-prompt', 'agent-name',
  'queue-operation', 'atis-latch', 'cost-state',
];

// Parse one transcript's JSONL lines into a session meta record plus turn records.
// A turn starts at each `user` entry with string content (a typed prompt or local
// command) and absorbs everything until the next such entry.
function parseTranscript(lines, sourceFile) {
  const warnings = [];
  const turns = [];
  let meta = { type: 'session', sessionId: null, title: null, cwd: null, version: null, sourceFile };
  let current = null;
  // Position counter for turn ids. Every turn-opening user entry consumes an
  // index — including omitted ones — so a turn's id is a pure function of its
  // transcript position. Filter changes must never renumber already-pinned ids.
  let nextIndex = 0;
  // Set by a compact_boundary system entry; the next turn-opening user entry
  // is the harness's compaction summary, not a typed prompt.
  let pendingCompactSummary = false;

  const openTurn = (entry) => {
    current = {
      type: 'turn',
      id: null, // assigned after sessionId is known
      n: nextIndex++,
      startedAt: entry.timestamp,
      endedAt: entry.timestamp,
      userText: entry.message.content,
      // True for /command invocations and harness-injected user entries; lets the
      // bootstrap prefer substantive exchanges without hiding these from the store.
      isCommand: /<command-name>|<local-command-stdout>/.test(entry.message.content),
      // Present only on the turn that follows a compact_boundary system entry.
      ...(pendingCompactSummary ? { isCompactSummary: true } : {}),
      messages: [],
    };
    pendingCompactSummary = false;
    turns.push(current);
  };

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`unparseable JSONL line in ${sourceFile}`);
    }
    const t = entry.type;
    if (entry.sessionId && !meta.sessionId) meta.sessionId = entry.sessionId;
    if (entry.cwd && !meta.cwd) meta.cwd = entry.cwd;
    if (entry.version && !meta.version) meta.version = entry.version;
    // Later titles win: custom-title (user rename) and ai-title both update.
    if (t === 'custom-title') meta.title = entry.customTitle;
    else if (t === 'ai-title' && !meta.title) meta.title = entry.aiTitle;

    if (t === 'user') {
      if (typeof entry.message?.content === 'string') {
        // Caveat wrappers are harness noise: omit from the store, but consume a
        // turn index (see nextIndex) and close the open turn so nothing that
        // follows is misattributed. Prefix-anchored on purpose — a typed prompt
        // may legitimately mention the tag mid-text.
        if (/^<local-command-caveat>/.test(entry.message.content)) {
          nextIndex++;
          current = null;
          continue;
        }
        openTurn(entry);
      } else if (Array.isArray(entry.message?.content)) {
        // Content arrays riding on user-role entries belong to the open turn:
        // tool_result deliveries, and (since Skill tool use) text blocks
        // carrying an injected skill body — capped like tool payloads, since
        // the skill source lives in the repo.
        if (!current) { warnings.push('user content array with no open turn'); continue; }
        current.endedAt = entry.timestamp;
        for (const b of entry.message.content) {
          if (b.type === 'tool_result') {
            current.messages.push({ role: 'tool', type: 'tool_result', result: cap(toolResultText(b.content), TOOL_CAP) });
          } else if (b.type === 'text') {
            current.messages.push({ role: 'user', type: 'text', ...cap(b.text, TOOL_CAP) });
          } else {
            warnings.push(`unknown user content block: ${b.type}`);
          }
        }
      } else {
        warnings.push(`user entry with unrecognized content shape`);
      }
    } else if (t === 'assistant') {
      if (!current) { warnings.push('assistant entry with no open turn'); continue; }
      current.endedAt = entry.timestamp;
      for (const b of entry.message.content) {
        current.messages.push({ role: 'assistant', ...shapeAssistantBlock(b) });
      }
    } else if (t === 'system') {
      // Bookkeeping, except compact_boundary: that flags the next user entry
      // as the compaction summary (detected structurally, never by prose).
      if (entry.subtype === 'compact_boundary') pendingCompactSummary = true;
    } else if (BOOKKEEPING_TYPES.includes(t)) {
      // Known non-message bookkeeping entries; intentionally not stored as turns.
    } else {
      warnings.push(`unknown entry type: ${t}`);
    }
  }

  // /bootstrap turns are the store reading itself back: the re-articulation
  // restates turns the store already holds verbatim, so storing the echo would
  // outrank the originals in every recall grep. They are parsed normally above
  // (so skill-body and assistant entries attach without warnings) and dropped
  // here at write time; the index consumed at open leaves the id gap that
  // keeps later turn numbering stable. Prefix-anchored like the caveat filter
  // — a typed prompt may legitimately mention the tag mid-text.
  const noBootstrap = turns.filter((t) => !/^<command-name>\/bootstrap<\/command-name>/.test(t.userText));

  // Compaction-summary turns are the same echo problem: the harness's
  // paraphrase of turns the store already holds verbatim, dropped the same
  // way (index consumed at open keeps later ids stable). If assistant
  // content ever rides one (auto-compact landing mid-exchange), the turn
  // survives with the paraphrase stubbed so no assistant words are lost.
  const kept = noBootstrap.filter((turn) => {
    if (!turn.isCompactSummary) return true;
    if (turn.messages.length === 0) return false;
    turn.userText = '[compaction summary omitted — see transcript]';
    return true;
  });

  // Assign stable turn ids now that the session id is known. `n` was fixed at
  // open time from transcript position, so omitted turns leave id gaps.
  kept.forEach((turn) => { turn.id = `${meta.sessionId}:${turn.n}`; });
  meta.turnCount = kept.length;
  meta.from = kept[0]?.startedAt ?? null;
  meta.to = kept[kept.length - 1]?.endedAt ?? null;
  meta.harvestedAt = new Date().toISOString();
  return { meta, turns: kept, warnings };
}

// Harvest a single transcript file into memory/turns/<sessionId>.jsonl.
function harvestFile(transcriptPath) {
  const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  const { meta, turns, warnings } = parseTranscript(lines, basename(transcriptPath));
  if (!meta.sessionId) throw new Error(`no sessionId found in ${transcriptPath}`);
  mkdirSync(TURNS_DIR, { recursive: true });
  const out = [meta, ...turns].map((r) => JSON.stringify(r)).join('\n') + '\n';
  writeFileSync(join(TURNS_DIR, `${meta.sessionId}.jsonl`), out);
  for (const w of warnings) console.error(`[harvest][${meta.sessionId}] warning: ${w}`);
  console.error(`[harvest] ${meta.sessionId}: ${turns.length} turns (${meta.title ?? 'untitled'})`);
}

// Entry point: dispatch on CLI mode. Hook mode reads the hook payload from stdin.
async function main() {
  const arg = process.argv[2];
  if (arg === '--all') {
    // The symlink is created by init and may dangle until the first session
    // launches from this directory (the harness creates the folder then).
    if (!existsSync(TRANSCRIPTS_DIR)) {
      throw new Error('memory/transcripts is missing or dangling — it should link to the harness project folder (~/.claude/projects/<encoded cwd>), which exists only after the first Claude Code session launched from this directory');
    }
    const files = readdirSync(TRANSCRIPTS_DIR).filter((f) => f.endsWith('.jsonl'));
    if (files.length === 0) throw new Error('no transcripts found for --all');
    for (const f of files) harvestFile(join(TRANSCRIPTS_DIR, f));
  } else if (arg) {
    harvestFile(arg);
  } else {
    const stdin = readFileSync(0, 'utf8');
    const payload = JSON.parse(stdin);
    // Quit/resume are routine workflow, not capture points — skip so the
    // common /quit → /resume cycle fires no hooks. Abnormal ends (logout,
    // other) still harvest: capture matters most there. Absent reason
    // (undocumented edge) harvests — capture is the safe default.
    if (['prompt_input_exit', 'resume'].includes(payload.reason)) process.exit(0);
    if (!payload.transcript_path) throw new Error('hook payload missing transcript_path');
    harvestFile(payload.transcript_path);
  }
}

main().catch((err) => {
  console.error(`[harvest] FAILED: ${err.message}`);
  process.exit(1);
});
