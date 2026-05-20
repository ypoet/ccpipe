#!/usr/bin/env node
/**
 * ccpipe CLI — pipe-style headless wrapper around Claude Code.
 *
 *   ccpipe "your prompt"                  # one-shot, text output
 *   ccpipe -m opus "explain runner.ts"    # pick a model
 *   ccpipe -o json "..."                  # structured output
 *   ccpipe -o stream "..."                # stream every JSONL event
 *   echo "summarize:" | ccpipe            # prompt from stdin
 *   ccpipe - < input.txt                  # explicit stdin
 *   ccpipe --allow-all "..."              # re-enable AskUserQuestion etc.
 *   ccpipe -D Bash "describe, don't run"  # disallow specific tools
 */

import { readFileSync } from "node:fs";
import { Command, Option } from "commander";
import { runOnce, DEFAULT_DISALLOWED_TOOLS, type JsonlEvent } from "./runner.js";

function readStdinSync(): string {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

const program = new Command();

program
  .name("ccpipe")
  .description(
    "Pipe-style headless wrapper around Claude Code. " +
      "Bills against the Pro/Max subscription instead of the API tier.",
  )
  .version("0.1.0")
  .argument(
    "[prompt...]",
    'Prompt text (joined with spaces). Use "-" or omit to read from stdin.',
  )
  .option("-C, --cwd <path>", "Working directory for cc")
  .option("-m, --model <name>", "Model alias or full name (e.g. opus, sonnet)")
  .option(
    "-t, --timeout <ms>",
    "Max ms to wait for a reply",
    (v) => Number(v),
    600_000,
  )
  .addOption(
    new Option("-o, --output <fmt>", "Output format")
      .choices(["text", "json", "stream"])
      .default("text"),
  )
  .option("--pty-log <path>", "Tee cc's PTY output to this file (debugging)")
  .option(
    "-D, --disallow <tool>",
    `Tool to disallow (repeatable). Defaults: ${DEFAULT_DISALLOWED_TOOLS.join(",")}.`,
    (v: string, prev: string[]) => prev.concat([v]),
    [] as string[],
  )
  .option("--allow-all", "Allow all tools, including ones that pause for input")
  .option(
    "--no-pipe-prompt",
    "Skip the default pipe-mode system-prompt addendum",
  )
  .option(
    "-s, --system <text>",
    "Extra text appended after the pipe-mode preamble",
  )
  .option(
    "-r, --resume <sid>",
    "Resume an existing session by id (the basename printed on the " +
      "[ccpipe] session=<sid> stderr line from a previous run)",
  )
  .option(
    "--quiet-session",
    "Suppress the [ccpipe] session=<sid> stderr line",
  )
  .option("-v, --verbose", "Print extra progress info to stderr")
  .action(async (promptParts: string[], opts) => {
    let prompt = promptParts.join(" ").trim();

    const wantsStdin = prompt === "-" || prompt === "";
    if (wantsStdin) {
      if (process.stdin.isTTY && prompt === "") {
        process.stderr.write(
          "ccpipe: no prompt provided. Pass it as an argument, " +
            'pipe it on stdin, or use "-" to force stdin read.\n',
        );
        process.exit(2);
      }
      const fromStdin = readStdinSync().trim();
      if (!fromStdin) {
        process.stderr.write("ccpipe: empty prompt on stdin\n");
        process.exit(2);
      }
      prompt = fromStdin;
    }

    let disallowedTools: string[] | undefined;
    if (opts.allowAll) {
      disallowedTools = [];
    } else if (Array.isArray(opts.disallow) && opts.disallow.length > 0) {
      disallowedTools = opts.disallow;
    } else {
      disallowedTools = undefined;
    }

    let onEvent: ((e: JsonlEvent) => void) | undefined;
    if (opts.output === "stream") {
      onEvent = (e: JsonlEvent) => {
        process.stdout.write(JSON.stringify(e) + "\n");
      };
    }

    if (opts.verbose) {
      process.stderr.write(
        `[ccpipe] prompt=${prompt.length}ch cwd=${opts.cwd ?? "$PWD"} ` +
          `model=${opts.model ?? "default"}\n`,
      );
    }

    const result = await runOnce(prompt, {
      cwd: opts.cwd,
      model: opts.model,
      timeoutMs: Number(opts.timeout),
      ptyLog: opts.ptyLog,
      disallowedTools,
      pipeModePrompt: opts.pipePrompt !== false,
      appendSystemPrompt: opts.system,
      onEvent,
      resumeSessionId: opts.resume,
    });

    if (!opts.quietSession) {
      // Always emit the real session id so callers can `--resume` later.
      // Goes to stderr to keep stdout free for piping the actual response.
      const tail = opts.verbose
        ? ` events=${result.events.length} timedOut=${result.timedOut}`
        : "";
      process.stderr.write(`[ccpipe] session=${result.sessionId}${tail}\n`);
    }

    if (result.timedOut && !result.text) {
      process.stderr.write(
        `ccpipe: timeout after ${opts.timeout}ms — no end_turn observed\n`,
      );
      process.exit(1);
    }

    if (opts.output === "text") {
      process.stdout.write(result.text);
      if (!result.text.endsWith("\n")) process.stdout.write("\n");
    } else if (opts.output === "json") {
      process.stdout.write(
        JSON.stringify(
          {
            text: result.text,
            sessionId: result.sessionId,
            jsonlPath: result.jsonlPath,
            timedOut: result.timedOut,
            toolUses: result.toolUses,
          },
          null,
          2,
        ) + "\n",
      );
    }

    process.exit(0);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
