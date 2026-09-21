/**
 * @file Dashboard.agentDedupe.test.tsx
 * @description Regression test: the Dashboard fetches the working and waiting
 * agent lanes in two parallel requests and concatenated the results, so an agent
 * that flipped status between the responses — routine for Codex, which toggles
 * working/waiting every turn — rendered twice, once per status. The merged list
 * must hold one card per agent id, showing the freshest status.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { Dashboard } from "../Dashboard";
import type { Agent, Session } from "../../lib/types";

// jsdom lacks the responsive-layout API the Dashboard observes.
class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver || (ObserverStub as unknown as typeof ResizeObserver);

const SESSION_ID = "01a0b895-45b7-7b20-8a91-17a947d412b8";
const AGENT_ID = `codex:${SESSION_ID}`;
const SESSION_NAME = "Implement AI collaboration skills";

function codexAgent(overrides: Partial<Agent>): Agent {
  return {
    id: AGENT_ID,
    session_id: SESSION_ID,
    name: "Codex",
    type: "main",
    subagent_type: null,
    status: "working",
    task: null,
    current_tool: null,
    started_at: "2026-09-19T07:33:05.618Z",
    ended_at: null,
    updated_at: "2026-09-20T03:05:03.691Z",
    parent_agent_id: null,
    metadata: null,
    ...overrides,
  } as Agent;
}

const codexSession = {
  id: SESSION_ID,
  name: SESSION_NAME,
  status: "active",
  cwd: "/Users/dev/AI-Coding-Tools-Collaborative",
  model: "gpt-5.6-luna",
  started_at: "2026-09-19T07:33:05.618Z",
  ended_at: null,
  metadata: null,
  provider: "codex",
} as unknown as Session;

vi.mock("../../lib/api", () => ({
  api: {
    stats: {
      get: vi.fn(() =>
        Promise.resolve({
          total_sessions: 1,
          active_sessions: 1,
          active_agents: 1,
          total_agents: 1,
          total_events: 0,
          events_today: 0,
          ws_connections: 0,
          agents_by_status: {},
          sessions_by_status: {},
        })
      ),
    },
    agents: {
      // The race itself: the same agent is still in the waiting lane's snapshot
      // while the working lane already reports its newer status.
      list: vi.fn((params?: { status?: string; session_id?: string }) => {
        if (params?.session_id) return Promise.resolve({ agents: [] });
        if (params?.status === "working") {
          return Promise.resolve({
            agents: [codexAgent({ status: "working", updated_at: "2026-09-20T03:05:03.691Z" })],
          });
        }
        if (params?.status === "waiting") {
          return Promise.resolve({
            agents: [
              codexAgent({
                status: "waiting",
                awaiting_reason: "stop",
                updated_at: "2026-09-20T03:04:58.100Z",
              } as Partial<Agent>),
            ],
          });
        }
        return Promise.resolve({ agents: [] });
      }),
    },
    events: { list: vi.fn(() => Promise.resolve({ events: [], total: 0 })) },
    pricing: { totalCost: vi.fn(() => Promise.resolve({ total_cost: 0 })) },
    sessions: { list: vi.fn(() => Promise.resolve({ sessions: [codexSession] })) },
    settings: { info: vi.fn(() => Promise.resolve({})) },
    workflows: { get: vi.fn(() => Promise.resolve({})) },
  },
}));

vi.mock("../../lib/eventBus", () => ({
  eventBus: {
    subscribe: vi.fn(() => () => {}),
    onConnection: vi.fn(() => () => {}),
    connected: true,
  },
}));

describe("Dashboard - active agent lanes", () => {
  it("renders one card for an agent caught in both the working and waiting lanes", async () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getAllByText(new RegExp(SESSION_NAME)).length).toBe(1));
    // The freshest row wins, so the single card reports the live status rather
    // than the stale Waiting copy.
    expect(screen.getAllByText("Working").length).toBeGreaterThan(0);
    expect(screen.queryByText("Waiting")).toBeNull();
  });
});
