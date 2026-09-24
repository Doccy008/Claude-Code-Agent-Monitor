/**
 * @file Helpers for WebSocket messages that signal remote SSH sources finished
 * syncing and scoped stats (sessions, costs, analytics) should refetch.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `client/src/lib/remoteDataEvents.ts`
 * **Purpose:** Supports federated dashboards: register SSH-backed or file-synced remote machines, health-check tunnels, and scope the entire UI to local vs all vs selected sources.
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
 * ## Internal dependencies
 * - `./types`
 *
 * ## Public surface
 * - `isRemoteDataRefreshMessage` — exported API; see TSDoc on the symbol for behavior.
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
 * **isRemoteDataRefreshMessage**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

import type { ImportProgressMessage, RemoteSourceStatusPayload, WSMessage } from "./types";

/**
 * True when a WebSocket message means remote-imported data may have changed and
 * pages should refetch API data (not merely show a sync spinner).
 */
export function isRemoteDataRefreshMessage(msg: WSMessage): boolean {
  if (msg.type === "remote_data.updated") return true;
  if (msg.type === "remote_source.status") {
    return (msg.data as RemoteSourceStatusPayload).status === "ok";
  }
  if (msg.type === "import.progress") {
    const d = msg.data as ImportProgressMessage;
    return d.phase === "complete" && d.source === "remote";
  }
  return false;
}
