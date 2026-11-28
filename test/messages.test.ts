import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkHostMessage } from '../src/proxy.js';

describe('checkHostMessage', () => {
  const kind = (m: unknown) => checkHostMessage(m).kind;

  it('passes standard MCP requests and notifications', () => {
    assert.equal(kind({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }), 'forward');
    assert.equal(kind({ jsonrpc: '2.0', id: 'a', method: 'tools/list' }), 'forward');
    assert.equal(kind({ jsonrpc: '2.0', method: 'notifications/initialized' }), 'forward');
  });

  it('passes replies to requests the server sent', () => {
    assert.equal(kind({ jsonrpc: '2.0', id: 3, result: {} }), 'forward');
    assert.equal(kind({ jsonrpc: '2.0', id: 3, error: { code: 1, message: 'x' } }), 'forward');
  });

  it('turns tools/call into a policy check', () => {
    const c = checkHostMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } });
    assert.equal(c.kind, 'call');
    if (c.kind === 'call') assert.deepEqual(c.args, {});
  });

  it('refuses everything else', () => {
    for (const m of [
      [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x' } }],
      { id: 1, method: 'tools/list' },
      { jsonrpc: '1.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: null, method: 'tools/list' },
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'x' } },
      { jsonrpc: '2.0', id: {}, method: 'tools/call', params: { name: 'x' } },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} },
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: 'rm -rf' } },
      { jsonrpc: '2.0', id: 1, method: 'custom/run' },
      { jsonrpc: '2.0', id: 1, method: 'notifications/x' },
      { jsonrpc: '2.0', id: 1, result: {}, error: {} },
      { jsonrpc: '2.0', result: {} },
      'tools/call',
      null,
    ]) {
      assert.equal(kind(m), 'reject', JSON.stringify(m));
    }
  });
});
