/**
 * @file import-tools.ts
 * @description MCP tools for provider-aware history discovery/import and
 * idempotent restoration of a dashboard export from a local JSON file.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `mcp/src/tools/domains/import-tools.ts`
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
 * - `registerImportTools` — exported API; see TSDoc on the symbol for behavior.
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
 * **registerImportTools**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

import { z } from "zod";
import { registrarFor } from "../../core/tool-registry.js";
import { assertMutationsEnabled } from "../../policy/tool-guards.js";
import type { ToolContext } from "../../types/tool-context.js";

const ProviderSchema = z.enum(["claude", "codex"]);

export function registerImportTools(context: ToolContext): void {
  const { api, config } = context;
  const register = registrarFor(context);

  register(
    "dashboard_get_import_guide",
    "Get provider-aware history locations, archive commands, supported files, and import limits.",
    { provider: ProviderSchema.optional() },
    async (args) =>
      api.get("/api/import/guide", {
        query: { provider: (args.provider as string | undefined) ?? "claude" },
      })
  );

  register(
    "dashboard_rescan_history",
    "Rescan the selected provider's configured default history directory.",
    { provider: ProviderSchema.optional() },
    async (args) => {
      assertMutationsEnabled(config);
      return api.post("/api/import/rescan", {
        body: { provider: (args.provider as string | undefined) ?? "claude" },
      });
    }
  );

  register(
    "dashboard_import_history_path",
    "Import Claude Code or Codex history from an existing absolute directory on the dashboard host.",
    {
      path: z.string().min(1).max(4096),
      provider: ProviderSchema.optional(),
    },
    async (args) => {
      assertMutationsEnabled(config);
      return api.post("/api/import/scan-path", {
        body: {
          path: args.path,
          provider: (args.provider as string | undefined) ?? "claude",
        },
      });
    }
  );

  register(
    "dashboard_upload_history_files",
    "Upload local Claude Code or Codex JSONL/archive files through the same multipart importer used by the app.",
    {
      paths: z.array(z.string().min(1).max(4096)).min(1).max(100),
      provider: ProviderSchema.optional(),
    },
    async (args) => {
      assertMutationsEnabled(config);
      return api.postFiles("/api/import/upload", args.paths as string[], {
        provider: (args.provider as string | undefined) ?? "claude",
      });
    }
  );

  register(
    "dashboard_restore_export",
    "Restore an exported dashboard JSON bundle from an absolute local file path. Existing rows are never overwritten.",
    { path: z.string().min(1).max(4096) },
    async (args) => {
      assertMutationsEnabled(config);
      return api.post("/api/settings/import", { body: { path: args.path } });
    }
  );
}
