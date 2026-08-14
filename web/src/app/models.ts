export interface UpstreamTrust {
  state: string;
  pinnedAt?: string;
}

export interface Upstream {
  namespace: string;
  displayName: string;
  url: string;
  protocolVersion: string | null;
  enabled: boolean;
  driftAction: string;
  headerMap: Record<string, string>;
  trust: UpstreamTrust | null;
  toolCount: number;
}

export interface ToolEntry {
  name: string;
  upstreamName: string;
  description?: string;
  enabled: boolean;
  guard: 'none' | 'reason' | 'hitl';
  timeoutAction: 'deny' | 'approve' | null;
  ttlMinutes: number | null;
}

export interface Approval {
  approval_id: string;
  tool: string;
  status: string;
  reason: string;
  created_at: string;
  expires_at: string | null;
}

export interface AuditRow {
  id: number;
  ts: string;
  caller_id: string;
  tool: string;
  args: string;
  reason: string | null;
  decision: string;
  approved_by: string | null;
  upstream_status: string | null;
  expires_at: string | null;
}

export interface ClientRow {
  id: string;
  name: string;
  scopes: string;
  enabled: boolean;
  createdAt: string;
}

export interface StatusInfo {
  publicUrl: string;
  issuers: string[];
  upstreams: { namespace: string; displayName: string; enabled: boolean; trust: string }[];
}
