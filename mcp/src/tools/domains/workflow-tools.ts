/**
 * @file workflow-tools.ts
 * @description MCP tools for aggregate and per-session workflow intelligence,
 * including Workflow-tool run journals and individual run drill-down.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `mcp/src/tools/domains/workflow-tools.ts`
 * **Purpose:** Workflow analytics visualization built on D3; consumes aggregated session/run metrics from the workflows API.
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
 * - `../../core/tool-registry.js`
 * - `../../types/tool-context.js`
 *
 * ## Public surface
 * - `registerWorkflowTools` — exported API; see TSDoc on the symbol for behavior.
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
 * **registerWorkflowTools**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

import { z } from "zod";
import { registrarFor } from "../../core/tool-registry.js";
import type { ToolContext } from "../../types/tool-context.js";

export function registerWorkflowTools(context: ToolContext): void {
  const { api } = context;
  const register = registrarFor(context);

  register(
    "dashboard_get_workflows",
    "Get aggregate workflow intelligence, optionally filtered by lifecycle status and data source.",
    {
      status: z.string().max(64).optional(),
      sources: z.string().max(4096).optional(),
      providers: z.string().max(256).optional(),
    },
    async (args) =>
      api.get("/api/workflows", {
        query: {
          status: args.status as string | undefined,
          sources: args.sources as string | undefined,
          providers: args.providers as string | undefined,
        },
      })
  );

  register(
    "dashboard_get_session_workflow",
    "Get workflow intelligence reconstructed for one session.",
    {
      session_id: z.string().min(1).max(256),
      sources: z.string().max(4096).optional(),
      providers: z.string().max(256).optional(),
    },
    async (args) =>
      api.get(`/api/workflows/session/${encodeURIComponent(args.session_id as string)}`, {
        query: {
          sources: args.sources as string | undefined,
          providers: args.providers as string | undefined,
        },
      })
  );

  register(
    "dashboard_list_workflow_runs",
    "List Workflow-tool fleet runs with optional status and launching-session filters.",
    {
      status: z.string().max(64).optional(),
      session_id: z.string().max(256).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).max(100_000).optional(),
    },
    async (args) =>
      api.get("/api/workflows/runs", {
        query: {
          status: args.status as string | undefined,
          session_id: args.session_id as string | undefined,
          limit: (args.limit as number | undefined) ?? 50,
          offset: (args.offset as number | undefined) ?? 0,
        },
      })
  );

  register(
    "dashboard_get_workflow_run",
    "Get one Workflow-tool fleet run with its per-agent phases, metrics, prompts, and results.",
    {
      run_id: z.string().min(1).max(512),
      sources: z.string().max(4096).optional(),
      providers: z.string().max(256).optional(),
    },
    async (args) =>
      api.get(`/api/workflows/runs/${encodeURIComponent(args.run_id as string)}`, {
        query: {
          sources: args.sources as string | undefined,
          providers: args.providers as string | undefined,
        },
      })
  );
}
