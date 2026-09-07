import { DurableObject } from "cloudflare:workers";
import {
  CONCURRENT_LIMIT,
  IP_DAILY_LIMIT,
  LEASE_TTL_MS,
  SESSION_REQUEST_LIMIT,
} from "./policy.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class RelayQuota extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS daily_usage (
        day INTEGER PRIMARY KEY,
        requests INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_usage (
        session_id TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        requests INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS leases (
        lease_id TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `);
  }

  async acquire({ sessionId, sessionExpiresAt, now }) {
    if (
      !UUID.test(sessionId) ||
      !Number.isSafeInteger(sessionExpiresAt) ||
      !Number.isSafeInteger(now)
    ) {
      return { ok: false, retryAfter: 60 };
    }

    this.sql.exec("DELETE FROM leases WHERE expires_at <= ?", now);
    this.sql.exec("DELETE FROM session_usage WHERE expires_at <= ?", now);
    const day = Math.floor(now / 86_400_000);
    this.sql.exec("DELETE FROM daily_usage WHERE day < ?", day - 1);

    const concurrent = this.sql
      .exec("SELECT COUNT(*) AS count FROM leases")
      .one().count;
    if (concurrent >= CONCURRENT_LIMIT) {
      return { ok: false, retryAfter: 5 };
    }

    const daily = this.sql
      .exec("SELECT requests FROM daily_usage WHERE day = ?", day)
      .toArray()[0]?.requests ?? 0;
    if (daily >= IP_DAILY_LIMIT) {
      const resetAt = (day + 1) * 86_400_000;
      return { ok: false, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
    }

    const session = this.sql
      .exec(
        "SELECT requests FROM session_usage WHERE session_id = ?",
        sessionId,
      )
      .toArray()[0];
    if ((session?.requests ?? 0) >= SESSION_REQUEST_LIMIT) {
      return {
        ok: false,
        retryAfter: Math.max(1, Math.ceil((sessionExpiresAt - now) / 1000)),
      };
    }

    this.sql.exec(
      `INSERT INTO daily_usage(day, requests) VALUES (?, 1)
       ON CONFLICT(day) DO UPDATE SET requests = requests + 1`,
      day,
    );
    this.sql.exec(
      `INSERT INTO session_usage(session_id, expires_at, requests)
       VALUES (?, ?, 1)
       ON CONFLICT(session_id) DO UPDATE SET
         expires_at = excluded.expires_at,
         requests = requests + 1`,
      sessionId,
      sessionExpiresAt,
    );
    const leaseId = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO leases(lease_id, expires_at) VALUES (?, ?)",
      leaseId,
      now + LEASE_TTL_MS,
    );
    return { ok: true, leaseId };
  }

  async release(leaseId) {
    if (typeof leaseId === "string" && leaseId.length <= 64) {
      this.sql.exec("DELETE FROM leases WHERE lease_id = ?", leaseId);
    }
  }
}
