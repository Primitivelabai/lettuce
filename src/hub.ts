import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { parseDurationMs, type LeaseManager } from './leases.js';
import { renderHtml } from './page.js';
import { hubsDir } from './paths.js';
import type { ApprovalHandler, ApprovalOutcome } from './proxy.js';

interface PendingPrompt {
  id: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  leaseOptions: string[];
  maxCalls?: number;
  createdAt: number;
  expiresAt: number;
  resolve: (outcome: ApprovalOutcome) => void;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * One approval page per wrapped server, on a random local port.
 *
 * Every request that can approve something, or read what is waiting, must carry
 * a key that only the browser tab lettuce opened knows. The agent being gated
 * can reach the port, but without the key it can't see or approve anything.
 * Revoking needs no key: taking access away is always safe.
 */
export class ApprovalHub {
  public readonly key = randomBytes(32).toString('base64url');
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly sseClients = new Set<ServerResponse>();
  private server?: Server;
  private hubFile?: string;
  public port = 0;

  constructor(
    private readonly opts: {
      serverName: string;
      leases: LeaseManager;
      port?: number;
      openBrowser?: boolean;
      registerHub?: boolean;
    },
  ) {}

  public get url(): string {
    return `http://127.0.0.1:${this.port}/?k=${this.key}`;
  }

  public async start(): Promise<void> {
    const server = createServer((req, res) => {
      this.handleHttp(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port ?? 0, '127.0.0.1', () => resolve());
    });
    this.port = (server.address() as AddressInfo).port;

    if (this.opts.registerHub !== false) {
      mkdirSync(hubsDir(), { recursive: true });
      this.hubFile = join(hubsDir(), `${process.pid}-${this.port}.json`);
      writeFileSync(
        this.hubFile,
        JSON.stringify({ pid: process.pid, port: this.port, server: this.opts.serverName }),
        'utf8',
      );
      process.once('exit', () => this.removeHubFile());
    }
  }

  public async close(): Promise<void> {
    this.removeHubFile();
    for (const c of this.sseClients) c.end();
    for (const p of this.pending.values()) p.resolve({ approved: false, reason: 'lettuce stopped' });
    this.pending.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private removeHubFile(): void {
    if (this.hubFile) rmSync(this.hubFile, { force: true });
    this.hubFile = undefined;
  }

  public createApprovalHandler(): ApprovalHandler {
    return (req) => {
      const id = `req_${randomBytes(8).toString('hex')}`;
      const now = Date.now();
      const leaseOptions = req.rule?.lease_options ?? ['once', '15m', '1h'];

      return new Promise<ApprovalOutcome>((resolve) => {
        this.pending.set(id, {
          id,
          server: req.server,
          tool: req.tool,
          args: req.args,
          leaseOptions,
          maxCalls: req.rule?.max_calls_per_lease,
          createdAt: now,
          expiresAt: now + req.timeoutMs,
          resolve: (outcome) => {
            this.pending.delete(id);
            resolve(outcome);
            // Send the update after the proxy has granted any lease, so the page shows it.
            setImmediate(() => this.broadcastState());
          },
        });
        setTimeout(
          () => this.pending.get(id)?.resolve({ approved: false, reason: 'Approval timed out' }),
          req.timeoutMs,
        ).unref();
        this.broadcastState();
        this.notify(req.tool);
      });
    };
  }

  public revokeAll(): string[] {
    const ids = this.opts.leases.revokeAll();
    this.broadcastState();
    return ids;
  }

  /** Checks a "lease:15m"-style decision against the options this prompt offered. */
  public static parseDecision(decision: unknown, leaseOptions: string[]): ApprovalOutcome | null {
    if (decision === 'deny') return { approved: false, reason: 'Denied on the approval page' };
    if (decision === 'once') return leaseOptions.includes('once') ? { approved: true, mode: 'once' } : null;
    if (typeof decision !== 'string' || !decision.startsWith('lease:')) return null;
    const duration = decision.slice(6);
    if (duration === 'once' || !leaseOptions.includes(duration)) return null;
    try {
      parseDurationMs(duration);
    } catch {
      return null;
    }
    return { approved: true, mode: 'lease', duration };
  }

  private keyMatches(candidate: unknown): boolean {
    if (typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.key);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');

    // Refuse anything not addressed to this port on loopback (stops DNS rebinding).
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      res.writeHead(403);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(renderHtml(nonce, this.opts.serverName));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (!this.keyMatches(url.searchParams.get('k'))) return deny(res);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      this.sseClients.add(res);
      res.write(`data: ${JSON.stringify(this.getSnapshot())}\n\n`);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/decide') {
      if (!this.keyMatches(req.headers['x-lettuce-key'])) return deny(res);
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return deny(res, 415);
      const body = await readJsonBody(req);
      const prompt = this.pending.get(String(body.id ?? ''));
      if (!prompt || Date.now() >= prompt.expiresAt) {
        return json(res, 404, { ok: false, error: 'That request has expired or was already answered.' });
      }
      const outcome = ApprovalHub.parseDecision(body.decision, prompt.leaseOptions);
      if (!outcome)
        return json(res, 400, { ok: false, error: 'That option is not offered for this request.' });
      prompt.resolve(outcome);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/revoke') {
      // A custom header can't be sent cross-site without a preflight, which we never answer.
      if (req.headers['x-lettuce'] !== 'revoke') return deny(res);
      const revoked = this.revokeAll();
      return json(res, 200, { ok: true, revokedCount: revoked.length });
    }

    res.writeHead(404);
    res.end();
  }

  private getSnapshot() {
    const now = Date.now();
    for (const p of this.pending.values()) {
      if (now >= p.expiresAt) p.resolve({ approved: false, reason: 'Approval timed out' });
    }
    return {
      server: this.opts.serverName,
      pending: [...this.pending.values()].map(({ resolve: _r, ...rest }) => rest),
      leases: this.opts.leases.listActive().map((l) => ({
        id: l.id,
        tool: l.toolPattern,
        expiresAt: l.expiresAt,
        remainingCalls: l.remainingCalls,
      })),
    };
  }

  private broadcastState(): void {
    if (this.sseClients.size === 0) return;
    const payload = `data: ${JSON.stringify(this.getSnapshot())}\n\n`;
    for (const client of this.sseClients) client.write(payload);
  }

  private notify(tool: string): void {
    process.stderr.write(
      `[lettuce] ${this.opts.serverName} wants to run ${tool}. Waiting for you on the approval page.\n`,
    );
    if (this.sseClients.size > 0) return;
    if (this.opts.openBrowser === false || process.env.LETTUCE_NO_BROWSER === '1') return;

    const url = this.url;
    const [cmd, args] =
      process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : process.platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];
    execFile(cmd, args as string[], { windowsHide: true }, (err) => {
      // Only print the key when we couldn't open the page ourselves.
      if (err) process.stderr.write(`[lettuce] Couldn't open a browser. Open this link yourself: ${url}\n`);
    });
  }
}

function deny(res: ServerResponse, code = 403): void {
  res.writeHead(code);
  res.end();
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve({});
        return;
      }
      raw += c.toString('utf8');
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {},
        );
      } catch {
        resolve({});
      }
    });
  });
}
