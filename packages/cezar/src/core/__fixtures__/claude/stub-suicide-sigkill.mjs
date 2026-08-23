#!/usr/bin/env node
// Stub `claude` binary reproducing an EXTERNAL untrapped signal death — the kernel OOM killer, a
// cgroup MemoryMax breach, or an operator's `kill -9` all produce this exact shape. SIGKILL cannot
// be trapped, so unlike `stub-ignores-eof-exits-143.mjs` (which installs a SIGTERM handler and
// exits 143 the way cezar's own teardown expects) this process has no say in how it dies: Node
// reports `code: null, signal: 'SIGKILL'` to whatever is watching it, with no exit code at all.
//
// Emits one init line so the runner sees a live session start, then kills itself shortly after —
// nothing cezar did caused this, which is the point: `terminatedByCezar` stays false throughout.

process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`, () => {
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 150);
});
