#!/usr/bin/env node
/**
 * node-pty 1.x ships prebuilt spawn-helper binaries without the executable
 * bit set on macOS/Linux, which causes `posix_spawnp failed` at runtime.
 * This postinstall step chmods them after install. Safe to run repeatedly.
 *
 * See https://github.com/microsoft/node-pty/issues/615
 */

import { chmodSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

let pkgPath;
try {
  pkgPath = require.resolve("node-pty/package.json");
} catch {
  process.exit(0); // node-pty isn't installed for some reason — nothing to do
}

const ptyRoot = dirname(pkgPath);
const prebuildsDir = join(ptyRoot, "prebuilds");
if (!existsSync(prebuildsDir)) process.exit(0);

let fixed = 0;
for (const platDir of readdirSync(prebuildsDir)) {
  const helper = join(prebuildsDir, platDir, "spawn-helper");
  if (existsSync(helper)) {
    try {
      chmodSync(helper, 0o755);
      fixed += 1;
    } catch {
      // ignore
    }
  }
}
if (fixed > 0) {
  console.log(`[ccpipe] fixed exec bit on ${fixed} node-pty spawn-helper binar${fixed === 1 ? "y" : "ies"}`);
}
