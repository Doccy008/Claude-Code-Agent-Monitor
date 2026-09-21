/**
 * @file usePageShortcuts.ts
 * @description Keeps a page's tab or filter selection in the URL.
 *
 * This is what lets the command palette address a page's interior — a Settings
 * section, an Analytics tab, the active-session filter — and what makes those
 * links shareable. Without it the palette could only ever reach a page, never a
 * view inside it.
 *
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `client/src/hooks/usePageShortcuts.ts`
 * **Purpose:** React hook: isolates side effects and subscription wiring so presentational components stay declarative.
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
 * - `useUrlTab` — exported API; see TSDoc on the symbol for behavior.
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
 * **useUrlTab**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

import { useCallback } from "react";
import { useSearchParams } from "react-router";

/**
 * Keep a tab selection in the URL so the palette (and any bookmark, or a link a
 * user pastes to a colleague) can address a page's sub-view directly.
 *
 * The URL is the source of truth when it carries a valid value; otherwise the
 * optional `storageKey` restores the last choice, and finally `fallback` applies.
 * Selections replace the history entry rather than pushing one — flipping
 * between two tabs should not make Back mean "the tab I was just on".
 *
 * @param valid      Every accepted value; anything else in the URL is ignored.
 * @param fallback   Used when neither the URL nor storage has a valid value.
 * @param options.param      Query parameter name (default `tab`).
 * @param options.storageKey `localStorage` key to mirror the choice into.
 */
export function useUrlTab<T extends string>(
  valid: readonly T[],
  fallback: T,
  options: { param?: string; storageKey?: string } = {}
): [T, (tab: T) => void] {
  const { param = "tab", storageKey } = options;
  const [searchParams, setSearchParams] = useSearchParams();

  const fromUrl = searchParams.get(param);
  const stored = (() => {
    if (!storageKey) return null;
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  })();

  const isValid = (value: string | null): value is T =>
    value !== null && (valid as readonly string[]).includes(value);

  const active: T = isValid(fromUrl) ? fromUrl : isValid(stored) ? stored : fallback;

  const setActive = useCallback(
    (tab: T) => {
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, tab);
        } catch {
          /* preference persistence is best-effort */
        }
      }
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          // An empty value is a page's "no filter" pseudo-option; writing
          // `?status=` for it would leave a meaningless parameter in every
          // link the user copies.
          if (tab === "") next.delete(param);
          else next.set(param, tab);
          return next;
        },
        { replace: true }
      );
    },
    [param, storageKey, setSearchParams]
  );

  return [active, setActive];
}
