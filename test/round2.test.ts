import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LeaseManager } from '../src/leases.js';
import { PolicyEvaluator } from '../src/policy.js';
import { checkHostMessage, McpStdioProxy, type ApprovalOutcome } from '../src/proxy.js';
import { ReceiptLedger } from '../src/receipts.js';
import { SecretVault } from '../src/secrets.js';
import type { JsonRpcMessage } from '../src/types.js';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `lettuce-${p}-`));

describe('hiding tools', () => {
  it('hides tools no rule allows when the default is never', () => {
    const dir = tmp('hide');
    const path = join(dir, 'lettuce.yaml');
    writeFileSync(path, 'default_action: never\nrules:\n  - tools: ["list_*"]\n    action: allow\n');
    const p = new PolicyEvaluator(path);
    assert.equal(p.isToolHidden('list_things'), false);
    assert.equal(p.isToolHidden('create_thing'), true);
  });
});

describe('message envelopes', () => {
  const kind = (m: unknown) => checkHostMessage(m).kind;

  it('passes only the client notifications MCP defines', () => {
    assert.equal(
      kind({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
      'forward',
    );
    assert.equal(
      kind({ jsonrpc: '2.0', method: 'notifications/tools/call', params: { name: 'x' } }),
      'reject',
    );
  });

  it('refuses a known method with a broken envelope', () => {
    assert.equal(kind({ jsonrpc: '2.0', id: 1, method: 'initialize', params: 'x' }), 'reject');
    assert.equal(kind({ jsonrpc: '2.0', id: 1, method: 'tools/list', result: {} }), 'reject');
  });
});

describe('policy changes while a request waits', () => {
  type Internals = {
    handleToolCall(
      call: { msg: JsonRpcMessage; id: number; tool: string; args: Record<string, unknown> },
      up: (m: JsonRpcMessage) => void,
      host: (m: JsonRpcMessage) => void,
    ): Promise<void>;
  };

  const run = async (afterApproval: string, outcome: ApprovalOutcome) => {
    const dir = tmp('race');
    const path = join(dir, 'lettuce.yaml');
    writeFileSync(
      path,
      'rules:\n  - tools: ["push_*"]\n    action: ask\n    lease_options: ["once", "15m"]\n',
    );
    const policy = new PolicyEvaluator(path);
    const proxy = new McpStdioProxy({
      serverName: 's',
      agentName: 'a',
      upstreamCommand: 'unused',
      upstreamArgs: [],
      policy,
      leases: new LeaseManager(),
      ledger: new ReceiptLedger(join(dir, 'r.jsonl')),
      onApprovalNeeded: async () => {
        writeFileSync(path, afterApproval);
        utimesSync(path, new Date(), new Date(Date.now() + 5_000));
        return outcome;
      },
    });
    const sentUp: JsonRpcMessage[] = [];
    const toHost: JsonRpcMessage[] = [];
    const msg: JsonRpcMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'push_files' },
    };
    await (proxy as unknown as Internals).handleToolCall(
      { msg, id: 1, tool: 'push_files', args: {} },
      (m) => sentUp.push(m),
      (m) => toHost.push(m),
    );
    return { sentUp, toHost };
  };

  it('does not run an approved call that is now never', async () => {
    const r = await run('rules:\n  - tools: ["push_*"]\n    action: never\n', {
      approved: true,
      mode: 'once',
    });
    assert.equal(r.sentUp.length, 0);
    assert.match(r.toHost[0].error?.message ?? '', /policy changed/);
  });

  it('does not run an approved call while the policy is broken', async () => {
    const r = await run('rules: [broken', { approved: true, mode: 'once' });
    assert.equal(r.sentUp.length, 0);
  });

  it('does not grant a time limit the policy stopped offering', async () => {
    const r = await run('rules:\n  - tools: ["push_*"]\n    action: ask\n    lease_options: ["once"]\n', {
      approved: true,
      mode: 'lease',
      duration: '15m',
    });
    assert.equal(r.sentUp.length, 0);
    assert.match(r.toHost[0].error?.message ?? '', /no longer offers/);
  });

  it('still runs when the policy did not change in a way that matters', async () => {
    const r = await run(
      'rules:\n  - tools: ["push_*"]\n    action: ask\n    lease_options: ["once", "15m"]\n',
      {
        approved: true,
        mode: 'lease',
        duration: '15m',
      },
    );
    assert.equal(r.sentUp.length, 1);
  });
});

describe('secrets in JSON output', () => {
  it('hides a secret written inside a JSON string', async () => {
    const secret = 'ab"c\\d';
    const t = SecretVault.createRedactingTransform([secret]);
    let out = '';
    t.on('data', (c) => (out += c));
    t.end(JSON.stringify({ token: secret }));
    await new Promise((r) => t.on('end', r));
    assert.equal(out.includes(JSON.stringify(secret).slice(1, -1)), false);
    assert.match(out, /hidden by lettuce/);
  });
});

describe('stale receipt locks', () => {
  it('takes over a lock whose owner has died', () => {
    const dir = tmp('lock');
    const path = join(dir, 'r.jsonl');
    writeFileSync(`${path}.lock`, '2147483646:deadbeef');
    const ledger = new ReceiptLedger(path);
    ledger.record({ agent: 'a', server: 's', tool: 't', args: {}, decision: 'allowed_by_policy' });
    assert.equal(ReceiptLedger.verifyChain(path).count, 1);
    assert.equal(existsSync(`${path}.lock`), false);
  });

  it('waits for a lock whose owner is alive, then gives up', () => {
    const dir = tmp('lock');
    const path = join(dir, 'r.jsonl');
    writeFileSync(`${path}.lock`, `${process.pid}:someone-else`);
    const ledger = new ReceiptLedger(path);
    assert.throws(
      () => ledger.record({ agent: 'a', server: 's', tool: 't', args: {}, decision: 'allowed_by_policy' }),
      /locked/,
    );
    assert.equal(existsSync(`${path}.lock`), true);
  });
});
