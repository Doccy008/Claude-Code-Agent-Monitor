/**
 * @file settings-tools.ts
 * @description MCP tools for dashboard update status, hook installation, and
 * live-safe Claude Code/Codex home-directory configuration.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `mcp/src/tools/domains/settings-tools.ts`
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
 * - `../../policy/tool-guards.js`
 * - `../../types/tool-context.js`
 *
 * ## Public surface
 * - `registerSettingsTools` — exported API; see TSDoc on the symbol for behavior.
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
 * **registerSettingsTools**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

import { z } from "zod";
import { registrarFor } from "../../core/tool-registry.js";
import { assertMutationsEnabled } from "../../policy/tool-guards.js";
import type { ToolContext } from "../../types/tool-context.js";

export function registerSettingsTools(context: ToolContext): void {
  const { api, config } = context;
  const register = registrarFor(context);

  register(
    "dashboard_get_update_status",
    "Get cached or current upstream checkout status.",
    {},
    async () => api.get("/api/updates/status")
  );

  register(
    "dashboard_check_for_updates",
    "Refresh upstream checkout status and broadcast the result to connected dashboards.",
    {},
    async () => api.post("/api/updates/check")
  );

  register(
    "dashboard_get_agent_homes",
    "Get the active Claude Code and Codex state directories.",
    {},
    async () => {
      const [claude, codex] = await Promise.all([
        api.get("/api/settings/claude-home"),
        api.get("/api/settings/codex-home"),
      ]);
      return { claude, codex };
    }
  );

  register(
    "dashboard_set_claude_home",
    "Set the Claude Code state directory used by hook and transcript discovery.",
    { path: z.string().min(1).max(4096) },
    async (args) => {
      assertMutationsEnabled(config);
      return api.put("/api/settings/claude-home", { body: { path: args.path } });
    }
  );

  register(
    "dashboard_set_codex_home",
    "Set the Codex state directory and re-arm the live rollout synchronizer.",
    { path: z.string().min(1).max(4096) },
    async (args) => {
      assertMutationsEnabled(config);
      return api.put("/api/settings/codex-home", { body: { path: args.path } });
    }
  );

  register(
    "dashboard_install_hooks",
    "Install or update the selected Claude Code and Codex hook integrations.",
    {
      providers: z
        .array(z.enum(["claude", "codex"]))
        .min(1)
        .max(2)
        .refine((providers) => new Set(providers).size === providers.length, {
          message: "providers must not contain duplicates",
        }),
    },
    async (args) => {
      assertMutationsEnabled(config);
      return api.post("/api/settings/install-hooks", { body: { providers: args.providers } });
    }
  );
}
