import { createServer, type Server } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { verifyWsUpgrade } from './server.ts';
import {
  createSocketHub,
  WS_PATH,
  type SocketHub,
  type TopicOptions,
  type TopicPublisher,
  type WsUpgradeVerdict,
} from './ws.ts';

/**
 * The hub is exercised over REAL sockets — a Node http server plus the `ws`
 * client — because the contract under test is transport behavior: upgrade
 * routing, the 403 pre-handshake rejection, and that a dying connection (not
 * just a polite unsubscribe frame) releases its topics so publishers stop.
 */

const servers: Server[] = [];
const hubs: SocketHub[] = [];

afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

/** A controllable topic: counts starts/stops, exposes the live `publish`. */
function makeTopic(snapshot: unknown = { tick: 0 }) {
  const state = {
    started: 0,
    stopped: 0,
    publish: undefined as ((data: unknown) => void) | undefined,
  };
  const publisher: TopicPublisher = {
    snapshot: async () => snapshot,
    start: (publish) => {
      state.started += 1;
      state.publish = publish;
      return () => {
        state.stopped += 1;
        state.publish = undefined;
      };
    },
  };
  return { state, publisher };
}

async function boot(
  publisher: TopicPublisher,
  verify: (req: IncomingMessage) => WsUpgradeVerdict = () => ({ trusted: true }),
  heartbeatMs?: number,
  topicOptions?: TopicOptions,
): Promise<{ base: string; url: string }> {
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const hub = createSocketHub(heartbeatMs === undefined ? {} : { heartbeatMs });
  hub.registerTopic('ticker', publisher, topicOptions);
  hub.attach(server, verify);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  hubs.push(hub);
  const { port } = server.address() as AddressInfo;
  return { base: `ws://127.0.0.1:${port}`, url: `ws://127.0.0.1:${port}${WS_PATH}` };
}

/** A connected client whose frames arrive as an awaitable queue. */
async function connect(url: string) {
  const ws = new WebSocket(url);
  const frames: unknown[] = [];
  const waiters: Array<(frame: unknown) => void> = [];
  ws.on('message', (raw) => {
    const frame: unknown = JSON.parse(String(raw));
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  return {
    ws,
    send: (frame: unknown) => ws.send(JSON.stringify(frame)),
    next: (): Promise<unknown> =>
      frames.length > 0
        ? Promise.resolve(frames.shift())
        : new Promise((resolve, reject) => {
            waiters.push(resolve);
            setTimeout(() => reject(new Error('no frame within 2s')), 2_000).unref();
          }),
  };
}

describe('createSocketHub', () => {
  it('starts the publisher on the first subscriber and answers with the snapshot', async () => {
    const { state, publisher } = makeTopic({ hello: 'world' });
    const { url } = await boot(publisher);
    const client = await connect(url);

    client.send({ type: 'subscribe', topic: 'ticker' });
    expect(await client.next()).toEqual({ type: 'event', topic: 'ticker', data: { hello: 'world' } });
    expect(state.started).toBe(1);
    expect(state.stopped).toBe(0);
    client.ws.close();
  });

  it('broadcasts a publish to every subscriber, once each', async () => {
    const { state, publisher } = makeTopic();
    const { url } = await boot(publisher);
    const alpha = await connect(url);
    const beta = await connect(url);

    alpha.send({ type: 'subscribe', topic: 'ticker' });
    beta.send({ type: 'subscribe', topic: 'ticker' });
    await alpha.next(); // snapshots
    await beta.next();
    expect(state.started).toBe(1); // second subscriber reuses the running publisher

    state.publish?.({ n: 42 });
    expect(await alpha.next()).toEqual({ type: 'event', topic: 'ticker', data: { n: 42 } });
    expect(await beta.next()).toEqual({ type: 'event', topic: 'ticker', data: { n: 42 } });
    alpha.ws.close();
    beta.ws.close();
  });

  it('stops the publisher when the last subscriber unsubscribes', async () => {
    const { state, publisher } = makeTopic();
    const { url } = await boot(publisher);
    const client = await connect(url);

    client.send({ type: 'subscribe', topic: 'ticker' });
    await client.next();
    client.send({ type: 'unsubscribe', topic: 'ticker' });
    await vi.waitFor(() => expect(state.stopped).toBe(1));
    client.ws.close();
  });

  it('a dropped connection releases its subscriptions (no unsubscribe frame ever sent)', async () => {
    const { state, publisher } = makeTopic();
    const { url } = await boot(publisher);
    const client = await connect(url);

    client.send({ type: 'subscribe', topic: 'ticker' });
    await client.next();
    client.ws.terminate(); // an abrupt vanish, not a close handshake
    await vi.waitFor(() => expect(state.stopped).toBe(1));
  });

  it('answers an unknown topic with an error frame and keeps the connection', async () => {
    const { publisher } = makeTopic();
    const { url } = await boot(publisher);
    const client = await connect(url);

    client.send({ type: 'subscribe', topic: 'nope' });
    expect(await client.next()).toEqual({ type: 'error', topic: 'nope', error: 'unknown topic' });
    // Still usable afterwards:
    client.send({ type: 'subscribe', topic: 'ticker' });
    expect(await client.next()).toMatchObject({ type: 'event', topic: 'ticker' });
    client.ws.close();
  });

  it('answers a malformed frame with an error frame', async () => {
    const { publisher } = makeTopic();
    const { url } = await boot(publisher);
    const client = await connect(url);

    client.ws.send('not json');
    expect(await client.next()).toMatchObject({ type: 'error' });
    client.ws.close();
  });

  it('rejects the handshake with 403 when the upgrade guard says no', async () => {
    const { publisher } = makeTopic();
    const { url } = await boot(publisher, () => false);

    const ws = new WebSocket(url);
    const status = await new Promise<number>((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error('handshake must not succeed')));
      ws.on('error', () => resolve(403)); // some paths surface only the error
    });
    expect(status).toBe(403);
  });

  it('destroys upgrades on any other path', async () => {
    const { publisher } = makeTopic();
    const { base } = await boot(publisher);

    const ws = new WebSocket(`${base}/api/v1/other`);
    await new Promise<void>((resolve, reject) => {
      ws.on('error', () => resolve());
      ws.on('open', () => reject(new Error('handshake must not succeed')));
    });
  });

  it('refuses an untrusted connection a topic that is not loopbackReadable', async () => {
    const { state, publisher } = makeTopic();
    const { url } = await boot(publisher, () => ({ trusted: false })); // admitted, not trusted
    const client = await connect(url);

    client.send({ type: 'subscribe', topic: 'ticker' }); // default topic — trusted-only
    expect(await client.next()).toEqual({ type: 'error', topic: 'ticker', error: 'forbidden topic' });
    expect(state.started).toBe(0); // never subscribed, so the publisher never started
    client.ws.close();
  });

  it('lets an untrusted connection subscribe to a loopbackReadable topic', async () => {
    const { state, publisher } = makeTopic({ ok: true });
    // Untrusted verdict, but the topic is flagged public (like `health`).
    const { url } = await boot(publisher, () => ({ trusted: false }), undefined, { loopbackReadable: true });
    const client = await connect(url);

    client.send({ type: 'subscribe', topic: 'ticker' });
    expect(await client.next()).toEqual({ type: 'event', topic: 'ticker', data: { ok: true } });
    expect(state.started).toBe(1);
    client.ws.close();
  });

  it('refuses a duplicate topic registration', () => {
    const hub = createSocketHub();
    const { publisher } = makeTopic();
    hub.registerTopic('ticker', publisher);
    expect(() => hub.registerTopic('ticker', publisher)).toThrow(/already registered/);
    hub.close();
  });

  it('refuses a second attach (it would orphan the first heartbeat interval)', async () => {
    const hub = createSocketHub();
    const server = createServer();
    servers.push(server);
    hubs.push(hub);
    hub.attach(server, () => ({ trusted: true }));
    expect(() => hub.attach(server, () => ({ trusted: true }))).toThrow(/already attached/);
  });

  it('emits an app-level heartbeat ping the client can watch', async () => {
    const { publisher } = makeTopic();
    const { url } = await boot(publisher, () => ({ trusted: true }), 40); // fast beat
    const client = await connect(url); // no subscription — heartbeat is connection-wide

    expect(await client.next()).toEqual({ type: 'ping' });
    client.ws.close();
  });

  it('reaps a client that stops answering the protocol ping', async () => {
    const { state, publisher } = makeTopic();
    const { url } = await boot(publisher, () => ({ trusted: true }), 40);
    // autoPong:false — this socket never answers the server's protocol ping, so after a beat
    // the hub considers it dead. It stays connected at the TCP level (a real silent-death would
    // too), which is exactly the case a FIN-based close would miss.
    const ws = new WebSocket(url, { autoPong: false });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    ws.on('message', () => undefined); // drain frames (snapshot + pings); we assert server-side
    ws.send(JSON.stringify({ type: 'subscribe', topic: 'ticker' }));

    await vi.waitFor(() => expect(state.started).toBe(1)); // subscription registered
    await vi.waitFor(() => expect(state.stopped).toBe(1), { timeout: 2_000 }); // …then reaped, releasing it
    ws.terminate();
  });
});

describe('verifyWsUpgrade', () => {
  const req = (headers: Record<string, string | undefined>) => ({ headers }) as IncomingMessage;

  // The guard reads deployment mode off the environment, and its whole Host half is SKIPPED in
  // hosted mode (a reverse proxy forwards the real public Host there). An ambient CEZ_REMOTE on
  // the dev box must not decide what this table sees — without this the suite passes only when
  // some earlier file in the same worker happened to delete the var.
  //
  // CEZ_AUTH is the same kind of global and is scrubbed for the same reason (it was added by the
  // auth change and initially was not): a leaked `CEZ_AUTH=oidc` from another file in this worker
  // flips every verdict below to `false`, because the principal check runs before the Origin
  // logic these cases are about. The auth-ON cases set it explicitly per test instead.
  const savedRemote = process.env.CEZ_REMOTE;
  const savedAuth = process.env.CEZ_AUTH;
  beforeEach(() => {
    delete process.env.CEZ_REMOTE;
    delete process.env.CEZ_AUTH;
  });
  afterEach(() => {
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    if (savedAuth === undefined) delete process.env.CEZ_AUTH;
    else process.env.CEZ_AUTH = savedAuth;
  });

  it('trusts a loopback Host with no Origin (non-browser client)', () => {
    expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321' }))).toEqual({ trusted: true });
  });

  it('trusts the cockpit itself (same-authority Origin)', () => {
    expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' }))).toEqual({
      trusted: true,
    });
  });

  it('admits the Vite dev proxy but UNtrusted without a Sec-Fetch vouch (Safari/Firefox)', () => {
    // Loopback Origin on another port, loopback Host, no Sec-Fetch-Site: indistinguishable from a
    // foreign local page, so it gets on the socket but may read only `loopbackReadable` topics.
    expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321', origin: 'http://localhost:5173' }))).toEqual({
      trusted: false,
    });
  });

  it('rejects a non-loopback Host — DNS rebinding (#426)', () => {
    expect(verifyWsUpgrade(req({ host: 'evil.com' }))).toBe(false);
    expect(verifyWsUpgrade(req({ host: '127.0.0.1.evil.com' }))).toBe(false);
  });

  it('rejects a missing Host', () => {
    expect(verifyWsUpgrade(req({}))).toBe(false);
  });

  it('rejects a non-loopback Origin', () => {
    expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321', origin: 'https://evil.com' }))).toBe(false);
  });

  it('rejects an opaque "null" Origin (sandboxed iframe, file://)', () => {
    expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321', origin: 'null' }))).toBe(false);
  });

  it('rejects a non-http(s) Origin even when its hostname is loopback', () => {
    // `hostnameOfOrigin` alone would hand back '127.0.0.1' here and pass the loopback test;
    // the scheme check in `authorityOfOrigin` is what keeps it out.
    expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321', origin: 'ftp://127.0.0.1' }))).toBe(false);
  });

  // Sec-Fetch-Site is honored WHEN PRESENT (Chromium sends it on a WS handshake and page JS
  // cannot forge it) and ignored when absent (Safari sends no Sec-Fetch-* at all, and the dev
  // proxy has to keep working there).
  it('rejects a cross-port loopback page that announces itself as same-site', () => {
    expect(
      verifyWsUpgrade(
        req({ host: '127.0.0.1:4321', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-site' }),
      ),
    ).toBe(false);
  });

  it('rejects an explicit cross-site handshake', () => {
    expect(
      verifyWsUpgrade(
        req({ host: '127.0.0.1:4321', origin: 'http://localhost:5173', 'sec-fetch-site': 'cross-site' }),
      ),
    ).toBe(false);
  });

  it('TRUSTS the Vite dev proxy when the browser vouches same-origin', () => {
    expect(
      verifyWsUpgrade(
        req({ host: '127.0.0.1:4321', origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' }),
      ),
    ).toEqual({ trusted: true });
  });

  it('the cockpit itself passes trusted on authority alone, whatever Sec-Fetch-Site says', () => {
    expect(
      verifyWsUpgrade(
        req({ host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321', 'sec-fetch-site': 'same-origin' }),
      ),
    ).toEqual({ trusted: true });
  });

  // ---- the principal check (D6) ---------------------------------------------------------------
  //
  // D6 asks for this by name: "this gets its own test asserting an unauthenticated upgrade is
  // refused — the negative control must exercise the socket, not the route beside it." The
  // WebSocket upgrade is attached to the RAW http server, so `app.use('/api/*', …)` never runs for
  // it; a cookie-authenticated fetch that passes while the socket does not check is the exact
  // bypass shape D6 exists to name. Every case above runs with `CEZ_AUTH` unset, i.e. entirely in
  // the `auth === 'none'` branch — which is why deleting the whole principal block left the suite
  // green until these existed.
  describe('when CEZ_AUTH names a provider', () => {
    /** A stand-in for `auth/session.ts`'s real resolver, recording what it was asked so a test can
     *  prove the SOCKET's cookie reached it rather than inferring it from the verdict. */
    const resolverFor = (accept: (cookie: string | undefined) => boolean) => {
      const seen: (string | undefined)[] = [];
      return {
        seen,
        resolver: {
          resolveFromCookieHeader: (cookie: string | undefined) => {
            seen.push(cookie);
            return accept(cookie)
              ? ({ kind: 'session', userId: 'u1', orgId: 'o1', teamId: 't1', role: 'member' } as const)
              : null;
          },
        },
      };
    };

    beforeEach(() => {
      process.env.CEZ_AUTH = 'oidc';
    });

    it('REFUSES an upgrade with no session cookie, on an otherwise perfect same-origin handshake', () => {
      const { resolver, seen } = resolverFor(() => false);
      // Identical to the "trusts the cockpit itself" case above in every respect but the session —
      // so a `false` here can only be the principal check, not the Host or Origin halves.
      expect(
        verifyWsUpgrade(req({ host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' }), undefined, resolver),
      ).toBe(false);
      expect(seen).toEqual([undefined]);
    });

    it('REFUSES an upgrade carrying a forged/expired cookie the resolver rejects', () => {
      const { resolver, seen } = resolverFor((cookie) => cookie === 'cez_session=good');
      expect(
        verifyWsUpgrade(
          req({ host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321', cookie: 'cez_session=forged' }),
          undefined,
          resolver,
        ),
      ).toBe(false);
      // The raw upgrade's own Cookie header is what was checked — not a value read from somewhere
      // else, and not a check that was skipped.
      expect(seen).toEqual(['cez_session=forged']);
    });

    it('REFUSES when no resolver was wired at all — a boot-wiring bug must fail closed, not open', () => {
      // `CEZ_AUTH` on with `deps.sessionResolver` undefined means `serveCommand` did not load
      // `auth/session.ts`. Admitting the socket "because there is nothing to check with" is the
      // fallback D1's boot refusal exists to rule out; this asserts the WS half does not reopen it.
      expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' }))).toBe(false);
    });

    it('REFUSES a no-Origin native client without a session — the auth check runs BEFORE the no-Origin trust', () => {
      // `origin === undefined` is trusted outright in the auth-off table above ("non-browser client
      // — no Origin to spoof"). Order matters: if the principal check ran after it, every
      // non-browser client would bypass auth entirely by simply omitting a header.
      const { resolver } = resolverFor(() => false);
      expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321' }), undefined, resolver)).toBe(false);
    });

    it('admits a valid session — the refusals above are not just "auth on means always false"', () => {
      const { resolver, seen } = resolverFor((cookie) => cookie === 'cez_session=good');
      expect(
        verifyWsUpgrade(
          req({ host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321', cookie: 'cez_session=good' }),
          undefined,
          resolver,
        ),
      ).toEqual({ trusted: true });
      expect(seen).toEqual(['cez_session=good']);
    });

    it('still applies the Origin rules to an authenticated socket — a session is not a bypass', () => {
      // Belt and braces in the other direction: a valid cookie must not readmit a foreign Origin.
      // Cookies ride along on a cross-site WebSocket handshake, so "signed in" and "same origin"
      // are independent facts and both still have to hold.
      const { resolver } = resolverFor(() => true);
      expect(
        verifyWsUpgrade(
          req({ host: '127.0.0.1:4321', origin: 'https://evil.com', cookie: 'cez_session=good' }),
          undefined,
          resolver,
        ),
      ).toBe(false);
    });

    it('is not fooled by CEZ_AUTH spellings that do not name a provider', () => {
      // `resolveAuthProvider` maps anything other than the two exact spellings to `'none'`, so a
      // typo must land on today's unauthenticated behaviour rather than half-enabling the check.
      process.env.CEZ_AUTH = 'OIDC';
      expect(verifyWsUpgrade(req({ host: '127.0.0.1:4321' }))).toEqual({ trusted: true });
    });
  });
});
