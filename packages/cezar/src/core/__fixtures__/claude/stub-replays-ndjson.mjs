#!/usr/bin/env node
/**
 * A claude stand-in that replays a golden fixture.
 *
 * Reads the fixture path from `STUB_FIXTURE`, waits for the first user message on stdin (so the
 * multi-turn handshake is exercised the same way on both transports), then writes the fixture's
 * lines to stdout verbatim and exits with `STUB_EXIT` (default 0).
 *
 * Verbatim matters: this fixture is the CONTROL for the brokered-vs-in-process parity test, so the
 * bytes the two transports carry have to be the same bytes, not equivalent ones.
 */
import { readFileSync } from 'node:fs';

const fixture = process.env.STUB_FIXTURE;
if (!fixture) {
  // Loud, because the way this goes wrong is quiet: `buildChildEnv` is an allowlist, so a fixture
  // path set on the parent's environment never arrives, and the stub would otherwise just exit.
  process.stderr.write('stub-replays-ndjson: STUB_FIXTURE is unset (buildChildEnv drops it — pass it as spec.env)\n');
  process.exit(2);
}
const lines = readFileSync(fixture, 'utf8').split('\n').filter((l) => l.trim() !== '');
const exitCode = Number(process.env.STUB_EXIT ?? '0');

let buffer = '';
let started = false;
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  if (started || !buffer.includes('\n')) return;
  started = true;
  for (const line of lines) process.stdout.write(`${line}\n`);
  // Flush before exiting: a broker tees stdout to a file, and an exit that races the flush would
  // make the two transports differ for a reason that has nothing to do with either.
  process.stdout.write('', () => setTimeout(() => process.exit(exitCode), 20));
});
