#!/usr/bin/env node
// Test-only mock of `opencode serve` for the exit-gate test in
// `opencode-server-runner-exit-gate.test.ts` — a trimmed copy of
// `mock-opencode-serve.mjs` (one scripted text turn, no tool calls) whose ONE
// deliberate difference is what it does on SIGTERM: it exits non-zero (7)
// instead of 0. cezar always tears this process down itself after the turn
// completes (`end()`/`interrupt()` → `terminate()` → SIGTERM); a real
// `opencode serve` build that happens to exit non-zero on its way out from
// that signal must still read as `done`, not as a failed run — that is
// exactly the case this fixture exists to exercise.
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const hostname = arg('--hostname', '127.0.0.1');
const port = Number(arg('--port', '0'));

const SESSION_ID = 'ses_mock_nonzero';
const MESSAGE_ID = 'msg_mock_nonzero';

let sse = null;
const send = (event) => {
  if (sse) sse.write(`data: ${JSON.stringify(event)}\n\n`);
};
const info = (extra) => ({
  id: MESSAGE_ID,
  sessionID: SESSION_ID,
  role: 'assistant',
  time: { created: 1760000000000 },
  modelID: 'mock-model',
  providerID: 'mock',
  mode: 'build',
  path: { cwd: '/repo', root: '/repo' },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  ...extra,
});

const server = createServer((req, res) => {
  const url = req.url ?? '';
  if (req.method === 'GET' && url.startsWith('/event')) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse = res;
    send({ type: 'server.connected', properties: {} });
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.method === 'POST' && url === '/session') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: SESSION_ID, title: 'cezar task' }));
      return;
    }
    if (req.method === 'POST' && url === `/session/${SESSION_ID}/message`) {
      send({ type: 'message.updated', properties: { info: info({}) } });
      send({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'prt_mock_nz1',
            messageID: MESSAGE_ID,
            sessionID: SESSION_ID,
            type: 'text',
            text: 'All done.',
            time: { start: 1760000000100, end: 1760000000200 },
          },
        },
      });
      send({
        type: 'message.updated',
        properties: { info: info({ cost: 0.001, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }) },
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ info: info({ cost: 0.001 }), parts: [] }));
      setTimeout(() => send({ type: 'session.idle', properties: { sessionID: SESSION_ID } }), 20);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});

server.listen(port, hostname, () => {
  // The runner reads the bound URL back from stdout, like the real server.
  console.log(`opencode server listening on http://${hostname}:${port}`);
});
// The ONE deliberate divergence from the sibling fixture: exit non-zero, not 0.
process.on('SIGTERM', () => process.exit(7));
