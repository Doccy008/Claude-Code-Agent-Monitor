/**
 * @file Merges records fetched from several status-scoped requests into a single
 * list holding one entry per id. Status lanes are requested in parallel, so a row
 * whose status flips mid-flight (a Codex agent going working → waiting) comes back
 * in two responses at once and would otherwise render as two cards for the same
 * session. The freshest copy wins, so the merged row shows the current status.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

interface Identified {
  id: string;
  /** Row mutation time — bumped exactly when status and metadata change. */
  updated_at?: string;
  /** Latest durable provider event for the row; unchanged by a status flip. */
  last_activity?: string;
  started_at?: string;
}

/**
 * Row mutation time first: `updated_at` moves precisely when a status changes,
 * while `last_activity` is event-derived and identical across the two copies of
 * a row caught mid-flip.
 */
function freshness(record: Identified): number {
  for (const value of [record.updated_at, record.last_activity, record.started_at]) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * Concatenate groups, keeping the freshest record per id. First-appearance order
 * is preserved so existing list ordering (working lane before waiting lane) is
 * unchanged; ties keep the earlier group's copy.
 */
export function mergeFreshestById<T extends Identified>(...groups: T[][]): T[] {
  const merged = new Map<string, T>();
  for (const group of groups) {
    for (const record of group || []) {
      if (!record || typeof record.id !== "string") continue;
      const existing = merged.get(record.id);
      if (!existing || freshness(record) > freshness(existing)) {
        merged.set(record.id, record);
      }
    }
  }
  return [...merged.values()];
}
