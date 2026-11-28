import { randomBytes } from 'node:crypto';
import type { ActiveLease, ArgumentConstraint } from './types.js';

const MAX_LEASE_MS = 30 * 24 * 3_600_000;

export function parseDurationMs(duration: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(duration.trim());
  if (!match) throw new Error(`Invalid duration format: "${duration}". Use e.g. "15m", "1h", "30s".`);
  const value = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000;
  const ms = value * multiplier;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_LEASE_MS) {
    throw new Error(`Invalid duration "${duration}": use more than 0 and at most 30 days.`);
  }
  return ms;
}

export function matchesGlob(pattern: string, target: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(target);
}

export function satisfiesConstraints(
  args: Record<string, unknown> | undefined,
  constraints?: Record<string, ArgumentConstraint>,
): boolean {
  if (!constraints) return true;
  const safeArgs = args ?? {};

  for (const [key, rule] of Object.entries(constraints)) {
    const val = safeArgs[key];
    if (rule.equals !== undefined && val !== rule.equals) return false;
    if (rule.startsWith !== undefined && (typeof val !== 'string' || !val.startsWith(rule.startsWith))) {
      return false;
    }
    if (
      rule.matchesRegex !== undefined &&
      (typeof val !== 'string' || !new RegExp(rule.matchesRegex).test(val))
    ) {
      return false;
    }
  }
  return true;
}

export class LeaseManager {
  private readonly leases = new Map<string, ActiveLease>();

  public grant(params: {
    server: string;
    toolPattern: string;
    duration: string;
    maxCalls?: number;
    constraints?: Record<string, ArgumentConstraint>;
  }): ActiveLease {
    if (params.maxCalls !== undefined && (!Number.isSafeInteger(params.maxCalls) || params.maxCalls < 1)) {
      throw new Error('max_calls_per_lease must be a whole number of at least 1');
    }
    const now = Date.now();
    const id = `ls_${randomBytes(4).toString('hex')}`;
    const lease: ActiveLease = {
      id,
      server: params.server,
      toolPattern: params.toolPattern,
      constraints: params.constraints,
      createdAt: now,
      expiresAt: now + parseDurationMs(params.duration),
      remainingCalls: params.maxCalls ?? null,
      revoked: false,
    };

    this.leases.set(id, lease);
    return lease;
  }

  public tryConsume(server: string, toolName: string, args?: Record<string, unknown>): ActiveLease | null {
    const now = Date.now();

    for (const [id, lease] of this.leases.entries()) {
      if (lease.revoked || now >= lease.expiresAt) {
        this.leases.delete(id);
        continue;
      }
      if (lease.server !== server) continue;
      if (!matchesGlob(lease.toolPattern, toolName)) continue;
      if (!satisfiesConstraints(args, lease.constraints)) continue;

      if (lease.remainingCalls !== null) {
        if (lease.remainingCalls <= 0) {
          this.leases.delete(id);
          continue;
        }
        lease.remainingCalls -= 1;
        if (lease.remainingCalls === 0) {
          lease.revoked = true;
        }
      }

      return lease;
    }

    return null;
  }

  public revokeAll(): string[] {
    const revokedIds: string[] = [];
    for (const [id, lease] of this.leases.entries()) {
      lease.revoked = true;
      revokedIds.push(id);
      this.leases.delete(id);
    }
    return revokedIds;
  }

  public listActive(): ActiveLease[] {
    const now = Date.now();
    return [...this.leases.values()].filter((l) => !l.revoked && now < l.expiresAt);
  }
}
