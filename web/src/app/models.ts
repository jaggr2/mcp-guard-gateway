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

export interface SandboxUsage {
  costTodayUsd: number;
  costMonthUsd: number;
  tokensHour: number;
  tokensToday: number;
  opencodeGoTokensToday: number;
  requestsToday: number;
}

export interface SandboxEntry {
  slug: string;
  displayName: string;
  repoUrl: string;
  url: string;
  template: 'import' | 'fullstack' | 'cdk' | 'minimal';
  lifecycleMode: 'auto-stop' | 'always-on';
  idleTimeoutMinutes: number;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  hourlyTokenCap: number;
  dailyTokenCap: number;
  awsRoleArn: string | null;
  awsDeployRoleArn: string | null;
  allowedUpstreams: string;
  status: string;
  branch: string;
  dirtyFiles: number;
  lastActiveAt: string | null;
  usage: SandboxUsage;
}

export interface LearningEntry {
  id: number;
  ts: string;
  sourceProject: string;
  kind: 'gotcha' | 'memory' | 'skill';
  targetPath: string;
  title: string;
  content: string;
  mode: 'append' | 'replace';
  rationale: string | null;
  status: string;
  commitRef: string | null;
}

export interface ScheduleEntry {
  id: string;
  name: string;
  cronExpr: string;
  project: string;
  model: string;
  prompt: string;
  allowedUpstreams: string;
  deliveryTarget: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastOutput: string | null;
  createdAt: string;
}

export interface StatusInfo {
  publicUrl: string;
  issuers: string[];
  upstreams: { namespace: string; displayName: string; enabled: boolean; trust: string }[];
  sandboxes?: {
    slug: string;
    displayName: string;
    status: string;
    lifecycleMode: string;
    costTodayUsd: number;
    dailyBudgetUsd: number;
  }[];
  globalUsage?: {
    costTodayUsd: number;
    costMonthUsd: number;
    opencodeGoTokensToday: number;
    mcpCallsToday: number;
  };
}
