// A tiny MCP server over stdio for tests: three tools, and every call echoes its name.
import { createInterface } from 'node:readline';

const tools = [{ name: 'list_things' }, { name: 'create_thing' }, { name: 'delete_thing' }];
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (Array.isArray(msg)) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'batch', result: { ranBatch: true } }) + '\n');
    return;
  }
  if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools } }) + '\n');
  } else if (msg.method === 'tools/call') {
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { called: msg.params.name } }) + '\n',
    );
  }
});
