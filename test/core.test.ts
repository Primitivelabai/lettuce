import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { LeaseManager } from '../src/leases.js';
import { PolicyEvaluator } from '../src/policy.js';
import { ReceiptLedger } from '../src/receipts.js';
import { macAddCommand, SecretVault } from '../src/secrets.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `lettuce-${p}-`));

describe('LeaseManager', () => {
  it('stops after the call cap', () => {
    const leases = new LeaseManager();
    const lease = leases.grant({ server: 'gh', toolPattern: 'create_*', duration: '15m', maxCalls: 2 });
    assert.equal(leases.tryConsume('gh', 'create_pull_request')?.id, lease.id);
    assert.equal(leases.tryConsume('gh', 'create_issue')?.id, lease.id);
    assert.equal(leases.tryConsume('gh', 'create_pull_request'), null);
  });

  it('only applies to its own server', () => {
    const leases = new LeaseManager();
    leases.grant({ server: 'gh', toolPattern: 'push_*', duration: '1h' });
    assert.equal(leases.tryConsume('other', 'push_files'), null);
  });

  it('refuses a zero or broken call cap', () => {
    const leases = new LeaseManager();
    assert.throws(() => leases.grant({ server: 'gh', toolPattern: 'x', duration: '1m', maxCalls: 0 }));
    assert.throws(() =>
      leases.grant({
        server: 'gh',
        toolPattern: 'x',
        duration: '1m',
        maxCalls: 'bogus' as unknown as number,
      }),
    );
  });

  it('refuses zero, endless and huge lease lengths', () => {
    const leases = new LeaseManager();
    for (const duration of ['0s', '99999999999999999999h', '31d', '800h']) {
      assert.throws(() => leases.grant({ server: 'gh', toolPattern: 'x', duration }), Error, duration);
    }
  });

  it('revokes at once', () => {
    const leases = new LeaseManager();
    leases.grant({ server: 'gh', toolPattern: 'push_*', duration: '1h' });
    assert.equal(leases.revokeAll().length, 1);
    assert.equal(leases.tryConsume('gh', 'push_files'), null);
  });
});

describe('PolicyEvaluator', () => {
  const write = (yaml: string) => {
    const path = join(tmp('policy'), 'lettuce.yaml');
    writeFileSync(path, yaml);
    return path;
  };

  it('never beats ask beats allow', () => {
    const p = new PolicyEvaluator(
      write(
        [
          'version: 1',
          'default_action: allow',
          'rules:',
          '  - tools: ["*"]',
          '    action: allow',
          '  - tools: ["create_*"]',
          '    action: ask',
          '  - tools: ["create_admin"]',
          '    action: never',
        ].join('\n'),
      ),
    );
    assert.equal(p.evaluate('read_file').action, 'allow');
    assert.equal(p.evaluate('create_issue').action, 'ask');
    assert.equal(p.evaluate('create_admin').action, 'never');
    assert.equal(p.isToolHidden('create_admin'), true);
  });

  it('refuses a typo in an action instead of falling through', () => {
    assert.throws(
      () => new PolicyEvaluator(write('rules:\n  - tools: ["delete_*"]\n    action: Never\n')),
      /action must be/,
    );
  });

  it('refuses a call cap that is not a whole number', () => {
    for (const cap of ['bogus', '0', '1.5']) {
      const yaml = 'rules:\n  - tools: ["x"]\n    action: ask\n    max_calls_per_lease: ' + cap + '\n';
      assert.throws(() => new PolicyEvaluator(write(yaml)), /max_calls_per_lease/);
    }
  });

  it('refuses a bad lease length', () => {
    assert.throws(
      () =>
        new PolicyEvaluator(
          write('rules:\n  - tools: ["x"]\n    action: ask\n    lease_options: ["forever"]\n'),
        ),
      /Invalid duration/,
    );
  });
});

describe('ReceiptLedger', () => {
  it('keeps one chain and spots an edit', () => {
    const path = join(tmp('receipts'), 'r.jsonl');
    const ledger = new ReceiptLedger(path);
    ledger.record({ agent: 'a', server: 's', tool: 'list', args: { q: 1 }, decision: 'allowed_by_policy' });
    ledger.record({
      agent: 'a',
      server: 's',
      tool: 'push',
      args: {},
      decision: 'approved_once',
      lease_id: undefined,
    });
    assert.equal(ReceiptLedger.verifyChain(path).valid, true);

    const lines = readFileSync(path, 'utf8').trim().split('\n');
    lines[0] = lines[0].replace('allowed_by_policy', 'denied_by_policy');
    writeFileSync(path, lines.join('\n') + '\n');
    assert.equal(ReceiptLedger.verifyChain(path).valid, false);
  });

  it('stays one chain with several processes writing at once', async () => {
    const path = join(tmp('receipts'), 'r.jsonl');
    const writer = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'writer.js');
    await Promise.all(
      ['a', 'b', 'c', 'd'].map(
        (name) =>
          new Promise<void>((resolve, reject) =>
            execFile(process.execPath, [writer, path, name, '25'], (err) => (err ? reject(err) : resolve())),
          ),
      ),
    );
    const result = ReceiptLedger.verifyChain(path);
    assert.equal(result.valid, true, result.reason);
    assert.equal(result.count, 100);
  });

  it('catches entries removed from the end with a saved hash', () => {
    const path = join(tmp('receipts'), 'r.jsonl');
    const ledger = new ReceiptLedger(path);
    for (let i = 0; i < 3; i++) {
      ledger.record({ agent: 'a', server: 's', tool: 't', args: { i }, decision: 'allowed_by_policy' });
    }
    const saved = ReceiptLedger.verifyChain(path).lastHash!;
    assert.equal(ReceiptLedger.verifyChain(path, saved).valid, true);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, lines.slice(0, 2).join('\n') + '\n');
    assert.equal(ReceiptLedger.verifyChain(path).valid, true);
    assert.equal(ReceiptLedger.verifyChain(path, saved).valid, false);
    writeFileSync(path, '');
    assert.equal(ReceiptLedger.verifyChain(path, saved).valid, false);
  });

  it('stays one chain when two servers write to the same file', () => {
    const path = join(tmp('receipts'), 'r.jsonl');
    const a = new ReceiptLedger(path);
    const b = new ReceiptLedger(path);
    for (let i = 0; i < 5; i++) {
      a.record({ agent: 'a', server: 'one', tool: 't', args: { i }, decision: 'allowed_by_policy' });
      b.record({ agent: 'b', server: 'two', tool: 't', args: { i }, decision: 'allowed_by_policy' });
    }
    const result = ReceiptLedger.verifyChain(path);
    assert.equal(result.valid, true);
    assert.equal(result.count, 10);
  });

  it('spots a removed entry', () => {
    const path = join(tmp('receipts'), 'r.jsonl');
    const ledger = new ReceiptLedger(path);
    for (let i = 0; i < 3; i++) {
      ledger.record({ agent: 'a', server: 's', tool: 't', args: { i }, decision: 'allowed_by_policy' });
    }
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, [lines[0], lines[2]].join('\n') + '\n');
    assert.equal(ReceiptLedger.verifyChain(path).valid, false);
  });
});

describe('secrets', () => {
  it('sends the macOS value as hex on stdin, never as an argument', () => {
    const value = 'p@ss "word"';
    assert.equal(
      macAddCommand('lettuce', 'github-token', value),
      `add-generic-password -U -s lettuce -a github-token -X ${Buffer.from(value).toString('hex')}\n`,
    );
  });

  it('refuses names that could change the command', () => {
    assert.throws(() => macAddCommand('lettuce', 'x -w evil', 'v'), /Invalid account/);
  });

  it('hides short secrets too', () => {
    const { secretValues } = SecretVault.resolveEnvMap({ PIN: '1234' });
    assert.deepEqual(secretValues, ['1234']);
  });

  it('hides a secret even when it is split across two chunks', async () => {
    const t = SecretVault.createRedactingTransform(['supersecret123']);
    let out = '';
    t.on('data', (c) => (out += c));
    t.write('token=supers');
    t.write('ecret123 done');
    t.end();
    await new Promise((r) => t.on('end', r));
    assert.equal(out.includes('supersecret123'), false);
    assert.match(out, /hidden by lettuce/);
    assert.match(out, /done$/);
  });

  it('saves and reads back on Windows', { skip: process.platform !== 'win32' }, () => {
    const home = tmp('home');
    process.env.LETTUCE_HOME = home;
    try {
      SecretVault.setSecret('lettuce', 'test-token', 'héllo "world" & more');
      assert.equal(SecretVault.getSecret('lettuce', 'test-token'), 'héllo "world" & more');
      const onDisk = readFileSync(join(home, 'secrets', 'lettuce.test-token.dpapi'), 'utf8');
      assert.equal(onDisk.includes('world'), false);
    } finally {
      delete process.env.LETTUCE_HOME;
    }
  });
});
