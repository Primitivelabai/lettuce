import { readFileSync, statSync } from 'node:fs';
import YAML from 'yaml';
import { matchesGlob, parseDurationMs, satisfiesConstraints } from './leases.js';
import type { ActionDecision, LeasePolicy, PolicyRule } from './types.js';

export interface EvaluationResult {
  action: ActionDecision;
  matchedRule?: PolicyRule;
  reason: string;
}

const ACTIONS = new Set(['allow', 'ask', 'never']);

/** A typo like `action: Never` must not quietly fall through to the default, so bad policies are refused. */
export function validatePolicy(policy: LeasePolicy): LeasePolicy {
  if (!ACTIONS.has(policy.default_action)) {
    throw new Error(`default_action must be allow, ask or never (got "${String(policy.default_action)}")`);
  }
  if (!Number.isFinite(policy.approval_timeout_ms) || policy.approval_timeout_ms <= 0) {
    throw new Error('approval_timeout_ms must be a positive number');
  }
  if (!Array.isArray(policy.rules)) throw new Error('rules must be a list');
  policy.rules.forEach((rule, i) => {
    if (!rule || !Array.isArray(rule.tools) || rule.tools.some((t) => typeof t !== 'string')) {
      throw new Error(`rule ${i + 1}: tools must be a list of names`);
    }
    if (!ACTIONS.has(rule.action)) {
      throw new Error(`rule ${i + 1}: action must be allow, ask or never (got "${String(rule.action)}")`);
    }
    if (rule.lease_options !== undefined) {
      if (!Array.isArray(rule.lease_options) || rule.lease_options.length === 0) {
        throw new Error(`rule ${i + 1}: lease_options must be a non-empty list`);
      }
      for (const opt of rule.lease_options) {
        if (opt !== 'once') parseDurationMs(String(opt));
      }
    }
    const cap = rule.max_calls_per_lease;
    if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 1)) {
      throw new Error(`rule ${i + 1}: max_calls_per_lease must be a whole number of at least 1`);
    }
    if (
      rule.constraints !== undefined &&
      (typeof rule.constraints !== 'object' || rule.constraints === null)
    ) {
      throw new Error(`rule ${i + 1}: constraints must be a map of argument names`);
    }
  });
  return policy;
}

export class PolicyEvaluator {
  private policy!: LeasePolicy;
  private lastMtimeMs = 0;
  /** Set when the policy file stopped loading. Every call is denied until it loads again. */
  private brokenReason?: string;

  constructor(private readonly policyPath: string) {
    this.reloadIfChanged();
  }

  public reloadIfChanged(): void {
    let stat;
    try {
      stat = statSync(this.policyPath);
    } catch (err) {
      if (!this.policy) throw err;
      this.markBroken(`can't read ${this.policyPath}`);
      return;
    }
    if (stat.mtimeMs === this.lastMtimeMs) return;

    try {
      const raw = readFileSync(this.policyPath, 'utf8');
      const parsed = (YAML.parse(raw) as Partial<LeasePolicy>) ?? {};

      this.policy = validatePolicy({
        version: parsed.version ?? 1,
        default_action: parsed.default_action ?? 'ask',
        approval_timeout_ms: parsed.approval_timeout_ms ?? 60_000,
        secrets: parsed.secrets ?? {},
        rules: parsed.rules ?? [],
      });
      this.lastMtimeMs = stat.mtimeMs;
      if (this.brokenReason) process.stderr.write('[lettuce] Policy loads again. Calls resume.\n');
      this.brokenReason = undefined;
    } catch (err) {
      if (!this.policy) throw err;
      this.lastMtimeMs = stat.mtimeMs;
      this.markBroken(err instanceof Error ? err.message : String(err));
    }
  }

  private markBroken(reason: string): void {
    if (this.brokenReason !== reason) {
      process.stderr.write(`[lettuce] Policy error, denying every call until it's fixed: ${reason}\n`);
    }
    this.brokenReason = reason;
  }

  public get timeoutMs(): number {
    this.reloadIfChanged();
    return this.policy.approval_timeout_ms;
  }

  public get secrets(): Record<string, string> | undefined {
    this.reloadIfChanged();
    return this.policy.secrets;
  }

  /** True when no call to this tool could ever run, so the agent shouldn't see it. */
  public isToolHidden(toolName: string): boolean {
    this.reloadIfChanged();
    const matches = (rule: PolicyRule) => rule.tools.some((pattern) => matchesGlob(pattern, toolName));
    if (this.policy.rules.some((rule) => rule.action === 'never' && !rule.constraints && matches(rule))) {
      return true;
    }
    const canRun = this.policy.rules.some((rule) => rule.action !== 'never' && matches(rule));
    return this.policy.default_action === 'never' && !canRun;
  }

  public evaluate(toolName: string, args?: Record<string, unknown>): EvaluationResult {
    this.reloadIfChanged();
    if (this.brokenReason) {
      return { action: 'never', reason: `Your lettuce policy has an error: ${this.brokenReason}` };
    }

    const matchingRules = this.policy.rules.filter(
      (rule) =>
        rule.tools.some((pattern) => matchesGlob(pattern, toolName)) &&
        satisfiesConstraints(args, rule.constraints),
    );

    const neverRule = matchingRules.find((r) => r.action === 'never');
    if (neverRule) {
      return { action: 'never', matchedRule: neverRule, reason: 'Blocked by never rule' };
    }

    const askRule = matchingRules.find((r) => r.action === 'ask');
    if (askRule) {
      return { action: 'ask', matchedRule: askRule, reason: 'Requires human approval' };
    }

    const allowRule = matchingRules.find((r) => r.action === 'allow');
    if (allowRule) {
      return { action: 'allow', matchedRule: allowRule, reason: 'Permitted by allow rule' };
    }

    return {
      action: this.policy.default_action,
      reason: `Fallback to default_action (${this.policy.default_action})`,
    };
  }
}
