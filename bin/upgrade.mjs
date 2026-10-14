#!/usr/bin/env node
// Materialized Memory — upgrade: bring an installed consumer up to this kit.
//
//   node bin/upgrade.mjs <target-dir> [--force]
//
// Replaces kit-owned files the consumer has not modified, re-splices the
// managed CLAUDE.md section, adds any missing memory template, re-merges hook
// registrations, and rewrites the stamp. A kit-owned file the consumer HAS
// modified is diffed and skipped — that diff is a fix to propose back to the
// kit. --force replaces those too. Nothing else under memory/ is ever
// touched: turns, pins, scratchpad, identity are the agent's.

import { resolve } from 'node:path';
import {
  ensureMemoryLayout, installFile, installedHashes, kitFiles, kitVersion,
  mergeSettings, readStamp, spliceClaudeSection, writeStamp, KIT_ROOT,
} from './lib.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const target = args.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('usage: node bin/upgrade.mjs <target-dir> [--force]');
  process.exit(2);
}
const dir = resolve(target);
const stamp = readStamp(dir);
if (!stamp) {
  console.error(`upgrade: ${dir} has no Materialized Memory stamp — run bin/init.mjs for a fresh install`);
  process.exit(2);
}

const version = kitVersion();
const files = kitFiles();
console.log(`Materialized Memory ${stamp.version} → ${version} at ${dir} (mode: ${stamp.mode})${force ? ' [--force]' : ''}\n`);

const skipped = new Set();
for (const [srcRel, destRel] of files) {
  const action = installFile(dir, srcRel, destRel, { stampHash: stamp.files?.[destRel] ?? null, force });
  if (action === 'skipped-modified') skipped.add(destRel);
  console.log(`  ${destRel}: ${action}`);
}
for (const line of ensureMemoryLayout(dir)) console.log(`  ${line}`);
console.log(`  CLAUDE.md: section ${spliceClaudeSection(dir)}`);
const added = mergeSettings(dir);
console.log(`  .claude/settings.json: ${added.length ? 'added ' + added.join(', ') : 'unchanged'}`);

writeStamp(dir, {
  ...stamp,
  version,
  kitPath: KIT_ROOT,
  // Hooks are at the new version only if none was left behind as modified.
  hooksVersion: [...skipped].some((f) => f.startsWith('.claude/hooks/')) ? stamp.hooksVersion ?? null : version,
  upgradedAt: new Date().toISOString(),
  files: installedHashes(dir, files, stamp.files ?? {}, skipped),
});
console.log(`  .claude/materialized-memory.json: stamped ${version}`);

if (skipped.size) {
  console.log(`\n${skipped.size} locally modified file(s) skipped (diffs above). Either propose the change to the kit, or re-run with --force to replace them.`);
  process.exit(1);
}
