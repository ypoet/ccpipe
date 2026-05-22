# ccpipe — handoff notes for claude code sessions

This file is auto-loaded when claude runs inside `~/ccpipe`. It captures what
was learned debugging the wrapper against claude 2.1.x so future sessions
don't re-discover the same gotchas.

## What ccpipe does (and why)

Wraps the **interactive** `claude` TUI in a `node-pty` PTY and feeds the
prompt as a positional argument, so the resulting requests are tagged
`source=repl_main_thread` (subscription-billed) instead of `source=sdk`
(`claude -p` and the Agent SDK both go through API credits). Returns the
assistant reply by tailing the JSONL transcript claude writes under
`~/.claude/projects/<encoded-cwd>/<sid>.jsonl`, waiting for
`type=assistant && stop_reason=end_turn`.

Code map:
- `src/runner.ts` — `runOnce()`, `Session`, claude spawn, JSONL discovery
- `src/cli.ts` — CLI parser, glues commander → runOnce
- `scripts/fix-node-pty.mjs` — postinstall chmod on `spawn-helper` (1.1.0 bug)

## claude 2.1.x quirks ccpipe must work around

1. **`--session-id <uuid>` is ignored in TUI mode.** It only sets an
   API/telemetry id; local persistence still uses a fresh CLI-generated
   UUID. In `-p` mode it works (file gets named with your UUID). ccpipe
   therefore does NOT pass `--session-id`. Upstream: anthropics/claude-code#44607.

2. **cwd → project-dir encoding replaces `[^A-Za-z0-9-]` with `-`**, not
   just `/`. So `/home/u.233/some_dir` → `-home-u-233-some-dir` (dot and
   underscore also collapse). `encodeCwdForCc` in runner.ts must reflect
   that — earlier `replaceAll("/", "-")` silently broke discovery.

3. **Bypass-permissions warning dialog freezes a headless PTY.** Both
   `--permission-mode bypassPermissions` and `--dangerously-skip-permissions`
   pop a "WARNING ... 1. No, exit / 2. Yes, I accept" picker on every
   startup. Fix: set `"skipDangerousModePermissionPrompt": true` in
   `~/.claude/settings.json`. This is a per-user one-time setup, NOT
   something ccpipe writes for the caller.

4. **The "Resume this session with: claude --resume <sid>" line is never
   written to the PTY** under expect/script/screen/node-pty — the resume
   printer's `process.stdout.isTTY && CT() && !lk()` guard fails. So you
   can't scrape sid from cc's output. Discovery is via dir snapshot.

5. **Workspace trust dialog** triggers on first TUI use of an untrusted
   cwd. Persisted as `projects.<absolute-path>.hasTrustDialogAccepted` in
   `~/.claude.json`. `-p` mode skips it; TUI doesn't. ccpipe leaves this
   to the caller to clear once per cwd.

## How discovery works now

`runOnce` (and `Session.ready()`):
1. Compute `projectDir = ~/.claude/projects/<encoded-cwd>`.
2. **Snapshot** `{jsonl-basename → byte-size}` of the dir before spawn.
3. Spawn claude.
4. Poll the dir (every 100 ms, up to 30 s) for either a brand-new `.jsonl`
   (fresh session) or an existing one whose size grew (resume / continue).
   That file's basename is the real sessionId.
5. Tailer starts from the pre-spawn byte offset so resume only emits
   events from this turn.

If you add `--continue` support later, use the same discoverActiveSessionFile;
it already handles the "size grew" case.

## CLI surface

```
ccpipe "prompt"                         # one-shot, text out, sid → stderr
echo "..." | ccpipe                     # stdin
ccpipe -                                # explicit stdin
ccpipe -r <sid> "more"                  # resume an existing session
ccpipe -o json|stream "..."             # structured output
ccpipe -m opus|sonnet "..."             # pick model
ccpipe -D Bash --allow-all              # tool gating
ccpipe -C /path/repo "..."              # different cwd
ccpipe --quiet-session ...              # suppress the [ccpipe] session= line
```

By default ccpipe prints `[ccpipe] session=<sid>` to stderr after every run
so callers can `-r <sid>` later without using `-o json`.

## Iteration workflow

```bash
cd ~/ccpipe
# edit src/*.ts
npx tsc                                  # rebuilds dist/, global `ccpipe`
                                         # is npm-linked so changes go live
ccpipesg "test prompt"                   # `ccsg`-equivalent for ccpipe;
                                         # defined in ~/UsefulScripts/alias.sh
                                         # — sets HTTPS_PROXY → SG tunnel
                                         # before invoking ccpipe.
```

Pushing: `git push origin main`. This repo has `user.email=27595679+ypoet@users.noreply.github.com`
configured at the repo level (NOT global — global is a byted email). GitHub
auth uses the `cn-devbox` SSH key (already on ypoet's keys).

## What NOT to change without thinking

- Don't re-introduce `--session-id` in the spawn argv.
- Don't relax `encodeCwdForCc` back to single-char replace.
- Don't switch to `--print` mode anywhere on the runOnce/Session path —
  that flips billing back to API.
