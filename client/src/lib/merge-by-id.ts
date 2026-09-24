/**
 * @file Merges records fetched from several status-scoped requests into a single
 * list holding one entry per id. Status lanes are requested in parallel, so a row
 * whose status flips mid-flight (a Codex agent going working → waiting) comes back
 * in two responses at once and would otherwise render as two cards for the same
 * session. The freshest copy wins, so the merged row shows the current status.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `client/src/lib/merge-by-id.ts`
 * **Purpose:** Dashboard module consumed by the React client, MCP tools, or desktop shell depending on deployment mode.
 *
 * ## Design constraints
 * - Local-first: no telemetry leaves the machine unless the user configures webhooks.
 * - Fail-safe hooks path on the server must never block Claude Code; UI mirrors that
 *   philosophy by degrading gracefully (empty states, stale badges, reconnect loops).
 * - Destructive flows stay behind explicit confirmation modals and server-side gates.
 * - Internationalization: user-visible strings belong in i18n JSON, not literals here.
 *
 * ## Remote data & SSH
 * Remote Data Sources let operators aggregate multiple machines. SSH entries describe
 * how to reach a peer dashboard; the global data scope (`dataScope.ts`) narrows every
 * scoped GET via `?sources=`. Health checks and import history surface in Settings.
 *
 * ## Observability
 * Prometheus scrapes `GET /api/metrics` (see `monitoring/`). Grafana ships four
 * provisioned boards (overview, sessions, tools, alerts). Native npm scripts and
 * Docker Compose profiles are documented in `monitoring/README.md`.
 *
 * ## Public surface
 * - `mergeFreshestById` — exported API; see TSDoc on the symbol for behavior.
 *
 * ## Testing pointers
 * - Prefer colocated `__tests__` with Vitest + Testing Library for UI.
 * - Server contract changes require `npm run test:server` and OpenAPI sync.
 * - MCP edits: `npm run mcp:typecheck` and `npm run mcp:build`.
 *
 * ## Related docs
 * - `ARCHITECTURE.md` — hooks → API → SQLite → WebSocket → UI pipeline.
 * - `docs/API.md` — REST reference.
 * - `.claude/skills/file-headers/` — mandatory `@author` header policy.
 * ============================================================================= */
/* -----------------------------------------------------------------------------
 * EXPORT CATALOG — quick index of symbols defined below (documentation only).
 * -----------------------------------------------------------------------------
 * **mergeFreshestById**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

interface Identified {
  id: string;
  /** Row mutation time — bumped exactly when status and metadata change. */
  updated_at?: string;
  /** Latest durable provider event for the row; unchanged by a status flip. */
  last_activity?: string;
  started_at?: string;
}

/**
 * Row mutation time first: `updated_at` moves precisely when a status changes,
 * while `last_activity` is event-derived and identical across the two copies of
 * a row caught mid-flip.
 */
function freshness(record: Identified): number {
  for (const value of [record.updated_at, record.last_activity, record.started_at]) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Concatenate groups, keeping the freshest record per id. First-appearance order
 * is preserved so existing list ordering (working lane before waiting lane) is
 * unchanged; ties keep the earlier group's copy.
 */
export function mergeFreshestById<T extends Identified>(...groups: T[][]): T[] {
  const merged = new Map<string, T>();
  for (const group of groups) {
    for (const record of group || []) {
      if (!record || typeof record.id !== "string") continue;
      const existing = merged.get(record.id);
      if (!existing || freshness(record) > freshness(existing)) {
        merged.set(record.id, record);
      }
    }
  }
  return [...merged.values()];
}
