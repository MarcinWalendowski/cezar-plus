import { clusterCorpusChangedFrameSchema, type ClusterDownlinkFrame, type ClusterNodeId } from '@loki-labs/cezar-plus-contract';
import { describe, expect, it, vi } from 'vitest';
import { broadcastCorpusChangedFrame, createCorpusBroadcaster, type CorpusBroadcastLink } from './corpus-broadcast.ts';

/**
 * Item 57's hub side: `corpus-changed` is a HINT (no paths, no bodies) sent to every currently
 * connected node, debounced so one commit's worth of file writes yields one frame. Every assertion
 * below has a negative half — see the parent handoff's brief for why each one is here.
 *
 * No test opens a real socket or watches a real directory: `CorpusBroadcastLink` is a two-method
 * fake, and `readCorpusVersion` is an injected function.
 */

function fakeLink(nodeIds: readonly ClusterNodeId[], sendResults?: Record<string, boolean>) {
  const send = vi.fn((nodeId: ClusterNodeId, _frame: ClusterDownlinkFrame): boolean => sendResults?.[nodeId] ?? true);
  const link: CorpusBroadcastLink = {
    connectedNodes: () => nodeIds,
    send,
  };
  return { link, send };
}

const FRAME_ARGS = { type: 'corpus-changed' as const, protocol: { major: 1, minor: 1 }, corpusVersion: 'v1' };

describe('broadcastCorpusChangedFrame', () => {
  it('sends the frame to every connected node', () => {
    const { link, send } = fakeLink(['a', 'b', 'c']);
    const result = broadcastCorpusChangedFrame(link, FRAME_ARGS);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'c']);
    for (const call of send.mock.calls) expect(call[1]).toMatchObject({ type: 'corpus-changed', corpusVersion: 'v1' });
    expect(result).toEqual({ total: 3, delivered: 3, failed: [] });
  });

  // Negative half of the above: no connected nodes must not throw and must not call send.
  it('sends nothing and does not throw when nobody is connected', () => {
    const { link, send } = fakeLink([]);
    expect(() => broadcastCorpusChangedFrame(link, FRAME_ARGS)).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  // link-server.ts:102 documents a real past bug of exactly this shape (a caller advancing a
  // watermark on an unchecked `send`). This module has no watermark to get wrong, but a `false`
  // still must not be silently dropped — it has to be counted and warned.
  it('warns and counts a false from send(), without throwing or stopping the broadcast', () => {
    const { link, send } = fakeLink(['a', 'b', 'c'], { b: false });
    const warn = vi.fn();
    const result = broadcastCorpusChangedFrame(link, FRAME_ARGS, warn);
    expect(send).toHaveBeenCalledTimes(3); // b's failure did not stop c from being tried
    expect(result).toEqual({ total: 3, delivered: 2, failed: ['b'] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('b');
  });

  // Negative half: an all-success broadcast must not warn at all.
  it('does not warn when every send succeeds', () => {
    const { link } = fakeLink(['a', 'b']);
    const warn = vi.fn();
    broadcastCorpusChangedFrame(link, FRAME_ARGS, warn);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns rather than throwing when send() itself throws', () => {
    const send = vi.fn((): boolean => {
      throw new Error('socket exploded');
    });
    const link: CorpusBroadcastLink = { connectedNodes: () => ['a'], send };
    const warn = vi.fn();
    const result = broadcastCorpusChangedFrame(link, FRAME_ARGS, warn);
    expect(result.failed).toEqual(['a']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('threw'))).toBe(true);
  });

  it('the frame handed to send() validates against the strict schema, with no bodies and no bare path list', () => {
    const { link, send } = fakeLink(['a']);
    broadcastCorpusChangedFrame(link, { ...FRAME_ARGS, scope: ['knowledge', 'tasks'] });
    const sent = send.mock.calls[0]![1];
    const parsed = clusterCorpusChangedFrameSchema.parse(sent); // .strict() throws on any extra key
    expect(parsed).toEqual({ type: 'corpus-changed', protocol: { major: 1, minor: 1 }, corpusVersion: 'v1', scope: ['knowledge', 'tasks'] });
    // The design constraint from item 57, asserted directly rather than left to schema shape alone:
    // no document body and no path list wider than `scope`.
    expect(Object.keys(sent)).toEqual(['type', 'protocol', 'corpusVersion', 'scope']);
    expect(sent).not.toHaveProperty('paths');
    expect(sent).not.toHaveProperty('docs');
    expect(sent).not.toHaveProperty('body');
  });
});

describe('createCorpusBroadcaster', () => {
  it('debounces N rapid notifyChanged() calls into exactly ONE frame', async () => {
    const { link, send } = fakeLink(['a']);
    const readCorpusVersion = vi.fn(async () => 'v-final');
    const broadcaster = createCorpusBroadcaster({ link, readCorpusVersion, debounceMs: 15 });

    for (let i = 0; i < 8; i++) broadcaster.notifyChanged();

    // A function with no debounce at all would also eventually "work" — the count is the assertion.
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30)); // let any (wrongly) extra fires land
    expect(send).toHaveBeenCalledTimes(1);
    expect(readCorpusVersion).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toMatchObject({ corpusVersion: 'v-final' });
  });

  it('reads the corpus version fresh at fire time, not from when notifyChanged() was first called', async () => {
    const { link, send } = fakeLink(['a']);
    let version = 'v1';
    const readCorpusVersion = vi.fn(async () => version);
    const broadcaster = createCorpusBroadcaster({ link, readCorpusVersion, debounceMs: 15 });

    broadcaster.notifyChanged();
    version = 'v2'; // the burst is still landing when this changes
    broadcaster.notifyChanged();

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![1]).toMatchObject({ corpusVersion: 'v2' });
  });

  it('unions scope across a burst', async () => {
    const { link, send } = fakeLink(['a']);
    const broadcaster = createCorpusBroadcaster({ link, readCorpusVersion: async () => 'v1', debounceMs: 15 });
    broadcaster.notifyChanged(['knowledge']);
    broadcaster.notifyChanged(['tasks', 'knowledge']);

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![1]).toMatchObject({ scope: expect.arrayContaining(['knowledge', 'tasks']) });
    expect((send.mock.calls[0]![1] as { scope: string[] }).scope).toHaveLength(2);
  });

  it('one scope-less call in the burst makes the whole frame omit scope (unknown wins)', async () => {
    const { link, send } = fakeLink(['a']);
    const broadcaster = createCorpusBroadcaster({ link, readCorpusVersion: async () => 'v1', debounceMs: 15 });
    broadcaster.notifyChanged(['knowledge']);
    broadcaster.notifyChanged(); // no scope info — the burst becomes "unknown" overall

    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]![1]).not.toHaveProperty('scope');
  });

  it('a rejected readCorpusVersion() warns and sends nothing, rather than throwing', async () => {
    const { link, send } = fakeLink(['a']);
    const warn = vi.fn();
    const broadcaster = createCorpusBroadcaster({
      link,
      readCorpusVersion: async () => {
        throw new Error('disk gone');
      },
      warn,
      debounceMs: 15,
    });
    broadcaster.notifyChanged();

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(send).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]![0]).toContain('disk gone');
  });

  it('stop() cancels a pending debounced broadcast', async () => {
    const { link, send } = fakeLink(['a']);
    const broadcaster = createCorpusBroadcaster({ link, readCorpusVersion: async () => 'v1', debounceMs: 15 });
    broadcaster.notifyChanged();
    broadcaster.stop();

    await new Promise((resolve) => setTimeout(resolve, 40)); // past the debounce window
    expect(send).not.toHaveBeenCalled();
  });

  it('a burst with zero connected nodes still produces one version read and no send, without throwing', async () => {
    const { link, send } = fakeLink([]);
    const readCorpusVersion = vi.fn(async () => 'v1');
    const broadcaster = createCorpusBroadcaster({ link, readCorpusVersion, debounceMs: 15 });
    broadcaster.notifyChanged();
    broadcaster.notifyChanged();

    await vi.waitFor(() => expect(readCorpusVersion).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(send).not.toHaveBeenCalled();
  });
});
