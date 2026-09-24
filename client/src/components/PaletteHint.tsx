/**
 * @file PaletteHint.tsx
 * @description The `⌘K` chip shown beside a page's own search field, teaching the
 * global palette at the moment the user is already searching for something.
 *
 * It decorates an input that exists rather than adding chrome of its own, and it
 * renders `null` forever once the palette has been opened once — a permanent
 * affordance for a fact you learn in a second is a bad trade. Purely
 * informational: `aria-hidden`, `pointer-events-none`, and never focusable, so it
 * neither intercepts a click into the field nor adds a stop for keyboard and
 * screen-reader users, who reach the palette by the chord itself.
 *
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `client/src/components/PaletteHint.tsx`
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
 * - `../lib/paletteDiscovery`
 *
 * ## Public surface
 * - `paletteChordLabel` — exported API; see TSDoc on the symbol for behavior.
 * - `PaletteHint` — exported API; see TSDoc on the symbol for behavior.
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
 * **paletteChordLabel**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * **PaletteHint**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

import { useShowPaletteHint } from "../lib/paletteDiscovery";

/**
 * True on Apple platforms. `userAgentData` first — `navigator.platform` is
 * deprecated and lies under some privacy modes — and falsy wherever the platform
 * cannot be determined, because rendering `Ctrl` on a Mac is a smaller error than
 * rendering `⌘` on Windows.
 */
function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform =
    (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Platform-correct label for the palette chord, e.g. `⌘K` or `Ctrl K`. */
export function paletteChordLabel(): string {
  return isMacPlatform() ? "⌘K" : "Ctrl K";
}

interface PaletteHintProps {
  /**
   * `absolute` pins the chip inside a `relative` field wrapper (the Sessions
   * search box); `inline` sits in a flex row beside the input (Agent Config).
   */
  variant?: "absolute" | "inline";
}

/** Renders the chord chip, or nothing once the palette has been discovered. */
export function PaletteHint({ variant = "inline" }: PaletteHintProps) {
  const show = useShowPaletteHint();
  if (!show) return null;

  return (
    <kbd
      aria-hidden="true"
      className={`pointer-events-none select-none rounded border border-border bg-surface-2 px-1.5 py-0.5 font-sans text-[10px] text-gray-500 ${
        variant === "absolute" ? "absolute right-2.5 top-1/2 -translate-y-1/2" : "flex-shrink-0"
      }`}
    >
      {paletteChordLabel()}
    </kbd>
  );
}
