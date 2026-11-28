import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { planSpawn } from './command.js';
import { LeaseManager } from './leases.js';
import { PolicyEvaluator } from './policy.js';
import { ReceiptLedger } from './receipts.js';
import { SecretVault } from './secrets.js';
import type { JsonRpcMessage, PolicyRule, ReceiptEntry } from './types.js';

export type ApprovalOutcome =
  | { approved: true; mode: 'once' }
  | { approved: true; mode: 'lease'; duration: string }
  | { approved: false; reason: string };

export type ApprovalHandler = (request: {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  rule?: PolicyRule;
  timeoutMs: number;
}) => Promise<ApprovalOutcome>;

type RpcId = string | number;

/**
 * MCP requests a client may send that lettuce passes on unchanged. Only tools
 * are gated by the policy; anything not listed here is refused.
 */
export const PASS_THROUGH_METHODS = new Set([
  'initialize',
  'ping',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'resources/subscribe',
  'resources/unsubscribe',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'logging/setLevel',
]);

/** Notifications an MCP client may send. Anything else is refused. */
export const PASS_THROUGH_NOTIFICATIONS = new Set([
  'notifications/initialized',
  'notifications/cancelled',
  'notifications/progress',
  'notifications/roots/list_changed',
]);

export type HostMessageCheck =
  | { kind: 'forward'; msg: JsonRpcMessage }
  | { kind: 'call'; msg: JsonRpcMessage; id: RpcId; tool: string; args: Record<string, unknown> }
  | { kind: 'reject'; id: RpcId | null; code: number; message: string; label: string };

const isId = (v: unknown): v is RpcId =>
  (typeof v === 'string' && v.length > 0) || (typeof v === 'number' && Number.isFinite(v));
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Decides what to do with one message from the MCP client before anything reaches the server. */
export function checkHostMessage(parsed: unknown): HostMessageCheck {
  const reject = (id: RpcId | null, code: number, message: string, label: string): HostMessageCheck => ({
    kind: 'reject',
    id,
    code,
    message: `[lettuce] ${message}`,
    label,
  });

  // JSON-RPC batches could carry a tools/call past the checks. MCP no longer uses them.
  if (Array.isArray(parsed)) return reject(null, -32600, 'Batched requests are not supported.', '(batch)');
  if (!isPlainObject(parsed) || parsed.jsonrpc !== '2.0') {
    return reject(null, -32600, 'Not a JSON-RPC 2.0 message.', '(invalid)');
  }
  const msg = parsed as unknown as JsonRpcMessage;
  const id = isId(parsed.id) ? parsed.id : null;

  if (!('method' in parsed)) {
    // A reply to a request the server sent (sampling, roots, elicitation).
    const hasResult = 'result' in parsed;
    const hasError = 'error' in parsed;
    if (id !== null && hasResult !== hasError) return { kind: 'forward', msg };
    return reject(null, -32600, 'Not a valid JSON-RPC response.', '(invalid response)');
  }

  const method = parsed.method;
  if (typeof method !== 'string' || method.length === 0) {
    return reject(id, -32600, 'Missing method.', '(invalid)');
  }
  if ('result' in parsed || 'error' in parsed) {
    return reject(id, -32600, 'A request cannot also carry a result or error.', method);
  }
  if ('params' in parsed && !isPlainObject(parsed.params)) {
    return reject(id, -32602, 'params must be an object.', method);
  }

  if (method.startsWith('notifications/')) {
    if ('id' in parsed) return reject(null, -32600, 'Notifications must not have an id.', method);
    if (!PASS_THROUGH_NOTIFICATIONS.has(method)) {
      return reject(null, -32601, `lettuce doesn't pass on "${method}".`, method);
    }
    return { kind: 'forward', msg };
  }

  if (id === null) return reject(null, -32600, `${method} needs a string or number id.`, method);

  if (method === 'tools/call') {
    const params = parsed.params;
    if (!isPlainObject(params) || typeof params.name !== 'string' || params.name.length === 0) {
      return reject(id, -32602, 'tools/call needs params.name.', method);
    }
    if (params.arguments !== undefined && !isPlainObject(params.arguments)) {
      return reject(id, -32602, 'tools/call arguments must be an object.', params.name);
    }
    return {
      kind: 'call',
      msg,
      id,
      tool: params.name,
      args: (params.arguments ?? {}) as Record<string, unknown>,
    };
  }

  if (PASS_THROUGH_METHODS.has(method)) return { kind: 'forward', msg };
  return reject(id, -32601, `lettuce doesn't pass on "${method}".`, method);
}

export class McpStdioProxy {
  constructor(
    private readonly config: {
      serverName: string;
      agentName: string;
      upstreamCommand: string;
      upstreamArgs: string[];
      upstreamEnv?: Record<string, string>;
      secretValues?: string[];
      policy: PolicyEvaluator;
      leases: LeaseManager;
      ledger: ReceiptLedger;
      onApprovalNeeded: ApprovalHandler;
    },
  ) {}

  private record(
    tool: string,
    args: unknown,
    decision: ReceiptEntry['decision'],
    extra: Partial<ReceiptEntry> = {},
  ): void {
    this.config.ledger.record({
      agent: this.config.agentName,
      server: this.config.serverName,
      tool,
      args,
      decision,
      ...extra,
    });
  }

  /** Records a denial; a receipt failure must never turn a denial into anything else. */
  private recordDenial(tool: string, args: unknown, decision: ReceiptEntry['decision']): void {
    try {
      this.record(tool, args, decision);
    } catch (err) {
      process.stderr.write(`[lettuce] Couldn't write a receipt: ${String(err)}\n`);
    }
  }

  public start(): void {
    const plan = planSpawn(this.config.upstreamCommand, this.config.upstreamArgs);
    const child = spawn(plan.command, plan.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.upstreamEnv },
      windowsVerbatimArguments: plan.windowsVerbatimArguments ?? false,
    });
    child.on('error', (err) => {
      process.stderr.write(
        `[lettuce] Couldn't start ${this.config.serverName} (${this.config.upstreamCommand}): ${err.message}
`,
      );
      process.exit(1);
    });

    const redactor = SecretVault.createRedactingTransform(this.config.secretValues ?? []);
    child.stderr.pipe(redactor).pipe(process.stderr);

    const cleanup = (code = 0) => {
      if (!child.killed) child.kill('SIGTERM');
      process.exit(code);
    };

    process.on('SIGINT', () => cleanup(0));
    process.on('SIGTERM', () => cleanup(0));
    process.stdin.on('end', () => cleanup(0));
    child.on('exit', (code) => process.exit(code ?? 0));

    const writeToHost = (msg: JsonRpcMessage) => {
      process.stdout.write(`${JSON.stringify(msg)}\n`);
    };

    const writeToUpstream = (msg: JsonRpcMessage) => {
      if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(msg)}\n`);
    };

    const deny = (id: RpcId | null, code: number, message: string) => {
      if (id !== null) writeToHost({ jsonrpc: '2.0', id, error: { code, message } });
      else if (code === -32600) writeToHost({ jsonrpc: '2.0', id: null, error: { code, message } });
    };

    const hostRl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    hostRl.on('line', async (line) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.recordDenial('(unreadable)', {}, 'denied_invalid_request');
        writeToHost({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: '[lettuce] Not valid JSON.' },
        });
        return;
      }

      const check = checkHostMessage(parsed);
      if (check.kind === 'forward') {
        writeToUpstream(check.msg);
        return;
      }
      if (check.kind === 'reject') {
        this.recordDenial(check.label, parsed, 'denied_invalid_request');
        deny(check.id, check.code, check.message);
        return;
      }

      try {
        await this.handleToolCall(check, writeToUpstream, writeToHost);
      } catch (err) {
        // Fail closed: anything unexpected denies the call instead of crashing or running it.
        process.stderr.write(`[lettuce] Denied ${check.tool} after an error: ${String(err)}\n`);
        this.recordDenial(check.tool, check.args, 'denied_error');
        deny(check.id, -32001, '[lettuce] Call denied: lettuce hit an error checking it.');
      }
    });

    const upstreamRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    upstreamRl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line) as JsonRpcMessage;
      } catch {
        return;
      }
      // Filter every tool list, whatever request it answers, so hidden tools never reach the agent.
      const result = msg.result as { tools?: unknown } | undefined;
      if (result && Array.isArray(result.tools)) {
        result.tools = result.tools.filter(
          (t) => !(isPlainObject(t) && typeof t.name === 'string' && this.config.policy.isToolHidden(t.name)),
        );
      }
      writeToHost(msg);
    });
  }

  private async handleToolCall(
    call: { msg: JsonRpcMessage; id: RpcId; tool: string; args: Record<string, unknown> },
    writeToUpstream: (m: JsonRpcMessage) => void,
    writeToHost: (m: JsonRpcMessage) => void,
  ): Promise<void> {
    const { msg, id, tool, args } = call;
    const { serverName, policy, leases } = this.config;
    const denied = (reason: string) => {
      writeToHost({
        jsonrpc: '2.0',
        id,
        error: { code: -32001, message: `[lettuce] Tool "${tool}" denied: ${reason}` },
      });
    };

    const evalResult = policy.evaluate(tool, args);

    if (evalResult.action === 'never') {
      this.record(tool, args, 'denied_by_policy');
      return denied(evalResult.reason);
    }

    if (evalResult.action === 'allow') {
      this.record(tool, args, 'allowed_by_policy');
      writeToUpstream(msg);
      return;
    }

    const activeLease = leases.tryConsume(serverName, tool, args);
    if (activeLease) {
      this.record(tool, args, 'allowed_by_lease', {
        lease_id: activeLease.id,
        expires_at: new Date(activeLease.expiresAt).toISOString(),
      });
      writeToUpstream(msg);
      return;
    }

    const outcome = await raceTimeout(
      this.config.onApprovalNeeded({
        server: serverName,
        tool,
        args,
        rule: evalResult.matchedRule,
        timeoutMs: policy.timeoutMs,
      }),
      policy.timeoutMs,
    );

    if (!outcome) {
      this.record(tool, args, 'denied_timeout');
      return denied('Approval timed out (nobody answered)');
    }

    if (!outcome.approved) {
      this.record(tool, args, 'denied_by_user');
      return denied(outcome.reason || 'Denied');
    }

    // The policy may have changed while the request waited. Check again before running anything.
    const current = policy.evaluate(tool, args);
    if (current.action === 'never') {
      this.record(tool, args, 'denied_by_policy');
      return denied(`The policy changed while this waited: ${current.reason}`);
    }

    if (outcome.mode === 'once' || current.action === 'allow') {
      this.record(tool, args, 'approved_once');
      writeToUpstream(msg);
      return;
    }

    const offered = current.matchedRule?.lease_options ?? ['once', '15m', '1h'];
    if (!offered.includes(outcome.duration)) {
      this.record(tool, args, 'denied_by_policy');
      return denied(`The policy no longer offers a ${outcome.duration} approval`);
    }

    const newLease = leases.grant({
      server: serverName,
      toolPattern: tool,
      duration: outcome.duration,
      maxCalls: current.matchedRule?.max_calls_per_lease,
      constraints: current.matchedRule?.constraints,
    });
    // This call counts against the new lease. If it can't, it doesn't run.
    if (leases.tryConsume(serverName, tool, args)?.id !== newLease.id) {
      this.record(tool, args, 'denied_error');
      return denied('The new approval could not cover this call');
    }
    this.record(tool, args, 'approved_lease', {
      lease_id: newLease.id,
      expires_at: new Date(newLease.expiresAt).toISOString(),
    });
    writeToUpstream(msg);
  }
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise
      .then((val) => {
        clearTimeout(timer);
        resolve(val);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}
