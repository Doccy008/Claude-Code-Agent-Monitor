/**
 * @file session-detail-tools.ts
 * @description MCP tools for session facets, computed detail statistics, and
 * provider-aware transcript discovery and cursor-paginated conversation reads.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `mcp/src/tools/domains/session-detail-tools.ts`
 * **Purpose:** Part of the local MCP server (`npm run mcp:start`) that exposes dashboard operations as MCP tools for Claude Code and other hosts.
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
 * - `registerSessionDetailTools` — exported API; see TSDoc on the symbol for behavior.
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
 * **registerSessionDetailTools**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

import { z } from "zod";
import { registrarFor } from "../../core/tool-registry.js";
import type { ToolContext } from "../../types/tool-context.js";

export function registerSessionDetailTools(context: ToolContext): void {
  const { api } = context;
  const register = registrarFor(context);

  register(
    "dashboard_get_session_facets",
    "Get distinct session filter values for project, model, provider, source, and status selectors.",
    {
      sources: z.string().max(4096).optional(),
      providers: z.string().max(256).optional(),
    },
    async (args) =>
      api.get("/api/sessions/facets", {
        query: {
          sources: args.sources as string | undefined,
          providers: args.providers as string | undefined,
        },
      })
  );

  register(
    "dashboard_get_session_stats",
    "Get one session's overview metrics, top tools, subagent breakdown, and token totals.",
    {
      session_id: z.string().min(1).max(256),
      sources: z.string().max(4096).optional(),
      providers: z.string().max(256).optional(),
    },
    async (args) =>
      api.get(`/api/sessions/${encodeURIComponent(args.session_id as string)}/stats`, {
        query: {
          sources: args.sources as string | undefined,
          providers: args.providers as string | undefined,
        },
      })
  );

  register(
    "dashboard_list_session_transcripts",
    "List the main and nested transcript sources available for one session.",
    {
      session_id: z.string().min(1).max(256),
      sources: z.string().max(4096).optional(),
      providers: z.string().max(256).optional(),
    },
    async (args) =>
      api.get(`/api/sessions/${encodeURIComponent(args.session_id as string)}/transcripts`, {
        query: {
          sources: args.sources as string | undefined,
          providers: args.providers as string | undefined,
        },
      })
  );

  register(
    "dashboard_get_session_transcript",
    "Read a cursor-paginated session transcript, optionally selecting a nested agent run.",
    {
      session_id: z.string().min(1).max(256),
      agent_id: z.string().max(256).optional(),
      run_id: z.string().max(512).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).max(1_000_000).optional(),
      after: z.number().int().min(0).optional(),
      before: z.number().int().min(0).optional(),
      sources: z.string().max(4096).optional(),
      providers: z.string().max(256).optional(),
    },
    async (args) =>
      api.get(`/api/sessions/${encodeURIComponent(args.session_id as string)}/transcript`, {
        query: {
          agent_id: args.agent_id as string | undefined,
          run_id: args.run_id as string | undefined,
          limit: (args.limit as number | undefined) ?? 100,
          offset: args.offset as number | undefined,
          after: args.after as number | undefined,
          before: args.before as number | undefined,
          sources: args.sources as string | undefined,
          providers: args.providers as string | undefined,
        },
      })
  );

  register(
    "dashboard_get_transcript_image",
    "Fetch one persisted transcript image as base64 without exposing its local filesystem path.",
    {
      session_id: z.string().min(1).max(256),
      line: z.number().int().min(1),
      index: z.number().int().min(0),
      agent_id: z.string().max(256).optional(),
      run_id: z.string().max(512).optional(),
      sources: z.string().max(4096).optional(),
      providers: z.string().max(256).optional(),
    },
    async (args) =>
      api.getBinary(
        `/api/sessions/${encodeURIComponent(args.session_id as string)}/transcript-image`,
        {
          line: args.line as number,
          index: args.index as number,
          agent_id: args.agent_id as string | undefined,
          run_id: args.run_id as string | undefined,
          sources: args.sources as string | undefined,
          providers: args.providers as string | undefined,
        }
      )
  );

  register(
    "dashboard_get_event_facets",
    "Get distinct event filter values used by the Activity Feed.",
    {
      sources: z.string().max(4096).optional(),
      providers: z.string().max(256).optional(),
    },
    async (args) =>
      api.get("/api/events/facets", {
        query: {
          sources: args.sources as string | undefined,
          providers: args.providers as string | undefined,
        },
      })
  );
}
