import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ReceiptLedger } from '../src/receipts.js';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'src', 'cli.js');
const fake = join(here, 'fixtures', 'fake-server.js');

interface Reply {
  id: unknown;
  result?: Record<string, unknown> & { tools?: Array<{ name: string }> };
  error?: { code: number; message: string };
}

describe('lettuce wrap', () => {
  const home = mkdtempSync(join(tmpdir(), 'lettuce-proxy-'));
  const policy = join(home, 'lettuce.yaml');
  let child: ChildProcessWithoutNullStreams;
  const waiters = new Map<unknown, (msg: Reply) => void>();

  before(() => {
    writeFileSync(
      policy,
      [
        'version: 1',
        'default_action: ask',
        'approval_timeout_ms: 200',
        'rules:',
        '  - tools: ["list_*"]',
        '    action: allow',
        '  - tools: ["create_*"]',
        '    action: ask',
        '  - tools: ["delete_*"]',
        '    action: never',
      ].join('\n'),
    );
    child = spawn(
      process.execPath,
      [cli, 'wrap', '--policy', policy, '--name', 'fake', '--', process.execPath, fake],
      { env: { ...process.env, LETTUCE_HOME: home, LETTUCE_NO_BROWSER: '1' } },
    );
    createInterface({ input: child.stdout }).on('line', (line) => {
      const msg = JSON.parse(line) as Reply;
      waiters.get(msg.id)?.(msg);
    });
  });

  after(() => child.kill());

  const send = (msg: unknown, id: unknown): Promise<Reply> =>
    new Promise((resolve) => {
      waiters.set(id, resolve);
      child.stdin.write(JSON.stringify(msg) + '\n');
    });
  const call = (id: number, name: string) =>
    send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: {} } }, id);

  it('hides never tools from the list', async () => {
    const res = await send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 1);
    assert.deepEqual(
      res.result?.tools?.map((t) => t.name),
      ['list_things', 'create_thing'],
    );
  });

  it('runs allowed tools', async () => {
    assert.deepEqual((await call(2, 'list_things')).result, { called: 'list_things' });
  });

  it('blocks never tools even when called by name', async () => {
    assert.match((await call(3, 'delete_thing')).error?.message ?? '', /denied/);
  });

  it('denies an ask tool when nobody answers', async () => {
    assert.match((await call(4, 'create_thing')).error?.message ?? '', /timed out/);
  });

  it('refuses a batch instead of passing it through', async () => {
    const res = await send(
      [{ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'delete_thing' } }],
      null,
    );
    assert.equal(res.error?.code, -32600);
  });

  it('refuses methods it does not know', async () => {
    const res = await send({ jsonrpc: '2.0', id: 6, method: 'admin/wipe' }, 6);
    assert.equal(res.error?.code, -32601);
  });

  it('refuses a tools/list without an id', async () => {
    const res = await send({ jsonrpc: '2.0', id: null, method: 'tools/list' }, null);
    assert.equal(res.error?.code, -32600);
  });

  it('refuses a tools/call with bad arguments', async () => {
    const res = await send(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_things', arguments: [1] } },
      7,
    );
    assert.equal(res.error?.code, -32602);
  });

  it('denies every call while the policy file is broken, then recovers', async () => {
    const good = readFileSync(policy, 'utf8');
    writeFileSync(policy, 'rules: [this is not valid');
    utimesSync(policy, new Date(), new Date(Date.now() + 5_000));
    assert.match((await call(8, 'list_things')).error?.message ?? '', /policy has an error/);
    writeFileSync(policy, good);
    utimesSync(policy, new Date(), new Date(Date.now() + 10_000));
    assert.deepEqual((await call(9, 'list_things')).result, { called: 'list_things' });
  });

  it('writes an unbroken receipt for every decision', () => {
    const result = ReceiptLedger.verifyChain(join(home, 'receipts.jsonl'));
    assert.equal(result.valid, true);
    // list, delete, create, batch, unknown method, null id, bad args, broken policy, list again
    assert.equal(result.count, 9);
  });
});
