#!/usr/bin/env node
// Materialized Memory — init: install the memory system into a project.
//
//   node bin/init.mjs <target-dir> [--mode memory|agent] [--name <Name>]
//
// The intended path is the bare form: install the mechanics, launch Claude
// Code from the directory, and the agent walks the user through the rest in
// the first session (mode, name, optional tuning). The flags are shortcuts for
// scripted setups and skip the onboarding questions they answer:
//   --mode memory   durable project memory, no persona
//   --mode agent    a named persistent agent; with --name the identity file is
//                   written here, without it the agent chooses its own name
//
// Refuses to run on an already-installed target — use upgrade for that.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  ENV_RECOMMENDATION, ensureMemoryLayout, installFile, installedHashes, kitFiles, kitVersion,
  mergeSettings, readStamp, spliceClaudeSection, writeStamp, KIT_ROOT,
} from './lib.mjs';

function usage(msg) {
  if (msg) console.error(`init: ${msg}`);
  console.error('usage: node bin/init.mjs <target-dir> [--mode memory|agent] [--name <Name>]');
  process.exit(2);
}

const args = process.argv.slice(2);
const opt = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : (args[i + 1] ?? usage(`${flag} needs a value`)); };
const mode = opt('--mode');
const name = opt('--name');
const consumed = new Set([mode, name].filter((v) => v !== null));
const target = args.find((a) => !a.startsWith('--') && !consumed.has(a));
if (!target) usage('target directory required');
if (mode !== null && !['memory', 'agent'].includes(mode)) usage('--mode must be memory or agent');
if (name !== null && mode !== 'agent') usage('--name requires --mode agent');

const dir = resolve(target);
if (readStamp(dir)) usage(`${dir} already has Materialized Memory installed — run bin/upgrade.mjs instead`);
mkdirSync(dir, { recursive: true });

const version = kitVersion();
const files = kitFiles();
console.log(`Materialized Memory ${version} → ${dir}${mode ? ` (mode: ${mode})` : ''}\n`);

// A pre-existing file at a kit path is the consumer's: never overwritten at
// init, and stamped with no hash so a later upgrade still treats it as
// locally modified instead of laundering it into "untouched".
const skipped = new Set();
for (const [srcRel, destRel] of files) {
  const action = installFile(dir, srcRel, destRel, { stampHash: null, force: false });
  if (action === 'skipped-modified') skipped.add(destRel);
  console.log(`  ${destRel}: ${action}`);
}
for (const line of ensureMemoryLayout(dir)) console.log(`  ${line}`);
if (name) {
  writeFileSync(join(dir, 'memory', 'identity.json'), JSON.stringify({ name }, null, 2) + '\n');
  console.log(`  memory/identity.json: created (${name})`);
}
console.log(`  CLAUDE.md: section ${spliceClaudeSection(dir)}`);
const added = mergeSettings(dir);
console.log(`  .claude/settings.json: ${added.length ? 'added ' + added.join(', ') : 'unchanged'}`);

writeStamp(dir, {
  version,
  // null mode = onboarding pending: the first session's agent asks.
  mode,
  // Where the kit lives, so the hooks can print exact upgrade/rename commands.
  kitPath: KIT_ROOT,
  installedAt: new Date().toISOString(),
  // hooksVersion tracks the version the hooks themselves are at; upgrade
  // advances it only when no hook was skipped.
  hooksVersion: skipped.size ? null : version,
  files: installedHashes(dir, files, {}, skipped),
});
console.log(`  .claude/materialized-memory.json: stamped${mode ? '' : ' (onboarding pending)'}`);

// Scripted mode skips onboarding, so the tuning offer is printed here instead.
if (mode !== null) console.log(`\n${ENV_RECOMMENDATION}`);
console.log(`\nNext: launch Claude Code from ${dir}.`);
if (mode === null) {
  console.log('  The agent will walk you through the rest in the first session: memory or agent,');
  console.log('  its name (yours to give or its own to choose), and optional auto-compaction tuning.');
} else if (mode === 'agent' && !name) {
  console.log('  Agent mode: the first session is genesis — the agent establishes itself with you');
  console.log('  and chooses its own name.');
}
console.log('  From the second session on, type /bootstrap as the first message.');
