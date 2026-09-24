/**
 * @file alert-tools.ts
 * @description MCP tools for fired-alert inspection, acknowledgment, and
 * alert-rule lifecycle management through the dashboard alerting API.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `mcp/src/tools/domains/alert-tools.ts`
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
 * - `../schemas.js`
 * - `../../types/tool-context.js`
 *
 * ## Public surface
 * - `registerAlertTools` — exported API; see TSDoc on the symbol for behavior.
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
 * **registerAlertTools**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

import { z } from "zod";
import { registrarFor } from "../../core/tool-registry.js";
import { assertMutationsEnabled } from "../../policy/tool-guards.js";
import { JsonObjectSchema } from "../schemas.js";
import type { ToolContext } from "../../types/tool-context.js";

const AlertRuleTypeSchema = z.enum([
  "token_threshold",
  "event_pattern",
  "inactivity",
  "status_duration",
]);

export function registerAlertTools(context: ToolContext): void {
  const { api, config } = context;
  const register = registrarFor(context);

  register(
    "dashboard_list_alerts",
    "List fired alerts, optionally restricted to unacknowledged events.",
    {
      unacked: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().min(0).max(100_000).optional(),
    },
    async (args) =>
      api.get("/api/alerts", {
        query: {
          unacked: args.unacked as boolean | undefined,
          limit: (args.limit as number | undefined) ?? 50,
          offset: (args.offset as number | undefined) ?? 0,
        },
      })
  );

  register("dashboard_list_alert_rules", "List configured alert rules.", {}, async () =>
    api.get("/api/alerts/rules")
  );

  register(
    "dashboard_acknowledge_alert",
    "Acknowledge one fired alert event.",
    { alert_id: z.number().int().positive() },
    async (args) => {
      assertMutationsEnabled(config);
      return api.post(`/api/alerts/${args.alert_id as number}/ack`);
    }
  );

  register(
    "dashboard_acknowledge_all_alerts",
    "Acknowledge every currently unacknowledged alert event.",
    {},
    async () => {
      assertMutationsEnabled(config);
      return api.post("/api/alerts/ack-all");
    }
  );

  register(
    "dashboard_create_alert_rule",
    "Create an alert rule for token thresholds, event patterns, inactivity, or status duration.",
    {
      name: z.string().min(1).max(256),
      rule_type: AlertRuleTypeSchema,
      rule_config: JsonObjectSchema,
      enabled: z.boolean().optional(),
      cooldown_seconds: z.number().int().min(0).max(31_536_000).optional(),
    },
    async (args) => {
      assertMutationsEnabled(config);
      return api.post("/api/alerts/rules", {
        body: {
          name: args.name,
          rule_type: args.rule_type,
          config: args.rule_config,
          enabled: args.enabled,
          cooldown_seconds: args.cooldown_seconds,
        },
      });
    }
  );

  register(
    "dashboard_update_alert_rule",
    "Update one alert rule. Its rule type is immutable.",
    {
      rule_id: z.string().min(1).max(256),
      name: z.string().min(1).max(256).optional(),
      rule_config: JsonObjectSchema.optional(),
      enabled: z.boolean().optional(),
      cooldown_seconds: z.number().int().min(0).max(31_536_000).optional(),
    },
    async (args) => {
      assertMutationsEnabled(config);
      return api.patch(`/api/alerts/rules/${encodeURIComponent(args.rule_id as string)}`, {
        body: {
          name: args.name,
          config: args.rule_config,
          enabled: args.enabled,
          cooldown_seconds: args.cooldown_seconds,
        },
      });
    }
  );

  register(
    "dashboard_delete_alert_rule",
    "Delete one alert rule and its fired-alert history.",
    { rule_id: z.string().min(1).max(256) },
    async (args) => {
      assertMutationsEnabled(config);
      return api.delete(`/api/alerts/rules/${encodeURIComponent(args.rule_id as string)}`);
    }
  );
}
