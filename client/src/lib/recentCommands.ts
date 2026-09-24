/**
 * @file recentCommands.ts
 * @description Tiny most-recently-used store for command-palette picks, kept in
 * `localStorage` so the launcher gets faster the more it is used.
 *
 * Only the command id is stored — never a label, a session name, or a path. The
 * palette re-resolves ids against the live catalog on every open, so a renamed
 * page or a deleted session simply stops appearing instead of leaving a dead row
 * behind, and nothing about the user's work is written to disk by this feature.
 *
 * Every access is wrapped: `localStorage` throws in private mode and in embedded
 * webviews, and a launcher must never fail to open because a nicety could not be
 * persisted.
 *
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `client/src/lib/recentCommands.ts`
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
 * - `RECENT_LIMIT` — exported API; see TSDoc on the symbol for behavior.
 * - `loadRecentCommands` — exported API; see TSDoc on the symbol for behavior.
 * - `rememberCommand` — exported API; see TSDoc on the symbol for behavior.
 * - `clearRecentCommands` — exported API; see TSDoc on the symbol for behavior.
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
 * **RECENT_LIMIT**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * **loadRecentCommands**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * **rememberCommand**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * **clearRecentCommands**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

const STORAGE_KEY = "ccam-palette-recent";

/** Kept short on purpose: a "Recent" group longer than this is just a second list. */
export const RECENT_LIMIT = 5;

/** Ids of the most recently run commands, newest first. */
export function loadRecentCommands(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string").slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Move `id` to the front of the MRU list.
 *
 * @returns The new list, so callers can update state without a second read.
 */
export function rememberCommand(id: string): string[] {
  const next = [id, ...loadRecentCommands().filter((entry) => entry !== id)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Persistence is best-effort; the in-memory list returned below still works
    // for the rest of this session.
  }
  return next;
}

/** Forget every remembered pick. Exposed as a palette action. */
export function clearRecentCommands(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clean up if it was never written */
  }
}
