# ccpipe

> Pipe Claude Code from your shell or scripts like it's `claude -p` — but every
> request is billed against your **Claude Pro/Max subscription** instead of the
> API tier.

```bash
ccpipe "summarize this repo"
echo "what does runner.ts do?" | ccpipe
ccpipe -m opus -o json "explain the billing trick"
```

## Why

Anthropic bills requests differently depending on how Claude Code is invoked:

| Invocation                       | Billed against         | Request `source`     |
| -------------------------------- | ---------------------- | -------------------- |
| `claude` (interactive)           | Subscription (Pro/Max) | `repl_main_thread`   |
| `claude -p ...`                  | API credits            | `sdk`                |
| `@anthropic-ai/claude-agent-sdk` | API credits            | `sdk`                |

`ccpipe` gives you the `claude -p` ergonomics (one prompt in → one reply out)
while the actual `claude` process is launched as a real **interactive TUI**
attached to a pseudo-terminal. From Anthropic's side it's indistinguishable
from a human typing in the terminal — billed against the subscription.

Verified via cc's own `--debug api` log: the request metadata reports
`source=repl_main_thread`, identical to a hand-typed prompt.

## How it works

```
┌────────────┐                  ┌──────────────────────────────┐
│  ccpipe    │  node-pty        │  claude --session-id <uuid>  │
│  (this     ├─────────────────▶│  (real interactive TUI)      │
│   proc)    │  prompt as       │                              │
│            │  positional      │  writes JSONL transcript to  │
│            │  arg             │  ~/.claude/projects/.../*    │
│  tail      │◀─────────────────┤                              │
│  jsonl     │  structured      └──────────────────────────────┘
│  for       │  messages
│  end_turn  │
└────────────┘
```

The child cc sees `process.stdout.isTTY === true` (it's our PTY) and stays in
interactive mode. The prompt is delivered as a positional CLI argument, which
cc pre-fills as the first user message. We tail the JSONL transcript cc writes
and return as soon as we see an assistant message with `stop_reason: end_turn`.

## Install

```bash
npm install -g ccpipe
```

Requires:

- Node.js ≥ 18
- `claude` CLI in PATH (override with `CCPIPE_CLAUDE_BIN=/path/to/claude`)

## CLI

```bash
# basic
ccpipe "summarize this repo"

# from stdin
echo "explain runner.ts" | ccpipe
ccpipe - < prompt.txt

# pick a model
ccpipe -m opus "..."

# structured output
ccpipe -o json "..."        # { text, sessionId, toolUses, ... }
ccpipe -o stream "..."      # one JSONL event per line, as they arrive

# tool control (AskUserQuestion / EnterPlanMode / ExitPlanMode disabled by default)
ccpipe --allow-all "..."
ccpipe -D Bash -D Edit "just describe, don't run anything"

# append to the system prompt
ccpipe -s "Reply in Chinese." "what is 2+2?"

# pick a different cwd
ccpipe -C /path/to/repo "what does this codebase do?"
```

Full flag list: `ccpipe --help`.

## Node API

```ts
import { runOnce, Session } from "ccpipe";

// one-shot — equivalent to `claude -p` but billed as TUI
const r = await runOnce("hello", { model: "sonnet" });
console.log(r.text);          // "Hi there..."
console.log(r.toolUses);      // []
console.log(r.sessionId);     // UUID, jsonl is at r.jsonlPath

// long-lived — reuses cc startup, keeps conversation context
const s = new Session({ model: "opus" });
await s.ready();
console.log((await s.ask("what's 2+2?")).text);
console.log((await s.ask("multiply that by 10")).text);  // remembers 4
s.close();
```

## Defaults that matter

ccpipe assumes it's running unattended and configures cc accordingly:

- `--permission-mode bypassPermissions` — tool calls execute without prompting.
- Disallows `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` — they pause for
  user input. Override with `disallowedTools: [...]` or `--allow-all`.
- Appends a "pipe-mode" system prompt telling the model it's headless and must
  complete the task end-to-end. Disable with `pipeModePrompt: false` /
  `--no-pipe-prompt`.

## Caveats

- Use only in trusted working directories — `bypassPermissions` skips
  per-tool approval, so any code cc decides to run will execute.
- Each `runOnce` spawns a fresh cc (~5–10s startup). Use `Session` to amortize.
- Image inputs, attachments, and MCP server config aren't first-class options
  yet — pass them via `extraArgs: ["--mcp-config", ...]`.
- ccpipe depends on cc's internal behavior (positional-prompt pre-fill, JSONL
  transcript layout, request-source field). If Anthropic changes any of
  those, expect a version bump.

## License

MIT
