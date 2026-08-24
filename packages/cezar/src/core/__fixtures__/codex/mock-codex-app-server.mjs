#!/usr/bin/env node
// Test-only mock of `codex app-server` — speaks just enough JSON-RPC 2.0
// JSONL (§3 of agent-event-protocols.md) for the runner wiring test in
// `codex-ui-mapper.test.ts`: initialize/thread/turn handshake, one scripted
// turn with an agentMessage + a commandExecution (with live outputDelta),
// cumulative token usage, then exits on stdin EOF like the real server.
//
// `MOCK_CODEX_IGNORE_EOF=1` switches to the #703 teardown shape instead: the
// server stays deaf to stdin EOF (the CLI hang the EOF watchdog exists for)
// and handles SIGTERM itself, exiting 143 rather than dying from the signal.
//
// `MOCK_CODEX_IGNORE_SIGTERM=1` is the signal-classification twin: also deaf to EOF, but
// SWALLOWS SIGTERM instead of trapping it into an exit — the shape cezar's own SIGTERM→SIGKILL
// escalation has to punch all the way through, so only the untrappable SIGKILL ends this process.
//
// `MOCK_CODEX_PERSISTED_MODEL=<id>` — the model this mock "created the thread with"
// (`.ai/specs/2026-08-23-codex-resume-explicit-model.md`, Phase 1b). On `thread/resume`, the
// EFFECTIVE model is `msg.params.model ?? MOCK_CODEX_PERSISTED_MODEL` — reproducing real codex's
// behaviour of falling back to persisted `thread_settings.model` when the caller sends no
// override. If that effective model isn't one this mock can serve (anything not matching
// `/^gpt-/`), the first `turn/start` after the resume replies with the real captured rejection
// shape (the same one `mock:provider-rejected` below scripts), naming whichever model was
// actually in play instead of a hard-coded `sonnet`.
import { createInterface } from 'node:readline';

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const rl = createInterface({ input: process.stdin });
/** The model `thread/resume` is in effect for right now — `undefined` after a fresh
 *  `thread/start`, where there is nothing persisted to inherit. */
let resumedEffectiveModel;
/** True only for the first `turn/start` immediately following a `thread/resume` — the window a
 *  real codex rejection over a poisoned `thread_settings.model` would land in. */
let firstTurnAfterResume = false;

const ignoreEof = process.env.MOCK_CODEX_IGNORE_EOF === '1';
const ignoreSigterm = process.env.MOCK_CODEX_IGNORE_SIGTERM === '1';
if (ignoreEof) {
  process.on('SIGTERM', () => process.exit(143));
  // Keep the event loop alive so EOF alone can never end the process.
  setInterval(() => {}, 60_000);
}
if (ignoreSigterm) {
  process.on('SIGTERM', () => {}); // swallow it — only SIGKILL (untrappable) can end this process
  setInterval(() => {}, 60_000);
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === 'ask-1' && msg.result) {
    const answer = msg.result.answers?.library?.answers;
    const freeText = msg.result.answers?.first?.answers;
    emit((Array.isArray(answer) && answer[0] === 'Vitest') || (Array.isArray(freeText) && freeText[0] === 'Use sensible defaults')
      ? { method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } }
      : { method: 'turn/failed', params: { turn: { id: 'turn_mock_1', status: 'failed' }, error: { message: 'bad answer' } } });
  } else if (msg.method === 'initialize') {
    emit({ id: msg.id, result: { userAgent: 'mock-codex/0.0.0' } });
  } else if (msg.method === 'model/list') {
    // A minimal, always-servable catalog so the default `resolveCodexResumeModel` discovery
    // path (`.ai/specs/2026-08-23-codex-resume-explicit-model.md`) resolves fast instead of
    // idling out to `DEFAULT_DISCOVERY_TIMEOUT_MS` in every test that resumes without injecting
    // its own `resumeModel` — one page, `nextCursor: null`, done.
    emit({ id: msg.id, result: { data: [
      { model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: '' },
    ], nextCursor: null } });
  } else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    // Every start/resume request is echoed to stderr so a test can assert on the REQUEST, not
    // only on the outcome (Phase 1b).
    process.stderr.write(`MOCK_RPC ${msg.method} ${JSON.stringify(msg.params)}\n`);
    const expectedSandbox = process.env.CEZ_CODEX_NETWORK === '0' ? 'workspace-write' : 'danger-full-access';
    if (msg.params?.sandbox !== expectedSandbox || msg.params?.approvalPolicy !== 'never') {
      emit({ id: msg.id, error: { code: -32602, message: `expected ${expectedSandbox} auto permissions` } });
      return;
    }
    if (process.argv.includes('sandbox_workspace_write.network_access=true')) {
      emit({ id: msg.id, error: { code: -32602, message: 'workspace-write override is obsolete in full-access mode' } });
      return;
    }
    if (msg.method === 'thread/start') {
      resumedEffectiveModel = undefined;
      emit({ method: 'thread/started', params: { thread: { id: 'th_mock_1' } } });
      emit({ id: msg.id, result: { thread: { id: 'th_mock_1' } } });
    } else if (process.env.MOCK_CODEX_REJECT_RESUME === '1') {
      emit({ id: msg.id, error: { code: -32603, message: `no rollout found for thread id ${msg.params?.threadId ?? ''}` } });
      rl.close();
    } else {
      resumedEffectiveModel = msg.params?.model ?? process.env.MOCK_CODEX_PERSISTED_MODEL;
      firstTurnAfterResume = true;
      emit({ id: msg.id, result: { thread: { id: msg.params?.threadId } } });
    }
  } else if (msg.method === 'turn/start') {
    // Echoed for the same reason thread/start is: `effort` rides on THIS request
    // (`.ai/specs/2026-08-24-codex-step-model-and-effort.md`, D3), and a turn that merely
    // succeeds proves nothing about whether the key was sent, or sent as null.
    process.stderr.write(`MOCK_RPC ${msg.method} ${JSON.stringify(msg.params)}\n`);
    const isFirstTurnAfterResume = firstTurnAfterResume;
    firstTurnAfterResume = false;
    emit({ id: msg.id, result: { turn: { id: 'turn_mock_1' } } });
    emit({ method: 'turn/started', params: { turn: { id: 'turn_mock_1', status: 'inProgress', items: [] } } });
    // codex resuming a thread with a model it cannot serve — reproduced here instead of only in
    // prose, so the negative control (Phase 1b) exercises the real wire shape. Reuses the exact
    // rejection captured off prod-host 2026-08-22 (see `mock:provider-rejected` below),
    // naming whichever model was actually in effect rather than a hard-coded `sonnet`.
    if (isFirstTurnAfterResume && resumedEffectiveModel && !/^gpt-/.test(resumedEffectiveModel)) {
      const detail = JSON.stringify({
        type: 'error',
        status: 400,
        error: { type: 'invalid_request_error', message: `The '${resumedEffectiveModel}' model is not supported when using Codex with a ChatGPT account.` },
      });
      emit({ method: 'warning', params: { threadId: 'th_mock_1', message: `Model metadata for \`${resumedEffectiveModel}\` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.` } });
      emit({ method: 'error', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', willRetry: false, error: { message: detail, codexErrorInfo: 'other' } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'failed', error: { message: detail, codexErrorInfo: 'other' } } } });
      return;
    }
    // An EXTERNAL untrapped signal death mid-turn — the kernel OOM killer, a cgroup MemoryMax
    // breach, or an operator's `kill -9`. The bootstrap handshake above already completed for
    // real, so this fires only once the runner is doing genuine work; nothing cezar did causes
    // it, so `terminatedByCezar` must stay false throughout.
    if (process.env.MOCK_CODEX_SUICIDE_SIGKILL === '1') {
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_m1', delta: 'Checking the working tree.' } });
      setTimeout(() => process.kill(process.pid, 'SIGKILL'), 150);
      return;
    }
    // A deliberate, non-signal exit with an arbitrary code — the "ordinary exit floor" a signal
    // fix must leave untouched.
    if (process.env.MOCK_CODEX_EXIT_CODE !== undefined) {
      const code = Number(process.env.MOCK_CODEX_EXIT_CODE);
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      process.stdout.end(() => process.exit(code));
      return;
    }
    const turnText = msg.params?.input?.map?.((part) => part.text ?? '').join('\n') ?? '';
    if (turnText.includes('mock:turn-failed')) {
      emit({ method: 'turn/failed', params: {
        turn: { id: 'turn_mock_1', status: 'failed' },
        error: { message: 'model unavailable' },
      } });
      return;
    }
    // The shape a real provider rejection takes, captured off the authenticated codex on
    // prod-host 2026-08-22: a standalone `error` notification, then `turn/COMPLETED`
    // carrying `status: "failed"`. Not `turn/failed` — that is the whole trap.
    if (turnText.includes('mock:provider-rejected')) {
      const detail = JSON.stringify({
        type: 'error',
        status: 400,
        error: { type: 'invalid_request_error', message: "The 'sonnet' model is not supported when using Codex with a ChatGPT account." },
      });
      emit({ method: 'warning', params: { threadId: 'th_mock_1', message: 'Model metadata for `sonnet` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.' } });
      emit({ method: 'error', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', willRetry: false, error: { message: detail, codexErrorInfo: 'other' } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'failed', error: { message: detail, codexErrorInfo: 'other' } } } });
      return;
    }
    // An error codex states OUT OF BAND while the turn still ends cleanly. This is the shape that
    // exercises the `error` notification on its own: the turn carries no failure of its own, so
    // nothing else in the runner can surface it.
    if (turnText.includes('mock:error-then-clean-turn')) {
      emit({ method: 'error', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', willRetry: false, error: { message: 'stream disconnected before completion' } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    // The same, but codex says it will retry — a note, never a step failure.
    if (turnText.includes('mock:error-will-retry')) {
      emit({ method: 'error', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', willRetry: true, error: { message: 'rate limited, retrying' } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:subagent-activity')) {
      emit({ method: 'item/started', params: { item: { type: 'subAgentActivity', id: 'activity_1', kind: 'started', agentThreadId: 'th_child', agentPath: '/root/scope_review' } } });
      emit({ method: 'item/completed', params: { item: { type: 'subAgentActivity', id: 'activity_1', kind: 'started', agentThreadId: 'th_child', agentPath: '/root/scope_review' } } });
      emit({ method: 'item/started', params: { item: { type: 'collabAgentToolCall', id: 'wait_1', tool: 'wait', status: 'inProgress', receiverThreadIds: [] } } });
      emit({ method: 'item/completed', params: { item: { type: 'collabAgentToolCall', id: 'wait_1', tool: 'wait', status: 'completed', receiverThreadIds: [] } } });
      emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (turnText.includes('mock:child-turn')) {
      // A spawned sub-agent runs in its OWN child thread that emits a full turn
      // lifecycle over the shared connection. Its turn/completed must not end the
      // parent turn (#600): the parent is still working after the child finishes.
      emit({ method: 'turn/started', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'inProgress', items: [] } } });
      emit({ method: 'item/started', params: { threadId: 'th_child', turnId: 'turn_child', item: { type: 'commandExecution', id: 'item_child', command: ['rg', 'requestUserInput'], cwd: '/repo', status: 'inProgress' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_child', turn: { id: 'turn_child', status: 'completed' } } });
      // Parent keeps streaming after the child's turn ended.
      emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_p1', text: '' } } });
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_p1', delta: 'Still working after the sub-agent.' } });
      emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_p1', text: 'Still working after the sub-agent.' } } });
      emit({ method: 'turn/completed', params: { threadId: 'th_mock_1', turn: { id: 'turn_mock_1', status: 'completed' } } });
      return;
    }
    if (process.env.MOCK_CODEX_ASK === '1' || turnText.includes('mock:native-codex-ask')) {
      const questions = turnText.includes('multi free text')
        ? [{ id: 'first', header: 'First', question: 'First choice?', isOther: true, isSecret: false,
            options: [{ label: 'A', description: 'Option A.' }, { label: 'B', description: 'Option B.' }] },
          { id: 'second', header: 'Second', question: 'Second choice?', isOther: true, isSecret: false,
            options: [{ label: 'C', description: 'Option C.' }, { label: 'D', description: 'Option D.' }] }]
        : [{ id: 'library', header: 'Library', question: 'Which test library?', isOther: true,
            isSecret: false, options: [{ label: 'Vitest', description: 'Use the existing test runner.' },
              { label: 'Node test', description: 'Use node:test.' }] }];
      emit({ id: 'ask-1', method: 'item/tool/requestUserInput', params: {
        threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_ask_1', autoResolutionMs: null,
        questions,
      } });
      return;
    }
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: '' } } });
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_m1', delta: 'Checking the working tree.' } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'agentMessage', id: 'item_m1', text: 'Checking the working tree.' } } });
    emit({ method: 'item/started', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'item_c1', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'inProgress' } } });
    emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', itemId: 'item_c1', delta: ' M src/example.ts\n' } });
    emit({ method: 'item/completed', params: { threadId: 'th_mock_1', turnId: 'turn_mock_1', item: { type: 'commandExecution', id: 'item_c1', command: ['bash', '-lc', 'git status --short'], cwd: '/repo', status: 'completed', exitCode: 0 } } });
    emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'th_mock_1', tokenUsage: { total: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 }, last: { totalTokens: 1500, inputTokens: 1200, outputTokens: 300 } } } });
    emit({ method: 'turn/completed', params: { turn: { id: 'turn_mock_1', status: 'completed' } } });
  }
});

rl.on('close', () => {
  if (!ignoreEof && !ignoreSigterm) process.exit(0);
});
