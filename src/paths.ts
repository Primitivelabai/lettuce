import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where lettuce keeps its receipts, default policy, saved secrets and running-hub list. */
export function stateDir(): string {
  return process.env.LETTUCE_HOME ?? join(homedir(), '.lettuce');
}

export const receiptsPath = (): string => join(stateDir(), 'receipts.jsonl');
export const defaultPolicyPath = (): string => join(stateDir(), 'default.yaml');
export const hubsDir = (): string => join(stateDir(), 'hubs');
export const secretsDir = (): string => join(stateDir(), 'secrets');
