/**
 * @file PaginatedLegend.tsx
 * @description Reusable chart legend container that keeps short legends
 * unchanged and pages longer label sets into a bounded, accessible control.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `client/src/components/PaginatedLegend.tsx`
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
 * - `PaginatedLegendProps` — exported API; see TSDoc on the symbol for behavior.
 * - `PaginatedLegend` — exported API; see TSDoc on the symbol for behavior.
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
 * **PaginatedLegendProps**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * **PaginatedLegend**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

import { useEffect, useMemo, useState, type Key, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface PaginatedLegendProps<T> {
  items: readonly T[];
  getKey: (item: T, index: number) => Key;
  renderItem: (item: T, index: number) => ReactNode;
  pageSize?: number;
  className?: string;
  listClassName?: string;
  controlsClassName?: string;
}

/**
 * Render every item directly when it fits. Larger legends expose only one
 * bounded page at a time and keep all remaining labels reachable.
 */
export function PaginatedLegend<T>({
  items,
  getKey,
  renderItem,
  pageSize = 6,
  className = "",
  listClassName = "",
  controlsClassName = "",
}: PaginatedLegendProps<T>) {
  const { t } = useTranslation("common");
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const pageCount = Math.max(1, Math.ceil(items.length / safePageSize));
  const [page, setPage] = useState(0);
  const currentPage = Math.min(page, pageCount - 1);

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  const pageItems = useMemo(() => {
    const start = currentPage * safePageSize;
    return items.slice(start, start + safePageSize);
  }, [currentPage, items, safePageSize]);

  const start = items.length === 0 ? 0 : currentPage * safePageSize + 1;
  const end = Math.min((currentPage + 1) * safePageSize, items.length);

  return (
    <div className={className}>
      <div className={listClassName}>
        {pageItems.map((item, index) => {
          const absoluteIndex = currentPage * safePageSize + index;
          return <div key={getKey(item, absoluteIndex)}>{renderItem(item, absoluteIndex)}</div>;
        })}
      </div>

      {pageCount > 1 && (
        <div
          className={`mt-2 flex items-center justify-between gap-2 border-t border-border/70 pt-2 ${controlsClassName}`}
        >
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface-2 text-gray-400 transition-colors hover:border-gray-600 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-35"
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            disabled={currentPage === 0}
            aria-label={t("pagination.previous")}
          >
            <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <span className="text-[10px] tabular-nums text-gray-600" aria-live="polite">
            {t("pagination.showing", { from: start, to: end, total: items.length })}
          </span>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface-2 text-gray-400 transition-colors hover:border-gray-600 hover:text-gray-200 disabled:cursor-not-allowed disabled:opacity-35"
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            disabled={currentPage === pageCount - 1}
            aria-label={t("pagination.next")}
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
