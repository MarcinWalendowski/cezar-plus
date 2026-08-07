import { describe, expect, it } from 'vitest';
import {
  CEZAR_CONNECTION_UPGRADE_VAR,
  orgVhost,
  supervisorVhost,
  wsUpgradeMapSnippet,
} from './nginx.ts';
import { X_CEZAR_PRINCIPAL_HEADER, X_CEZAR_SIGNATURE_HEADER } from '../../../supervisor/forwarded-principal.ts';

const orgOpts = { hostname: 'acme.cezar.example.com', orgPort: 4001, supervisorPort: 4000 };
const supervisorOpts = { hostname: 'login.cezar.example.com', supervisorPort: 4000 };

/** `$upstream_http_<header, dashes as underscores>` derived from the SAME constants the generator
 *  imports, never hand-spelled — a header rename in `forwarded-principal.ts` must fail this test,
 *  not silently stop matching. */
function upstreamHttpVar(headerName: string): string {
  return `$upstream_http_${headerName.replace(/-/g, '_')}`;
}

describe('wsUpgradeMapSnippet', () => {
  it('declares the shared Connection-upgrade map exactly once, in http{} context', () => {
    const snippet = wsUpgradeMapSnippet();
    expect(snippet).toContain(`map $http_upgrade ${CEZAR_CONNECTION_UPGRADE_VAR.slice(1)} {`);
    expect(snippet).toContain('default upgrade;');
    // Never wrapped in its own server{} block — that would put it in the wrong nginx context.
    expect(snippet).not.toContain('server {');
  });
});

describe('supervisorVhost', () => {
  it('routes the one login host to the supervisor loopback port', () => {
    const vhost = supervisorVhost(supervisorOpts);
    expect(vhost).toContain('server_name login.cezar.example.com;');
    expect(vhost).toContain('proxy_pass http://127.0.0.1:4000;');
  });

  it('has no auth_basic — the supervisor terminates OIDC/Google itself', () => {
    expect(supervisorVhost(supervisorOpts)).not.toContain('auth_basic');
  });

  it('forwards Host unmodified and proxies the WebSocket upgrade', () => {
    const vhost = supervisorVhost(supervisorOpts);
    expect(vhost).toContain('proxy_set_header Host $host;');
    expect(vhost).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(vhost).toContain(`proxy_set_header Connection ${CEZAR_CONNECTION_UPGRADE_VAR};`);
  });

  it('enables HTTP/2 and never buffers (SSE)', () => {
    const vhost = supervisorVhost(supervisorOpts);
    expect(vhost).toContain('http2 on;');
    expect(vhost).toContain('proxy_buffering off;');
  });

  it('rejects a hostname that could break out of the generated config', () => {
    expect(() => supervisorVhost({ ...supervisorOpts, hostname: 'evil; }\nserver {' })).toThrow();
  });

  it('rejects an out-of-range port', () => {
    expect(() => supervisorVhost({ ...supervisorOpts, supervisorPort: 0 })).toThrow();
    expect(() => supervisorVhost({ ...supervisorOpts, supervisorPort: 70000 })).toThrow();
  });
});

describe('orgVhost', () => {
  it('routes this org\'s hostname to ITS OWN loopback port, not the supervisor\'s', () => {
    const vhost = orgVhost(orgOpts);
    expect(vhost).toContain('server_name acme.cezar.example.com;');
    expect(vhost).toContain('proxy_pass http://127.0.0.1:4001;'); // location /
  });

  it('has no auth_basic — D10/D9: OIDC via the supervisor replaces it for this platform', () => {
    expect(orgVhost(orgOpts)).not.toContain('auth_basic');
  });

  it('/auth/ and /internal/ both go to the SUPERVISOR loopback port, not this org\'s', () => {
    const vhost = orgVhost(orgOpts);
    const authBlock = vhost.slice(vhost.indexOf('location /auth/'), vhost.indexOf('location /auth/') + 400);
    expect(authBlock).toContain('proxy_pass http://127.0.0.1:4000;');
    const internalBlock = vhost.slice(vhost.indexOf('location /internal/'), vhost.indexOf('location /internal/') + 400);
    expect(internalBlock).toContain('proxy_pass http://127.0.0.1:4000;');
  });

  it('/internal/ is marked internal; — unreachable by a direct external request', () => {
    const vhost = orgVhost(orgOpts);
    const internalBlock = vhost.slice(vhost.indexOf('location /internal/'), vhost.indexOf('location /auth/'));
    expect(internalBlock).toContain('internal;');
  });

  it('/auth/ is NOT gated by auth_request — the login route cannot require an existing session', () => {
    const vhost = orgVhost(orgOpts);
    const authBlock = vhost.slice(vhost.indexOf('location /auth/'), vhost.indexOf('location /', vhost.indexOf('location /auth/') + 1));
    expect(authBlock).not.toContain('auth_request');
  });

  it('gates / behind auth_request against the supervisor\'s /internal/auth-check', () => {
    const vhost = orgVhost(orgOpts);
    const rootBlock = vhost.slice(vhost.lastIndexOf('location /'));
    expect(rootBlock).toContain('auth_request /internal/auth-check;');
  });

  it('captures and forwards the REAL forwarded-principal headers, derived not hand-spelled', () => {
    const vhost = orgVhost(orgOpts);
    expect(vhost).toContain(`auth_request_set $cezar_principal ${upstreamHttpVar(X_CEZAR_PRINCIPAL_HEADER)};`);
    expect(vhost).toContain(`auth_request_set $cezar_principal_sig ${upstreamHttpVar(X_CEZAR_SIGNATURE_HEADER)};`);
    expect(vhost).toContain(`proxy_set_header ${X_CEZAR_PRINCIPAL_HEADER} $cezar_principal;`);
    expect(vhost).toContain(`proxy_set_header ${X_CEZAR_SIGNATURE_HEADER} $cezar_principal_sig;`);
  });

  it('forwards Host/Origin-relevant headers unmodified so verifyWsUpgrade sees the real request', () => {
    const vhost = orgVhost(orgOpts);
    const rootBlock = vhost.slice(vhost.lastIndexOf('location /'));
    // Host must be the browser's own — never rewritten to the org's own loopback authority.
    expect(rootBlock).toContain('proxy_set_header Host $host;');
    expect(rootBlock).not.toMatch(/proxy_set_header Host 127\.0\.0\.1/);
  });

  it('proxies the WebSocket upgrade on the same location that serves the API and SSE', () => {
    const vhost = orgVhost(orgOpts);
    const rootBlock = vhost.slice(vhost.lastIndexOf('location /'));
    expect(rootBlock).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(rootBlock).toContain(`proxy_set_header Connection ${CEZAR_CONNECTION_UPGRADE_VAR};`);
    expect(rootBlock).toContain('proxy_buffering off;');
  });

  it('rejects a hostname that could break out of the generated config', () => {
    expect(() => orgVhost({ ...orgOpts, hostname: 'acme"; }\nserver {' })).toThrow();
  });

  it('rejects an out-of-range org or supervisor port', () => {
    expect(() => orgVhost({ ...orgOpts, orgPort: -1 })).toThrow();
    expect(() => orgVhost({ ...orgOpts, supervisorPort: 99999 })).toThrow();
  });
});
