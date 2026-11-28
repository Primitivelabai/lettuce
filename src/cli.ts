#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watchFile, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { ApprovalHub } from './hub.js';
import { LeaseManager } from './leases.js';
import { defaultPolicyPath, hubsDir, receiptsPath } from './paths.js';
import { PolicyEvaluator } from './policy.js';
import { McpStdioProxy } from './proxy.js';
import { ReceiptLedger } from './receipts.js';
import { SecretVault } from './secrets.js';
import type { ReceiptEntry } from './types.js';

const POLICY_FILE = 'lettuce.yaml';

const STARTER_POLICY_YAML = `version: 1
default_action: ask
approval_timeout_ms: 60000

# Optional: load tokens from your OS keychain instead of writing them in .mcp.json
# Save one with: npx lettuce-mcp secret set github-token
# secrets:
#   GITHUB_PERSONAL_ACCESS_TOKEN: "keychain://lettuce/github-token"

rules:
  # Reading runs without asking, and is still written to the receipts.
  - tools: ["get_*", "list_*", "read_*", "search_*"]
    action: allow

  # Changes wait for you. Allow once, or for a while.
  - tools: ["create_*", "update_*", "push_*", "write_*"]
    action: ask
    lease_options: ["once", "15m", "1h"]
    max_calls_per_lease: 5

  # Never: hidden from the agent and blocked.
  - tools: ["delete_*", "drop_*", "destroy_*"]
    action: never
`;

const HELP = `lettuce: let us check before your agent acts.

  lettuce init                                    Make a starter lettuce.yaml here
  lettuce demo                                    Try an approval in your browser
  lettuce wrap [--policy file] [--name n] -- <cmd> [args]
                                                  Wrap an MCP server that runs over stdio
  lettuce secret set <name>                       Save a token in your OS keychain
  lettuce receipts [--tail]                       Show recent decisions
  lettuce verify [--since <hash>]                 Check the receipts haven't been edited
  lettuce revoke                                  End every active approval now
`;

function ensureDefaultPolicy(): string {
  const path = defaultPolicyPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, STARTER_POLICY_YAML, 'utf8');
  }
  return path;
}

function runInit(): void {
  if (existsSync(POLICY_FILE)) {
    console.error(`${POLICY_FILE} already exists here.`);
    process.exit(1);
  }
  writeFileSync(POLICY_FILE, STARTER_POLICY_YAML, 'utf8');
  console.log(`Made ${POLICY_FILE}.`);
}

async function runSecret(args: string[]): Promise<void> {
  const [sub, name] = args;
  if (sub !== 'set' || !name) {
    console.error('Usage: lettuce secret set <name>');
    process.exit(1);
  }

  const value = await readHidden(`Paste the value for "${name}" (it won't show): `);
  if (!value) {
    console.error('Nothing saved: the value was empty.');
    process.exit(1);
  }

  SecretVault.setSecret('lettuce', name, value);
  console.log(`Saved. Use it in ${POLICY_FILE} as "keychain://lettuce/${name}"`);
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: Boolean(process.stdin.isTTY),
    });
    const out = rl as unknown as { _writeToOutput?: (s: string) => void };
    process.stdout.write(prompt);
    out._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.replace(/\r?\n$/, ''));
    });
  });
}

function runReceipts(args: string[]): void {
  const path = receiptsPath();
  if (!existsSync(path)) {
    console.log('No receipts yet.');
    return;
  }

  const printLine = (line: string) => {
    if (!line.trim()) return;
    const r = JSON.parse(line) as ReceiptEntry;
    const leaseTag = r.lease_id ? ` [${r.lease_id}]` : '';
    console.log(`#${r.seq} ${r.ts} | ${r.server} -> ${r.tool} | ${r.decision}${leaseTag}`);
  };

  const raw = readFileSync(path, 'utf8').trim();
  for (const line of (raw ? raw.split('\n') : []).slice(-20)) printLine(line);

  if (args.includes('--tail') || args.includes('-f')) {
    let offset = Buffer.byteLength(readFileSync(path, 'utf8'));
    watchFile(path, { interval: 400 }, () => {
      const current = readFileSync(path);
      if (current.length > offset) {
        for (const line of current.subarray(offset).toString('utf8').split('\n')) printLine(line);
        offset = current.length;
      }
    });
  }
}

async function runWrap(args: string[]): Promise<void> {
  const dashDashIdx = args.indexOf('--');
  if (dashDashIdx === -1 || dashDashIdx === args.length - 1) {
    process.stderr.write(
      'Usage: lettuce wrap [--policy ./lettuce.yaml] [--name github] -- <command> [args...]\n',
    );
    process.exit(1);
  }

  const flagArgs = args.slice(0, dashDashIdx);
  const upstreamCmd = args[dashDashIdx + 1];
  const upstreamArgs = args.slice(dashDashIdx + 2);

  let policyPath = '';
  let serverName = upstreamCmd;
  let agentName = process.env.LETTUCE_AGENT ?? 'mcp-client';

  for (let i = 0; i < flagArgs.length; i++) {
    if (flagArgs[i] === '--policy' && flagArgs[i + 1]) policyPath = flagArgs[++i];
    else if (flagArgs[i] === '--name' && flagArgs[i + 1]) serverName = flagArgs[++i];
    else if (flagArgs[i] === '--agent' && flagArgs[i + 1]) agentName = flagArgs[++i];
  }

  if (!policyPath) policyPath = existsSync(POLICY_FILE) ? POLICY_FILE : ensureDefaultPolicy();

  const policy = new PolicyEvaluator(policyPath);
  const { env: secretEnv, secretValues } = SecretVault.resolveEnvMap(policy.secrets);
  const leases = new LeaseManager();
  const ledger = new ReceiptLedger(receiptsPath());

  const hub = new ApprovalHub({ serverName, leases });
  await hub.start();

  new McpStdioProxy({
    serverName,
    agentName,
    upstreamCommand: upstreamCmd,
    upstreamArgs,
    upstreamEnv: secretEnv,
    secretValues,
    policy,
    leases,
    ledger,
    onApprovalNeeded: hub.createApprovalHandler(),
  }).start();
}

async function runDemo(): Promise<void> {
  const policy = new PolicyEvaluator(ensureDefaultPolicy());
  const leases = new LeaseManager();
  const ledger = new ReceiptLedger(receiptsPath());
  const hub = new ApprovalHub({ serverName: 'github (demo)', leases, registerHub: false });
  await hub.start();
  const ask = hub.createApprovalHandler();
  const server = 'github-demo';
  const record = (
    tool: string,
    args: Record<string, unknown>,
    decision: ReceiptEntry['decision'],
    lease_id?: string,
  ) => ledger.record({ agent: 'demo-agent', server, tool, args, decision, lease_id });

  console.log('\nlettuce demo\n');
  console.log('1. The agent lists repositories. Your policy allows reading, so it just runs.');
  record('list_repositories', { owner: 'your-org' }, 'allowed_by_policy');

  console.log('2. The agent tries delete_repository. Your policy says never, so it is blocked.');
  record('delete_repository', { repo: 'your-app' }, 'denied_by_policy');

  console.log('3. The agent wants to open a pull request. Your policy says ask.');
  console.log('   Your browser should open with the request. Allow it or deny it there.\n');

  const args = {
    owner: 'your-org',
    repo: 'your-app',
    title: 'Fix the date format on invoices',
    head: 'fix/dates',
    base: 'main',
  };
  const outcome = await ask({
    server,
    tool: 'create_pull_request',
    args,
    rule: policy.evaluate('create_pull_request').matchedRule,
    timeoutMs: 120_000,
  });

  if (outcome.approved && outcome.mode === 'lease') {
    const lease = leases.grant({
      server,
      toolPattern: 'create_pull_request',
      duration: outcome.duration,
      maxCalls: 5,
    });
    record('create_pull_request', args, 'approved_lease', lease.id);
    console.log(`   Allowed for ${outcome.duration}. More pull requests in that time won't ask again.`);
  } else if (outcome.approved) {
    record('create_pull_request', args, 'approved_once');
    console.log('   Allowed once.');
  } else {
    record('create_pull_request', args, 'denied_by_user');
    console.log(`   Denied (${outcome.reason}).`);
  }

  const check = ReceiptLedger.verifyChain(receiptsPath());
  console.log(
    `\nReceipts: ${check.count} entries, ${check.valid ? 'unedited' : 'EDITED'} (${receiptsPath()})`,
  );
  await hub.close();
  process.exit(0);
}

function runVerify(args: string[]): void {
  const sinceIdx = args.indexOf('--since');
  const expect = sinceIdx === -1 ? undefined : args[sinceIdx + 1];
  if (sinceIdx !== -1 && !expect) {
    console.error('Usage: lettuce verify [--since <hash you saved earlier>]');
    process.exit(1);
  }
  const result = ReceiptLedger.verifyChain(receiptsPath(), expect);
  if (result.valid) {
    console.log(`Receipts check out: ${result.count} entries, none edited or removed from the middle.`);
    if (expect) console.log('Everything up to the hash you saved is still there.');
    if (result.lastHash) {
      console.log(`Latest hash: ${result.lastHash}`);
      console.log('Save it somewhere else, then check later with: lettuce verify --since <hash>');
    }
    process.exit(0);
  }
  console.error(`Receipts have been changed: ${result.reason}`);
  process.exit(1);
}

function postRevoke(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/revoke',
        method: 'POST',
        headers: { 'X-Lettuce': 'revoke' },
        timeout: 2000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve((JSON.parse(body) as { revokedCount: number }).revokedCount);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
    req.end();
  });
}

async function runRevoke(): Promise<void> {
  const dir = hubsDir();
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  let total = 0;
  let reached = 0;
  for (const file of files) {
    let port: number;
    try {
      port = Number((JSON.parse(readFileSync(join(dir, file), 'utf8')) as { port: number }).port);
    } catch {
      continue;
    }
    const count = await postRevoke(port);
    if (count === null) {
      rmSync(join(dir, file), { force: true }); // that server has stopped
      continue;
    }
    reached += 1;
    total += count;
  }
  console.log(`Ended ${total} active approval(s) across ${reached} running server(s).`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'init':
      return runInit();
    case 'secret':
      return runSecret(rest);
    case 'wrap':
      return runWrap(rest);
    case 'demo':
      return runDemo();
    case 'receipts':
      return runReceipts(rest);
    case 'verify':
      return runVerify(rest);
    case 'revoke':
      return runRevoke();
    default:
      console.log(HELP);
      process.exit(command && command !== 'help' && command !== '--help' ? 1 : 0);
  }
}

main().catch((err) => {
  process.stderr.write(`[lettuce] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
