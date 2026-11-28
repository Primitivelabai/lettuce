export type ActionDecision = 'allow' | 'ask' | 'never';

export interface ArgumentConstraint {
  equals?: string | number | boolean;
  startsWith?: string;
  matchesRegex?: string;
}

export interface PolicyRule {
  tools: string[];
  action: ActionDecision;
  lease_options?: string[];
  max_calls_per_lease?: number;
  constraints?: Record<string, ArgumentConstraint>;
}

export interface LeasePolicy {
  version: number;
  default_action: ActionDecision;
  approval_timeout_ms: number;
  secrets?: Record<string, string>;
  rules: PolicyRule[];
}

export interface ActiveLease {
  id: string;
  server: string;
  toolPattern: string;
  constraints?: Record<string, ArgumentConstraint>;
  createdAt: number;
  expiresAt: number;
  remainingCalls: number | null;
  revoked: boolean;
}

export interface ReceiptEntry {
  seq: number;
  ts: string;
  agent: string;
  server: string;
  tool: string;
  args_hash: string;
  decision:
    | 'allowed_by_policy'
    | 'allowed_by_lease'
    | 'approved_once'
    | 'approved_lease'
    | 'denied_by_policy'
    | 'denied_by_user'
    | 'denied_timeout'
    | 'denied_invalid_request'
    | 'denied_error'
    | 'lease_revoked';
  lease_id?: string;
  expires_at?: string;
  prev_hash: string;
  hash: string;
}

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
