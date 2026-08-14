import type Database from "better-sqlite3";
import type {
  ApprovalRow,
  AuditFilter,
  AuditRow,
  NewApprovalRow,
  NewAuditRow,
  SetApprovalStatusOptions,
  Store,
} from "./types";

const APPROVAL_COLUMNS =
  "id, tool, args, reason, status, timeout_action, ttl_minutes, created_at, expires_at, result, hermes_message_key, hermes_user_id";

function rowToApproval(row: Record<string, unknown>): ApprovalRow {
  return {
    id: String(row.id),
    tool: String(row.tool),
    args: String(row.args),
    reason: String(row.reason),
    status: row.status as ApprovalRow["status"],
    timeout_action: (row.timeout_action as ApprovalRow["timeout_action"]) ?? null,
    ttl_minutes: row.ttl_minutes == null ? null : Number(row.ttl_minutes),
    created_at: String(row.created_at),
    expires_at: row.expires_at == null ? null : String(row.expires_at),
    result: row.result == null ? null : String(row.result),
    hermes_message_key: row.hermes_message_key == null ? null : String(row.hermes_message_key),
    hermes_user_id: row.hermes_user_id == null ? null : String(row.hermes_user_id),
  };
}

function rowToAudit(row: Record<string, unknown>): AuditRow {
  return {
    id: Number(row.id),
    ts: String(row.ts),
    caller_id: String(row.caller_id),
    tool: String(row.tool),
    args: String(row.args),
    reason: row.reason == null ? null : String(row.reason),
    decision: row.decision as AuditRow["decision"],
    approved_by: row.approved_by == null ? null : String(row.approved_by),
    upstream_status: row.upstream_status == null ? null : String(row.upstream_status),
    expires_at: row.expires_at == null ? null : String(row.expires_at),
  };
}

/** Operational store (audit + approvals) over SQLite. */
export class SqliteStore implements Store {
  constructor(private db: Database.Database) {}

  insertAudit(row: NewAuditRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO audit (ts, caller_id, tool, args, reason, decision, approved_by, upstream_status, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.ts ?? new Date().toISOString(),
        row.caller_id,
        row.tool,
        row.args,
        row.reason ?? null,
        row.decision,
        row.approved_by ?? null,
        row.upstream_status ?? null,
        row.expires_at ?? null
      );
    return Promise.resolve();
  }

  queryAudit(filter: AuditFilter): Promise<AuditRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.tool !== undefined) {
      clauses.push("tool = ?");
      params.push(filter.tool);
    }
    if (filter.since !== undefined) {
      clauses.push("ts >= ?");
      params.push(filter.since);
    }
    if (filter.caller_id !== undefined) {
      clauses.push("caller_id = ?");
      params.push(filter.caller_id);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM audit${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as Record<string, unknown>[];
    return Promise.resolve(rows.map(rowToAudit));
  }

  createApproval(row: NewApprovalRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO approvals (${APPROVAL_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.tool,
        row.args,
        row.reason,
        row.status ?? "pending",
        row.timeout_action,
        row.ttl_minutes,
        row.created_at,
        row.expires_at,
        row.result ?? null,
        row.hermes_message_key ?? null,
        row.hermes_user_id ?? null
      );
    return Promise.resolve();
  }

  getApproval(id: string): Promise<ApprovalRow | undefined> {
    const row = this.db
      .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return Promise.resolve(row ? rowToApproval(row) : undefined);
  }

  setApprovalStatus(
    id: string,
    status: ApprovalRow["status"],
    opts?: SetApprovalStatusOptions
  ): Promise<void> {
    this.db
      .prepare(
        `UPDATE approvals
         SET status = ?,
             hermes_user_id = COALESCE(?, hermes_user_id),
             result = COALESCE(?, result)
         WHERE id = ?`
      )
      .run(status, opts?.hermesUserId ?? null, opts?.result ?? null, id);
    return Promise.resolve();
  }

  claimApprovalResult(id: string, sentinel: string): Promise<boolean> {
    const res = this.db
      .prepare(
        `UPDATE approvals
         SET result = ?
         WHERE id = ? AND status = 'approved' AND result IS NULL`
      )
      .run(sentinel, id);
    return Promise.resolve(res.changes > 0);
  }

  setApprovalResult(id: string, result: string): Promise<void> {
    this.db.prepare(`UPDATE approvals SET result = ? WHERE id = ?`).run(result, id);
    return Promise.resolve();
  }

  setApprovalHermesKey(id: string, messageKey: string): Promise<void> {
    this.db.prepare(`UPDATE approvals SET hermes_message_key = ? WHERE id = ?`).run(messageKey, id);
    return Promise.resolve();
  }

  listApprovals(status?: ApprovalRow["status"]): Promise<ApprovalRow[]> {
    const rows = (
      status
        ? this.db
            .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 100`)
            .all(status)
        : this.db
            .prepare(`SELECT ${APPROVAL_COLUMNS} FROM approvals ORDER BY created_at DESC LIMIT 100`)
            .all()
    ) as Record<string, unknown>[];
    return Promise.resolve(rows.map(rowToApproval));
  }
}
