# Materialized Memory — Quickstart

Requirements: Claude Code and node. Nothing else.

## 1. Run one script

From this kit directory:

```
node bin/init.mjs /path/to/project
```

It installs the hooks and skills under `.claude/`, registers the hooks in
`.claude/settings.json`, appends a managed section to `CLAUDE.md`, and creates
`memory/`. It never overwrites a file that already exists.

## 2. Launch Claude Code from the project

The agent walks you through the rest in that first session:

- **memory or agent** — durable project memory with no persona, or a named
  persistent agent.
- **the name**, if agent — give it one, or let the agent choose its own.
- **optional auto-compaction tuning** for `settings.json`, if you want the
  context gauge exact and sessions that run indefinitely.

Then it gets to work. The session is harvested when it ends.

## 3. Every later session

Type `/bootstrap` as the first message. The agent materializes its pinned and
recent turns, restates them in its own voice, and is ready for your first
real message. Before a deliberate `/clear`, type `/checkpoint`.

## If the agent named itself and you want the directory to match

After that first session ends:

```
node bin/rename.mjs /path/to/project /path/to/<Name>
```

It moves the directory and its harness transcripts together, so nothing is
stranded. The agent tells you this command at the end of genesis.

## Later: upgrade

From a newer kit:

```
node bin/upgrade.mjs /path/to/project
```

Files you edited locally are diffed and skipped; add `--force` to replace
them.

Scripted setups can skip the questions: `--mode memory`, or `--mode agent`
with an optional `--name <Name>`. `README.md` explains how and why it works.
