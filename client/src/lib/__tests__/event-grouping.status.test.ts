/**
 * @file event-grouping.status.test.ts
 * @description Locks down the single event_type → badge-status mapping shared
 * by the Dashboard, Activity Feed, and Session Detail event streams, and keeps
 * the EventFilters status presets its exact inverse. Both had diverged: the
 * Dashboard hand-rolled a mapping that knew only three types, and neither knew
 * any provider-native prompt type, so Cursor/Codex rows could render a
 * misleading yellow "Waiting" badge (issue #310).
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { describe, it, expect } from "vitest";
import { statusFromEventType, activityStatusFromEvent } from "../event-grouping";
import { STATUS_TO_EVENT_TYPES, expandStatusToEventTypes } from "../../components/EventFilters";

describe("statusFromEventType", () => {
  it.each([
    ["PreToolUse", "working"],
    ["UserPromptSubmit", "working"],
    ["PostToolUse", "waiting"],
    ["Stop", "completed"],
    ["SessionEnd", "completed"],
    ["SubagentStop", "completed"],
    ["Compaction", "completed"],
    ["APIError", "error"],
    ["error", "error"],
  ])("maps the Claude event %s to %s", (type, expected) => {
    expect(statusFromEventType(type)).toBe(expected);
  });

  it.each([
    ["cursor_user_message", "working"],
    ["codex_user_message", "working"],
    ["codex_task_started", "working"],
    ["codex_tool_call", "working"],
    ["codex_exec_command_end", "waiting"],
    ["codex_mcp_tool_call_end", "waiting"],
    ["codex_web_search_end", "waiting"],
    ["codex_task_complete", "completed"],
    ["codex_context_compacted", "completed"],
    ["codex_error", "error"],
  ])("maps the Cursor/Codex event %s to %s", (type, expected) => {
    expect(statusFromEventType(type)).toBe(expected);
  });

  it.each(["SessionStart", "Notification", "TurnDuration", "codex_turn_aborted"])(
    "leaves %s neutral — it carries no reliable progress meaning",
    (type) => {
      expect(statusFromEventType(type)).toBe("waiting");
    }
  );

  it("degrades an unknown or newer event type to a neutral badge", () => {
    expect(statusFromEventType("SomeFutureHook")).toBe("waiting");
    expect(statusFromEventType("")).toBe("waiting");
  });
});

describe("activityStatusFromEvent", () => {
  it("follows the shared mapping by default", () => {
    expect(
      activityStatusFromEvent({ event_type: "codex_task_started", summary: "task_started" })
    ).toBe("working");
    expect(activityStatusFromEvent({ event_type: "codex_task_complete", summary: "DONE" })).toBe(
      "completed"
    );
  });

  it("lets a failure reported in the summary win over the event type", () => {
    expect(activityStatusFromEvent({ event_type: "Stop", summary: "Stopped after an error" })).toBe(
      "error"
    );
  });

  it("tolerates a missing summary", () => {
    expect(activityStatusFromEvent({ event_type: "PreToolUse" })).toBe("working");
    expect(activityStatusFromEvent({ event_type: "PreToolUse", summary: null })).toBe("working");
  });
});

describe("EventFilters status presets", () => {
  it("stays the exact inverse of the badge mapping", () => {
    for (const [status, types] of Object.entries(STATUS_TO_EVENT_TYPES)) {
      for (const type of types) {
        expect(statusFromEventType(type), `${type} should filter under "${status}"`).toBe(status);
      }
    }
  });

  it("expands a preset selection into its event types", () => {
    expect(expandStatusToEventTypes(["error"]).sort()).toEqual([
      "APIError",
      "codex_error",
      "error",
    ]);
    expect(expandStatusToEventTypes(["working"])).toContain("codex_tool_call");
    expect(expandStatusToEventTypes([])).toEqual([]);
    expect(expandStatusToEventTypes(["nope"])).toEqual([]);
  });
});
