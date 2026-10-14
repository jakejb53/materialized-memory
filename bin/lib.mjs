// Materialized Memory — shared logic for init and upgrade.
//
// A consumer installation is: kit-owned files copied under .claude/ (hooks,
// skills), a managed section spliced into CLAUDE.md between marker comments,
// hook registrations merged into .claude/settings.json, the memory/ layout,
// and a stamp (.claude/materialized-memory.json) recording the kit version,
// the mode, and the sha256 of every kit-owned file as installed. The stamp's
// hashes are how upgrade tells "consumer edited this file" from "kit changed
// this file": a consumer file whose hash still matches the stamp is untouched
// and safe to replace; anything else is a local modification and is never
// silently overwritten.

import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const KIT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const STAMP_REL = join('.claude', 'materialized-memory.json');
const BEGIN = '<!-- materialized-memory:begin';
const END = '<!-- materialized-memory:end -->';

export function kitVersion() {
  return readFileSync(join(KIT_ROOT, 'VERSION'), 'utf8').trim();
}

// Kit-owned files: [source path relative to the kit, destination relative to
// the consumer]. Hooks and skills are discovered from the kit tree so adding
// one to the kit needs no edit here.
export function kitFiles() {
  const files = [];
  for (const f of readdirSync(join(KIT_ROOT, 'hooks')).filter((f) => f.endsWith('.mjs'))) {
    files.push([join('hooks', f), join('.claude', 'hooks', f)]);
  }
  for (const s of readdirSync(join(KIT_ROOT, 'skills'))) {
    const rel = join('skills', s, 'SKILL.md');
    if (existsSync(join(KIT_ROOT, rel))) files.push([rel, join('.claude', 'skills', s, 'SKILL.md')]);
  }
  return files;
}

// Memory templates: created when missing, never overwritten — they are the
// agent's files from the first session on.
export const MEMORY_TEMPLATES = [
  [join('templates', 'pins.json'), join('memory', 'pins.json')],
  [join('templates', 'scratchpad.md'), join('memory', 'scratchpad.md')],
];

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function readStamp(target) {
  const p = join(target, STAMP_REL);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch { throw new Error(`${STAMP_REL} is unreadable — repair or delete it (delete = treat as a fresh install)`); }
}

export function writeStamp(target, stamp) {
  mkdirSync(join(target, '.claude'), { recursive: true });
  writeFileSync(join(target, STAMP_REL), JSON.stringify(stamp, null, 2) + '\n');
}

// Copy one kit-owned file. Returns the action taken so callers can report it.
//   created            — destination did not exist
//   unchanged          — destination already identical to the kit file
//   updated            — destination matched the stamp hash (untouched) and was replaced
//   forced             — destination was locally modified and --force replaced it
//   skipped-modified   — destination was locally modified; left alone, diff printed
export function installFile(target, srcRel, destRel, { stampHash, force }) {
  const src = readFileSync(join(KIT_ROOT, srcRel));
  const dest = join(target, destRel);
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, src);
    return 'created';
  }
  const current = readFileSync(dest);
  if (sha256(current) === sha256(src)) return 'unchanged';
  const untouched = stampHash && sha256(current) === stampHash;
  if (untouched || force) {
    writeFileSync(dest, src);
    return untouched ? 'updated' : 'forced';
  }
  // Locally modified: show what the consumer changed relative to the new kit
  // file so the fix can be proposed back to the kit, then leave it alone.
  const diff = spawnSync('diff', ['-u', join(KIT_ROOT, srcRel), dest], { encoding: 'utf8' });
  process.stdout.write(diff.stdout || `(diff unavailable: ${diff.error?.message ?? 'no output'})\n`);
  return 'skipped-modified';
}

// Splice the managed CLAUDE.md section: replace the block between markers if
// present, otherwise append. Everything outside the markers is the consumer's.
export function spliceClaudeSection(target) {
  const section = readFileSync(join(KIT_ROOT, 'templates', 'CLAUDE.md.section'), 'utf8').trimEnd() + '\n';
  const p = join(target, 'CLAUDE.md');
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const b = existing.indexOf(BEGIN);
  const e = existing.indexOf(END);
  let next;
  let action;
  if ((b === -1) !== (e === -1) || (b !== -1 && e < b)) {
    throw new Error('CLAUDE.md has a broken materialized-memory marker pair — repair the markers by hand, then re-run');
  }
  if (b !== -1 && e !== -1) {
    next = existing.slice(0, b) + section + existing.slice(e + END.length).replace(/^\n/, '');
    action = existing === next ? 'unchanged' : 'respliced';
  } else {
    next = existing ? existing.trimEnd() + '\n\n' + section : section;
    action = existing ? 'appended' : 'created';
  }
  if (action !== 'unchanged') writeFileSync(p, next);
  return action;
}

// Merge hook registrations and the harvest allow-entry into settings.json.
// Additive and idempotent: an event already carrying our hook command is left
// as is; nothing outside `hooks` and `permissions.allow` is read or written.
export function mergeSettings(target) {
  const tmpl = JSON.parse(readFileSync(join(KIT_ROOT, 'templates', 'settings.hooks.json'), 'utf8'));
  const p = join(target, '.claude', 'settings.json');
  const settings = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  const added = [];
  settings.hooks ??= {};
  for (const [event, entries] of Object.entries(tmpl.hooks)) {
    settings.hooks[event] ??= [];
    for (const entry of entries) {
      const ours = entry.hooks[0].command;
      const marker = ours.slice(ours.indexOf('.claude/hooks/'));
      const present = settings.hooks[event].some((x) => (x.hooks ?? []).some((h) => String(h.command ?? '').includes(marker)));
      if (!present) { settings.hooks[event].push(entry); added.push(`${event} → ${marker}`); }
    }
  }
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  for (const rule of tmpl.permissions.allow) {
    if (!settings.permissions.allow.includes(rule)) { settings.permissions.allow.push(rule); added.push(`permissions.allow → ${rule}`); }
  }
  if (added.length) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(settings, null, 2) + '\n');
  }
  return added;
}

// The harness keeps transcripts under ~/.claude/projects/<encoded cwd>, where
// the encoding replaces every "/" with "-". Verified for plain absolute paths;
// paths with other special characters are unverified — check the folder name
// after the first session if the symlink stays dangling.
export function transcriptsTarget(target) {
  const encoded = resolve(target).replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', encoded);
}

// Create memory/ layout: turns dir, templates (if missing), transcripts symlink.
export function ensureMemoryLayout(target) {
  const report = [];
  mkdirSync(join(target, 'memory', 'turns'), { recursive: true });
  mkdirSync(join(target, 'library', 'index'), { recursive: true });
  for (const [srcRel, destRel] of MEMORY_TEMPLATES) {
    const dest = join(target, destRel);
    if (existsSync(dest)) { report.push(`${destRel}: kept (exists)`); continue; }
    writeFileSync(dest, readFileSync(join(KIT_ROOT, srcRel)));
    report.push(`${destRel}: created`);
  }
  const link = join(target, 'memory', 'transcripts');
  const want = transcriptsTarget(target);
  let linkExists = false;
  try { lstatSync(link); linkExists = true; } catch {}
  if (linkExists) {
    let points = null;
    try { points = readlinkSync(link); } catch { /* a real directory, not a link */ }
    report.push(points && points !== want
      ? `memory/transcripts: kept, but it points to ${points} — expected ${want} (repo moved? relink by hand)`
      : 'memory/transcripts: kept (exists)');
  } else {
    symlinkSync(want, link);
    report.push(`memory/transcripts → ${want}${existsSync(want) ? '' : ' (dangling until the first session launches from this directory)'}`);
  }
  return report;
}

// Hash every kit-owned file as it now exists in the consumer, for the stamp.
export function installedHashes(target, files, previous = {}, skipped = new Set()) {
  const out = {};
  for (const [, destRel] of files) {
    // A skipped (locally modified) file keeps its previous stamp hash so the
    // next upgrade still recognizes it as modified rather than as untouched.
    if (skipped.has(destRel)) { out[destRel] = previous[destRel] ?? null; continue; }
    const p = join(target, destRel);
    out[destRel] = existsSync(p) ? sha256(readFileSync(p)) : null;
  }
  return out;
}

export const ENV_RECOMMENDATION = `Recommended (optional) auto-compaction tuning for .claude/settings.json —
makes the FYI context gauge exact and lets sessions run indefinitely under
auto-compaction. Both variables are required together; the percentage alone
does not fire. Values are a starting point:
  "autoCompactEnabled": true,
  "env": {
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "32",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "1000000"
  }`;
