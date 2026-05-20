/**
 * ccpipe core — drive an interactive `claude` TUI through a PTY and read
 * the assistant reply from the session jsonl that cc itself writes.
 *
 * Why this exists: Anthropic bills `claude -p` (and the Agent SDK) against
 * the API tier, but interactive TUI usage against the user's Claude
 * subscription (Pro/Max). By spawning `claude` inside a real PTY and never
 * passing `-p`, every request looks identical to a human typing in the TUI.
 *
 * Verified via cc's own `--debug api` logs:
 *   - `claude -p ...`        → request `source=sdk`
 *   - ccpipe                  → request `source=repl_main_thread`
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import * as pty from "node-pty";

export const CLAUDE_BIN = process.env.CCPIPE_CLAUDE_BIN ?? "claude";

/**
 * Resolve a command name to an absolute path via the user's PATH.
 * node-pty's posix_spawn does not perform PATH lookup, so we have to do it
 * ourselves; otherwise the spawn fails with "posix_spawnp failed".
 */
function resolveBinary(cmd: string): string {
  if (path.isAbsolute(cmd)) return cmd;
  try {
    const out = execSync(`command -v ${JSON.stringify(cmd)}`, {
      encoding: "utf-8",
      shell: "/bin/sh",
    });
    const resolved = out.trim();
    if (resolved) return resolved;
  } catch {
    // fall through
  }
  throw new Error(
    `ccpipe: cannot find '${cmd}' on PATH. Set CCPIPE_CLAUDE_BIN to the ` +
      `absolute path of your claude binary.`,
  );
}
export const CC_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
export const DEFAULT_RESPONSE_TIMEOUT_MS = 600_000;
export const DEFAULT_STARTUP_WAIT_MS = 30_000;

/**
 * Tools that pause the agent for user input — fatal in headless mode.
 * Override via `disallowedTools` in RunOptions, or pass `[]` to allow all.
 */
export const DEFAULT_DISALLOWED_TOOLS = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
];

/**
 * System-prompt addendum appended via `--append-system-prompt` so the model
 * knows it's running headless and shouldn't pause for input.
 */
export const PIPE_MODE_SYSTEM_PROMPT =
  "You are running in ccpipe pipe mode: this is a headless, " +
  "non-interactive invocation. There is no human at the other end to " +
  "answer questions or approve plans. The tools AskUserQuestion, " +
  "EnterPlanMode, and ExitPlanMode are disabled. Make any necessary " +
  "decisions yourself, do not pause to clarify or seek confirmation, " +
  "and complete the request from start to finish in a single turn. " +
  "End your turn only when the task is fully done or genuinely blocked " +
  "(in which case explain the blocker in the final message rather than " +
  "asking the user).";

export interface RunOptions {
  /** Working directory for cc. Defaults to process.cwd(). */
  cwd?: string;
  /** Model alias or full name (e.g. "opus", "sonnet"). */
  model?: string;
  /** Max ms to wait for end_turn. Default 600_000 (10 min). */
  timeoutMs?: number;
  /** Tee cc's PTY output to this file path (for debugging). */
  ptyLog?: string;
  /** Tools to disallow. Default DEFAULT_DISALLOWED_TOOLS. Pass [] to allow all. */
  disallowedTools?: string[];
  /** Whether to append PIPE_MODE_SYSTEM_PROMPT. Default true. */
  pipeModePrompt?: boolean;
  /** Extra text appended after the pipe-mode preamble. */
  appendSystemPrompt?: string;
  /** Extra CLI args passed verbatim to `claude`. */
  extraArgs?: string[];
  /** Per-jsonl-event callback (receives every line as it arrives). */
  onEvent?: (event: JsonlEvent) => void;
}

export interface JsonlEvent {
  type?: string;
  message?: {
    role?: string;
    content?: Array<Record<string, unknown>>;
    stop_reason?: string;
  };
  [key: string]: unknown;
}

export interface RunResult {
  text: string;
  sessionId: string;
  jsonlPath: string;
  events: JsonlEvent[];
  timedOut: boolean;
  toolUses: Array<{ name: string; input: unknown }>;
}

/**
 * cc encodes cwd by replacing every character outside [A-Za-z0-9-] with
 * '-'. So `/data00/home/user.233/some_dir` becomes
 * `-data00-home-user-233-some-dir` (slash, dot, underscore all become '-').
 * Match exactly so we know which jsonl file to tail.
 */
export function encodeCwdForCc(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

export function sessionJsonlPath(sessionId: string, cwd: string): string {
  return path.join(CC_PROJECTS_DIR, encodeCwdForCc(cwd), `${sessionId}.jsonl`);
}

function buildSystemAddendum(
  pipeMode: boolean,
  extra: string | undefined,
): string {
  const parts: string[] = [];
  if (pipeMode) parts.push(PIPE_MODE_SYSTEM_PROMPT);
  if (extra) parts.push(extra);
  return parts.join("\n\n");
}

function buildClaudeArgs(
  opts: RunOptions,
  positionalPrompt: string | null,
  resumeSessionId: string | null,
): string[] {
  const disallowed =
    opts.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS;
  const systemAddendum = buildSystemAddendum(
    opts.pipeModePrompt !== false,
    opts.appendSystemPrompt,
  );

  // Intentionally NOT passing --session-id: in claude 2.1.x TUI mode it only
  // sets a separate API/telemetry id, while local persistence still uses a
  // freshly-generated UUID. We discover that real UUID by snapshotting the
  // project dir before spawn and watching for a new *.jsonl file (see
  // discoverNewSessionFile). Tracked upstream as anthropics/claude-code#44607.
  //
  // --dangerously-skip-permissions (rather than --permission-mode
  // bypassPermissions) is the only variant that doesn't pop an interactive
  // "WARNING: Bypass Permissions mode ... 1. No, exit / 2. Yes, I accept"
  // dialog at startup, which would freeze a headless PTY forever.
  const args = [
    "--dangerously-skip-permissions",
    "--no-chrome",
  ];
  if (disallowed.length > 0) {
    args.push("--disallowedTools", ...disallowed);
  }
  if (systemAddendum) {
    args.push("--append-system-prompt", systemAddendum);
  }
  if (opts.model) {
    args.push("--model", opts.model);
  }
  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }
  if (resumeSessionId !== null) {
    args.push("--resume", resumeSessionId);
  }
  if (positionalPrompt !== null) {
    args.push(positionalPrompt);
  }
  return args;
}

function projectDirFor(cwd: string): string {
  return path.join(CC_PROJECTS_DIR, encodeCwdForCc(cwd));
}

function snapshotJsonlFiles(projectDir: string): Set<string> {
  try {
    return new Set(
      fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl")),
    );
  } catch {
    return new Set();
  }
}

/**
 * Wait for a new *.jsonl file to appear in projectDir that wasn't in
 * `existing`. Returns the basename-derived sessionId and full path. Throws
 * if the wait budget is exhausted before any new file appears.
 */
async function discoverNewSessionFile(
  projectDir: string,
  existing: Set<string>,
  timeoutMs: number,
  pollMs = 100,
): Promise<{ sessionId: string; jsonlPath: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(projectDir);
    } catch {
      // dir may not exist yet — first time this cwd is used with cc
    }
    const newOnes = entries.filter(
      (f) => f.endsWith(".jsonl") && !existing.has(f),
    );
    if (newOnes.length > 0) {
      // If somehow several new files appear in the same window, pick the
      // most recently modified — safest bet for "the one we just spawned".
      let best = newOnes[0];
      let bestMtime = -Infinity;
      for (const f of newOnes) {
        try {
          const m = fs.statSync(path.join(projectDir, f)).mtimeMs;
          if (m > bestMtime) {
            bestMtime = m;
            best = f;
          }
        } catch {
          // file vanished between readdir and stat — skip
        }
      }
      const sessionId = best.replace(/\.jsonl$/, "");
      return { sessionId, jsonlPath: path.join(projectDir, best) };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(
    `ccpipe: claude did not create a session jsonl in ${projectDir} ` +
      `within ${timeoutMs}ms. Check that the claude binary works ` +
      `interactively in this directory (workspace trust dialog, auth, etc.).`,
  );
}

function extractText(message: JsonlEvent["message"] | null): string {
  if (!message) return "";
  const out: string[] = [];
  for (const c of message.content ?? []) {
    if (c && typeof c === "object" && (c as { type?: string }).type === "text") {
      const t = (c as { text?: string }).text;
      if (typeof t === "string") out.push(t);
    }
  }
  return out.join("\n").trim();
}

function collectToolUses(events: JsonlEvent[]): RunResult["toolUses"] {
  const out: RunResult["toolUses"] = [];
  for (const e of events) {
    if (e.type !== "assistant") continue;
    const content = e.message?.content;
    if (!content) continue;
    for (const c of content) {
      if (c && typeof c === "object" && (c as { type?: string }).type === "tool_use") {
        const cc = c as { name?: string; input?: unknown };
        out.push({ name: cc.name ?? "?", input: cc.input });
      }
    }
  }
  return out;
}

/**
 * Tail a jsonl file (which may not exist yet) yielding each appended JSON
 * object. Emits 'event' with each parsed object and 'done' when stopped.
 */
class JsonlTailer extends EventEmitter {
  private filePath: string;
  private position: number;
  private stopped: boolean;
  private timer: NodeJS.Timeout | null;
  private pollMs: number;

  constructor(filePath: string, pollMs = 200) {
    super();
    this.filePath = filePath;
    this.position = 0;
    this.stopped = false;
    this.timer = null;
    this.pollMs = pollMs;
  }

  start(): void {
    const tick = (): void => {
      if (this.stopped) return;
      this.readChunk();
      if (!this.stopped) {
        this.timer = setTimeout(tick, this.pollMs);
      }
    };
    tick();
  }

  /** Skip past existing content (so we only see future appends). */
  jumpToEnd(): void {
    try {
      const stat = fs.statSync(this.filePath);
      this.position = stat.size;
    } catch {
      // file doesn't exist yet — position 0 is fine
    }
  }

  private readChunk(): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      return;
    }
    if (stat.size <= this.position) return;
    let fd: number;
    try {
      fd = fs.openSync(this.filePath, "r");
    } catch {
      return;
    }
    try {
      const length = stat.size - this.position;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, this.position);
      this.position = stat.size;
      const text = buf.toString("utf-8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as JsonlEvent;
          this.emit("event", obj);
        } catch {
          // ignore malformed lines (partial writes settle on the next tick)
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.emit("done");
  }
}

/**
 * Run a single prompt against a freshly-spawned cc TUI. Resolves when an
 * assistant message with `stop_reason: "end_turn"` is observed, or when
 * the timeout fires (resolves with `timedOut: true` in that case).
 */
export async function runOnce(
  prompt: string,
  opts: RunOptions = {},
): Promise<RunResult> {
  const cwd = opts.cwd ?? process.cwd();
  const projectDir = projectDirFor(cwd);
  const before = snapshotJsonlFiles(projectDir);

  const args = buildClaudeArgs(opts, prompt, null);

  const child = pty.spawn(resolveBinary(CLAUDE_BIN), args, {
    name: "xterm-256color",
    cols: 200,
    rows: 50,
    cwd,
    env: process.env as { [key: string]: string },
  });

  let logStream: fs.WriteStream | null = null;
  if (opts.ptyLog) {
    logStream = fs.createWriteStream(opts.ptyLog, { flags: "a" });
  }
  child.onData((data) => {
    if (logStream) logStream.write(data);
  });

  let sessionId: string;
  let jsonlPath: string;
  try {
    ({ sessionId, jsonlPath } = await discoverNewSessionFile(
      projectDir,
      before,
      DEFAULT_STARTUP_WAIT_MS,
    ));
  } catch (e) {
    try {
      child.kill();
    } catch {}
    if (logStream) logStream.end();
    throw e;
  }

  const events: JsonlEvent[] = [];
  const tailer = new JsonlTailer(jsonlPath);
  tailer.start();

  const timeoutMs = opts.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  let timedOut = false;
  let finalMessage: JsonlEvent["message"] | null = null;

  await new Promise<void>((resolve) => {
    const cleanup = (): void => {
      tailer.stop();
      resolve();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      cleanup();
    }, timeoutMs);

    tailer.on("event", (evt: JsonlEvent) => {
      events.push(evt);
      if (opts.onEvent) {
        try {
          opts.onEvent(evt);
        } catch {
          // user callback errors mustn't kill the run
        }
      }
      if (
        evt.type === "assistant" &&
        evt.message &&
        evt.message.stop_reason === "end_turn"
      ) {
        finalMessage = evt.message;
        clearTimeout(timer);
        cleanup();
      }
    });
  });

  try {
    child.kill();
  } catch {
    // already gone
  }
  if (logStream) logStream.end();

  return {
    text: extractText(finalMessage),
    sessionId,
    jsonlPath,
    events,
    timedOut,
    toolUses: collectToolUses(events),
  };
}

export interface SessionOptions extends RunOptions {
  /** Resume an existing cc session by id. */
  sessionId?: string;
  /** Max ms to wait for cc to spin up before the first ask. */
  startupWaitMs?: number;
}

/**
 * A long-lived cc TUI child process. `session.ask(prompt)` types the prompt
 * into the running TUI and waits for the next end_turn. Saves cc's startup
 * overhead across queries and preserves the conversation context.
 */
export class Session {
  readonly cwd: string;
  /** Populated by ready(); read before then is undefined. */
  sessionId!: string;
  /** Populated by ready(); read before then is undefined. */
  jsonlPath!: string;

  private child: pty.IPty;
  private logStream: fs.WriteStream | null;
  private tailer!: JsonlTailer;
  private projectDir: string;
  private snapshotBefore: Set<string> | null;
  private pending: Map<number, (evt: JsonlEvent) => void>;
  private askLock: Promise<unknown>;
  private closed: boolean;

  constructor(opts: SessionOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.projectDir = projectDirFor(this.cwd);
    this.askLock = Promise.resolve();
    this.pending = new Map();
    this.closed = false;

    if (opts.sessionId) {
      // Resume: we already know the persistence id and file path.
      this.sessionId = opts.sessionId;
      this.jsonlPath = sessionJsonlPath(this.sessionId, this.cwd);
      this.snapshotBefore = null;
    } else {
      // Fresh: discover the real persistence id in ready() by watching for
      // a new jsonl file in the project dir.
      this.snapshotBefore = snapshotJsonlFiles(this.projectDir);
    }

    const args = buildClaudeArgs(
      opts,
      null,
      opts.sessionId ?? null,
    );

    this.child = pty.spawn(resolveBinary(CLAUDE_BIN), args, {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: this.cwd,
      env: process.env as { [key: string]: string },
    });

    this.logStream = opts.ptyLog
      ? fs.createWriteStream(opts.ptyLog, { flags: "a" })
      : null;
    this.child.onData((data) => {
      if (this.logStream) this.logStream.write(data);
    });
  }

  /** Wait until cc has created the jsonl file (TUI is alive) or the wait
   * budget elapses. The tailer is then positioned at end-of-file so the
   * first ask() only sees events from its own turn. */
  async ready(opts: { waitMs?: number } = {}): Promise<void> {
    const waitMs = opts.waitMs ?? DEFAULT_STARTUP_WAIT_MS;
    if (this.snapshotBefore) {
      // Fresh session: discover the real jsonl that claude creates.
      let discovered: { sessionId: string; jsonlPath: string };
      try {
        discovered = await discoverNewSessionFile(
          this.projectDir,
          this.snapshotBefore,
          waitMs,
        );
      } catch (e) {
        this.close();
        throw e;
      }
      this.sessionId = discovered.sessionId;
      this.jsonlPath = discovered.jsonlPath;
      this.snapshotBefore = null;
    } else {
      // Resume: the file should already exist; wait briefly in case cc
      // hasn't reopened it yet.
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (fs.existsSync(this.jsonlPath)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    this.tailer = new JsonlTailer(this.jsonlPath);
    this.tailer.jumpToEnd();
    this.tailer.start();
  }

  /** Send a prompt, wait for end_turn, return the result. */
  async ask(
    prompt: string,
    opts: { timeoutMs?: number; onEvent?: (e: JsonlEvent) => void } = {},
  ): Promise<RunResult> {
    if (this.closed) throw new Error("Session is closed");
    if (!this.tailer) {
      throw new Error("Session: call await ready() before ask()");
    }

    // Serialize asks so two callers can't write into the TUI concurrently.
    const prev = this.askLock;
    let release: () => void = () => {};
    this.askLock = new Promise<void>((r) => {
      release = r;
    });
    await prev.catch(() => {});

    try {
      this.child.write(prompt + "\r");

      const events: JsonlEvent[] = [];
      const timeoutMs = opts.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
      let timedOut = false;
      let finalMessage: JsonlEvent["message"] | null = null;

      await new Promise<void>((resolve) => {
        const onEvent = (evt: JsonlEvent): void => {
          events.push(evt);
          if (opts.onEvent) {
            try {
              opts.onEvent(evt);
            } catch {}
          }
          if (
            evt.type === "assistant" &&
            evt.message &&
            evt.message.stop_reason === "end_turn"
          ) {
            finalMessage = evt.message;
            cleanup();
          }
        };
        const timer = setTimeout(() => {
          timedOut = true;
          cleanup();
        }, timeoutMs);
        const cleanup = (): void => {
          clearTimeout(timer);
          this.tailer.off("event", onEvent);
          resolve();
        };
        this.tailer.on("event", onEvent);
      });

      return {
        text: extractText(finalMessage),
        sessionId: this.sessionId,
        jsonlPath: this.jsonlPath,
        events,
        timedOut,
        toolUses: collectToolUses(events),
      };
    } finally {
      release();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.tailer) this.tailer.stop();
    try {
      this.child.kill();
    } catch {}
    if (this.logStream) this.logStream.end();
  }
}
