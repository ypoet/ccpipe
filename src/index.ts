/**
 * ccpipe — headless wrapper around Claude Code, billed against the subscription.
 *
 * @example
 *   import { runOnce, Session } from "ccpipe";
 *
 *   // one-shot (equivalent to `claude -p` but billed as TUI)
 *   const r = await runOnce("summarize this repo");
 *   console.log(r.text);
 *
 *   // long-lived session (reuses cc startup, keeps context across asks)
 *   const s = new Session({ model: "opus" });
 *   await s.ready();
 *   console.log((await s.ask("what is 2+2?")).text);
 *   console.log((await s.ask("multiply that by 10")).text);
 *   s.close();
 */
export {
  runOnce,
  Session,
  encodeCwdForCc,
  sessionJsonlPath,
  CLAUDE_BIN,
  CC_PROJECTS_DIR,
  DEFAULT_DISALLOWED_TOOLS,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  DEFAULT_STARTUP_WAIT_MS,
  PIPE_MODE_SYSTEM_PROMPT,
} from "./runner.js";

export type {
  RunOptions,
  RunResult,
  JsonlEvent,
  SessionOptions,
} from "./runner.js";
