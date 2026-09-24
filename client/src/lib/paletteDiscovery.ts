/**
 * @file paletteDiscovery.ts
 * @description Tracks whether this browser has ever opened the command palette,
 * so the hints that teach `Cmd/Ctrl+K` can delete themselves once they have done
 * their job.
 *
 * The palette is keyboard-only by design — a launcher button beside the sidebar
 * duplicates navigation the sidebar already shows — which leaves it invisible to
 * anyone who has not been told it exists. The answer is not permanent chrome for
 * a fact you learn in one second. It is a hint that appears where the need is
 * felt (the splash on first run, and beside the narrow search field a user is
 * already typing into) and never renders again after the first successful open.
 *
 * State lives in `localStorage`, not `sessionStorage`: discovery is a property of
 * the person, not of the tab. Every access is wrapped — storage throws in private
 * mode and in embedded webviews — and a failure degrades to "not yet discovered",
 * because showing a hint twice is a nuisance while never showing it is the bug
 * this module exists to fix.
 *
 * @author Son Nguyen <hoangson091104@gmail.com>
 */
/* =============================================================================
 * MODULE_GUIDE — extended in-file reference (comments only; safe to read, never executed)
 * =============================================================================
 * **Path:** `client/src/lib/paletteDiscovery.ts`
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
 * - `hasDiscoveredPalette` — exported API; see TSDoc on the symbol for behavior.
 * - `markPaletteDiscovered` — exported API; see TSDoc on the symbol for behavior.
 * - `subscribeToPaletteDiscovery` — exported API; see TSDoc on the symbol for behavior.
 * - `useShowPaletteHint` — exported API; see TSDoc on the symbol for behavior.
 * - `resetPaletteDiscovery` — exported API; see TSDoc on the symbol for behavior.
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
 * **hasDiscoveredPalette**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * **markPaletteDiscovered**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * **subscribeToPaletteDiscovery**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * **useShowPaletteHint**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * **resetPaletteDiscovery**
 *   Part of this module's public contract. Downstream imports should treat
 *   the signature and return type as stable unless release notes say otherwise.
 *   When behavior changes, update the `@file` overview and relevant tests.
 *
 * ----------------------------------------------------------------------------- */

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "ccam-palette-discovered";

/** In-memory mirror so a hint hides the instant the palette opens. */
let discovered = read();
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Has this browser ever opened the palette? */
export function hasDiscoveredPalette(): boolean {
  return discovered;
}

/**
 * Record that the palette has been opened. Idempotent, and safe to call on every
 * open — subscribers are only notified on the transition, so the hints do not
 * re-render for the rest of the session.
 */
export function markPaletteDiscovered(): void {
  if (discovered) return;
  discovered = true;
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // The in-memory flag still hides the hints for this session; the worst case
    // is that they return on the next visit, which is the safe direction.
  }
  listeners.forEach((listener) => listener());
}

/** Subscribe to the one transition this store can make. */
export function subscribeToPaletteDiscovery(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * True while the `Cmd/Ctrl+K` hints should still be shown.
 *
 * @returns `false` once the palette has been opened, permanently.
 */
export function useShowPaletteHint(): boolean {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToPaletteDiscovery(listener),
    []
  );
  return !useSyncExternalStore(subscribe, hasDiscoveredPalette, () => true);
}

/** Reset discovery. Test-only; nothing in the app un-teaches a shortcut. */
export function resetPaletteDiscovery(): void {
  discovered = false;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clean up if it was never written */
  }
  listeners.forEach((listener) => listener());
}
