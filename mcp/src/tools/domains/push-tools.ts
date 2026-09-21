/**
 * @file push-tools.ts
 * @description MCP tools for the browser push-notification API, including
 * VAPID discovery, subscription management, and test notification delivery.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `mcp/src/tools/domains/push-tools.ts`
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
 * - `registerPushTools` — exported API; see TSDoc on the symbol for behavior.
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
 * **registerPushTools**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

import { z } from "zod";
import { registrarFor } from "../../core/tool-registry.js";
import { assertMutationsEnabled } from "../../policy/tool-guards.js";
import type { ToolContext } from "../../types/tool-context.js";

const PushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(8192),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1).max(4096),
    auth: z.string().min(1).max(4096),
  }),
});

export function registerPushTools(context: ToolContext): void {
  const { api, config } = context;
  const register = registrarFor(context);

  register(
    "dashboard_get_push_public_key",
    "Get the dashboard VAPID public key used by browser push subscriptions.",
    {},
    async () => api.get("/api/push/vapid-public-key")
  );

  register(
    "dashboard_subscribe_push",
    "Register a browser PushSubscription object with the dashboard.",
    { subscription: PushSubscriptionSchema },
    async (args) => {
      assertMutationsEnabled(config);
      return api.post("/api/push/subscribe", { body: args.subscription });
    }
  );

  register(
    "dashboard_unsubscribe_push",
    "Remove a browser push subscription by endpoint.",
    { endpoint: z.string().url().max(8192) },
    async (args) => {
      assertMutationsEnabled(config);
      return api.delete("/api/push/subscribe", { body: { endpoint: args.endpoint } });
    }
  );

  register(
    "dashboard_send_push_notification",
    "Send one browser push notification to registered subscriptions. This has an external side effect.",
    {
      title: z.string().min(1).max(256),
      body: z.string().min(1).max(4096),
    },
    async (args) => {
      assertMutationsEnabled(config);
      return api.post("/api/push/send", { body: args });
    }
  );
}
