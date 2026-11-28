import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Script } from 'node:vm';
import { ApprovalHub } from '../src/hub.js';
import { LeaseManager } from '../src/leases.js';

process.env.LETTUCE_HOME = mkdtempSync(join(tmpdir(), 'lettuce-hub-'));

describe('ApprovalHub', () => {
  const leases = new LeaseManager();
  const hub = new ApprovalHub({ serverName: 'test', leases, openBrowser: false });
  const base = () => `http://127.0.0.1:${hub.port}`;
  const ask = hub.createApprovalHandler();

  before(() => hub.start());
  after(() => hub.close());

  const waiting = (timeoutMs = 5_000) =>
    ask({
      server: 'test',
      tool: 'push_files',
      args: {},
      rule: { tools: ['push_*'], action: 'ask', lease_options: ['once', '15m'] },
      timeoutMs,
    });

  const pendingId = async (): Promise<string> => {
    const res = await fetch(`${base()}/api/events?k=${hub.key}`);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    await reader.cancel();
    const text = new TextDecoder()
      .decode(value)
      .replace(/^data: /, '')
      .trim();
    return JSON.parse(text).pending[0].id;
  };

  const decide = (id: string, decision: string, key: string | null = hub.key) =>
    fetch(`${base()}/api/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Lettuce-Key': key } : {}) },
      body: JSON.stringify({ id, decision }),
    });

  it('serves the page with a strict content policy', async () => {
    const res = await fetch(`${base()}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });

  it('serves a page script that parses', async () => {
    const html = await (await fetch(`${base()}/`)).text();
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Script(script));
  });

  it('will not show what is waiting without the key', async () => {
    assert.equal((await fetch(`${base()}/api/events`)).status, 403);
    assert.equal((await fetch(`${base()}/api/events?k=wrong`)).status, 403);
  });

  it('will not let the agent approve itself without the key', async () => {
    const outcome = waiting();
    const id = await pendingId();
    assert.equal((await decide(id, 'once', null)).status, 403);
    assert.equal((await decide(id, 'once', 'guess')).status, 403);
    assert.equal((await decide(id, 'once')).status, 200);
    assert.deepEqual(await outcome, { approved: true, mode: 'once' });
  });

  it('refuses a time limit the rule did not offer', async () => {
    const outcome = waiting();
    const id = await pendingId();
    assert.equal((await decide(id, 'lease:999h')).status, 400);
    assert.equal((await decide(id, 'lease:15m')).status, 200);
    assert.deepEqual(await outcome, { approved: true, mode: 'lease', duration: '15m' });
  });

  it('refuses Allow once when the rule did not offer it', async () => {
    const outcome = ask({
      server: 'test',
      tool: 'push_files',
      args: {},
      rule: { tools: ['push_*'], action: 'ask', lease_options: ['15m'] },
      timeoutMs: 5_000,
    });
    const id = await pendingId();
    assert.equal((await decide(id, 'once')).status, 400);
    assert.equal((await decide(id, 'deny')).status, 200);
    assert.equal((await outcome).approved, false);
  });

  it('refuses a plain form post from another site', async () => {
    const res = await fetch(`${base()}/api/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'X-Lettuce-Key': hub.key },
      body: '{}',
    });
    assert.equal(res.status, 415);
  });

  it('refuses requests addressed to another host name', async () => {
    const status = await new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port: hub.port, path: '/', headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).end();
    });
    assert.equal(status, 403);
  });

  it('denies when nobody answers in time', async () => {
    assert.equal((await waiting(50)).approved, false);
  });

  it('revokes only with the revoke header', async () => {
    leases.grant({ server: 'test', toolPattern: 'push_*', duration: '1h' });
    assert.equal((await fetch(`${base()}/api/revoke`, { method: 'POST' })).status, 403);
    const res = await fetch(`${base()}/api/revoke`, { method: 'POST', headers: { 'X-Lettuce': 'revoke' } });
    assert.deepEqual(await res.json(), { ok: true, revokedCount: 1 });
    assert.equal(leases.listActive().length, 0);
  });
});
