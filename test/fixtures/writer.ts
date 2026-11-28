// Writes receipts from a separate process, for the concurrent-writer test.
import { ReceiptLedger } from '../../src/receipts.js';

const [path, name, count] = process.argv.slice(2);
const ledger = new ReceiptLedger(path);
for (let i = 0; i < Number(count); i++) {
  ledger.record({ agent: name, server: name, tool: 't', args: { i }, decision: 'allowed_by_policy' });
}
