export type Decision = "auto-audited" | "approved" | "denied" | "expired";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";

export interface AuditRow {
  id: number;
  ts: string;
  caller_id: string;
  tool: string;
  args: string;
  reason: string | null;
  decision: Decision;
  approved_by: string | null;
  upstream_status: string | null;
  expires_at: string | null;
}

export type NewAuditRow = {
  ts?: string;
  caller_id: string;
  tool: string;
  args: string;
  reason?: string | null;
  decision: Decision;
  approved_by?: string | null;
  upstream_status?: string | null;
  expires_at?: string | null;
};

export interface ApprovalRow {
  id: string;
  tool: string;
  args: string;
  reason: string;
  status: ApprovalStatus;
  timeout_action: "deny" | "approve" | null;
  ttl_minutes: number | null;
  created_at: string;
  expires_at: string | null;
  result: string | null;
  /** Hermes conversation key the card was posted to (e.g. `telegram:<id>`). */
  hermes_message_key: string | null;
  /** Hermes user id that resolved the approval. */
  hermes_user_id: string | null;
}

export type NewApprovalRow = Omit<
  ApprovalRow,
  "status" | "result" | "hermes_message_key" | "hermes_user_id" | "expires_at"
> & {
  status?: ApprovalStatus;
  expires_at?: string | null;
  result?: string | null;
  hermes_message_key?: string | null;
  hermes_user_id?: string | null;
};

export interface AuditFilter {
  tool?: string;
  since?: string;
  caller_id?: string;
  limit?: number;
}

export interface SetApprovalStatusOptions {
  hermesUserId?: string;
  result?: string;
}

/**
 * Marker stored in `approvals.result` while an approved call is being executed
 * upstream, so concurrent `check_approval_status` polls never double-execute.
 */
export const APPROVAL_RUNNING_MARKER = "__RUNNING__";

/**
 * Provider-agnostic persistence contract for operational records (audit +
 * approvals). Implemented over SQLite locally; other backends (DynamoDB, …) can
 * implement the same interface.
 */
export interface Store {
  insertAudit(row: NewAuditRow): Promise<void>;
  queryAudit(filter: AuditFilter): Promise<AuditRow[]>;

  createApproval(row: NewApprovalRow): Promise<void>;
  getApproval(id: string): Promise<ApprovalRow | undefined>;
  setApprovalStatus(
    id: string,
    status: ApprovalStatus,
    opts?: SetApprovalStatusOptions
  ): Promise<void>;
  /**
   * Atomically claims an approved approval for execution (result NULL → marker).
   * Returns true only for the caller that wins the race.
   */
  claimApprovalResult(id: string, sentinel: string): Promise<boolean>;
  /** Overwrites `result` with the executed upstream result. */
  setApprovalResult(id: string, result: string): Promise<void>;
  /** Records the Hermes conversation key of the approval card. */
  setApprovalHermesKey(id: string, messageKey: string): Promise<void>;
  listApprovals(status?: ApprovalStatus): Promise<ApprovalRow[]>;
}
