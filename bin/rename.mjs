#!/usr/bin/env node
// Materialized Memory — rename: move an installed project to a new directory
// and carry its harness transcripts with it.
//
//   node bin/rename.mjs <old-dir> <new-dir>
//
// Why this exists: a session needs a directory before it starts, and in agent
// mode the name may be chosen inside that first session — so the directory
// can end up misnamed. The harness keys transcripts to the directory path
// (~/.claude/projects/<encoded path>), so a plain mv would strand them. This
// script moves the directory, moves the transcript folder to the new encoded
// name (merging into an existing one), and relinks memory/transcripts.
//
// Run it after the session in <old-dir> has ended. Never while it is open.

import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readStamp, transcriptsTarget } from './lib.mjs';

const [oldArg, newArg] = process.argv.slice(2);
if (!oldArg || !newArg) {
  console.error('usage: node bin/rename.mjs <old-dir> <new-dir>   (run after the session in <old-dir> has ended)');
  process.exit(2);
}
const oldDir = resolve(oldArg);
const newDir = resolve(newArg);
if (!existsSync(oldDir)) { console.error(`rename: ${oldDir} does not exist`); process.exit(2); }
if (!readStamp(oldDir)) { console.error(`rename: ${oldDir} has no Materialized Memory stamp`); process.exit(2); }
if (existsSync(newDir)) { console.error(`rename: ${newDir} already exists`); process.exit(2); }

// Transcript folders are computed before the move so both encodings are known.
const oldProj = transcriptsTarget(oldDir);
const newProj = transcriptsTarget(newDir);

mkdirSync(resolve(newDir, '..'), { recursive: true });
renameSync(oldDir, newDir);
console.log(`  ${oldDir} → ${newDir}`);

if (existsSync(oldProj)) {
  if (!existsSync(newProj)) {
    renameSync(oldProj, newProj);
    console.log(`  transcripts: ${oldProj} → ${newProj}`);
  } else {
    // Merge: session files are named by session id, so collisions mean the
    // same session on both sides — keep the destination's copy and say so.
    let moved = 0, kept = 0;
    for (const f of readdirSync(oldProj)) {
      if (existsSync(join(newProj, f))) { kept++; continue; }
      renameSync(join(oldProj, f), join(newProj, f));
      moved++;
    }
    console.log(`  transcripts: merged into ${newProj} (${moved} moved${kept ? `, ${kept} already present, left in ${oldProj}` : ''})`);
  }
} else {
  console.log(`  transcripts: no folder at ${oldProj} (no session launched from the old directory yet)`);
}

// Relink memory/transcripts to the new encoded folder.
const link = join(newDir, 'memory', 'transcripts');
try { if (lstatSync(link).isSymbolicLink()) unlinkSync(link); } catch {}
symlinkSync(newProj, link);
console.log(`  memory/transcripts → ${newProj}${existsSync(newProj) ? '' : ' (dangling until the first session launches from the new directory)'}`);
console.log(`\nDone. Launch Claude Code from ${newDir} from now on.`);
