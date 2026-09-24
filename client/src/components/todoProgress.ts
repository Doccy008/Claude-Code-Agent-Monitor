/**
 * @file Shared visual metadata and formatting helpers for compact and detailed
 * session task-progress surfaces.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `client/src/components/todoProgress.ts`
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
 * ## Internal dependencies
 * - `../lib/types`
 *
 * ## Public surface
 * - `TODO_STATUS_META` — exported API; see TSDoc on the symbol for behavior.
 * - `taskProgressSegments` — exported API; see TSDoc on the symbol for behavior.
 * - `taskSourceLabel` — exported API; see TSDoc on the symbol for behavior.
 * - `taskProgressAriaLabel` — exported API; see TSDoc on the symbol for behavior.
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
 * **TODO_STATUS_META**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * **taskProgressSegments**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * **taskSourceLabel**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * **taskProgressAriaLabel**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

import type { SessionTodoSnapshot, SessionTodoStatus, SessionTodoSummary } from "../lib/types";

export const TODO_STATUS_META: Record<
  SessionTodoStatus,
  {
    color: string;
    textClass: string;
    bgClass: string;
    borderClass: string;
    labelKey: string;
  }
> = {
  completed: {
    color: "#34d399",
    textClass: "text-emerald-300",
    bgClass: "bg-emerald-500/10",
    borderClass: "border-emerald-500/20",
    labelKey: "taskProgress.status.completed",
  },
  in_progress: {
    color: "#60a5fa",
    textClass: "text-blue-300",
    bgClass: "bg-blue-500/10",
    borderClass: "border-blue-500/20",
    labelKey: "taskProgress.status.inProgress",
  },
  pending: {
    color: "#a78bfa",
    textClass: "text-violet-300",
    bgClass: "bg-violet-500/10",
    borderClass: "border-violet-500/20",
    labelKey: "taskProgress.status.pending",
  },
  cancelled: {
    color: "#6b7280",
    textClass: "text-gray-400",
    bgClass: "bg-gray-500/10",
    borderClass: "border-gray-500/20",
    labelKey: "taskProgress.status.cancelled",
  },
  unknown: {
    color: "#f59e0b",
    textClass: "text-amber-300",
    bgClass: "bg-amber-500/10",
    borderClass: "border-amber-500/20",
    labelKey: "taskProgress.status.unknown",
  },
};

export function taskProgressSegments(progress: SessionTodoSummary | SessionTodoSnapshot) {
  return [
    { status: "completed" as const, value: progress.completed },
    { status: "in_progress" as const, value: progress.inProgress },
    { status: "pending" as const, value: progress.pending },
    { status: "cancelled" as const, value: progress.cancelled },
    { status: "unknown" as const, value: progress.unknown },
  ].filter((segment) => segment.value > 0);
}

export function taskSourceLabel(sourceTool: string | null | undefined, fallbackLabel: string) {
  if (!sourceTool) return fallbackLabel;
  if (sourceTool === "update_plan") return "Codex update_plan";
  if (sourceTool === "TodoWrite") return "Claude TodoWrite";
  if (sourceTool.startsWith("Task")) return `Claude ${sourceTool}`;
  return sourceTool;
}

export function taskProgressAriaLabel(
  progress: SessionTodoSummary | SessionTodoSnapshot,
  completeWord = "complete"
) {
  return `${progress.completed} of ${progress.total} ${completeWord}`;
}
