/**
 * @file cursor-support.test.js
 * @description Verifies native Cursor history discovery, metadata backfill,
 * durable transcript snapshots, subagent import, and conversation rendering.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { before, after, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const ROOT = path.join(os.tmpdir(), `cursor-support-${Date.now()}-${process.pid}`);
const CURSOR_HOME = path.join(ROOT, ".cursor");
const DATA_DIR = path.join(ROOT, "data");
const SESSION_ID = "1bace4f0-506a-436b-badd-16209a514803";
const TRANSCRIPT = path.join(
  CURSOR_HOME,
  "projects",
  "Users-example-project",
  "agent-transcripts",
  SESSION_ID,
  `${SESSION_ID}.jsonl`
);
const SUBAGENT_TRANSCRIPT = path.join(path.dirname(TRANSCRIPT), "subagents", "worker-a.jsonl");

process.env.DASHBOARD_DB_PATH = path.join(ROOT, "dashboard.db");
process.env.DASHBOARD_DATA_DIR = DATA_DIR;
process.env.DASHBOARD_CURSOR_HOME = CURSOR_HOME;
process.env.DASHBOARD_LIVENESS_PROBE = "0";
process.env.DASHBOARD_CURSOR_SYNC_MS = "0";

const { createApp, startServer } = require("../index");
const { db, stmts } = require("../db");
const { syncCursorSessions } = require("../lib/cursor-ingest");

let server;
let base;

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function request(urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on("error", reject);
  });
}

before(async () => {
  fs.mkdirSync(path.dirname(TRANSCRIPT), { recursive: true });
  fs.writeFileSync(
    TRANSCRIPT,
    jsonl([
      {
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "<timestamp>Friday, Sep 18, 2026, 9:02 PM (UTC-7)</timestamp>\n<user_query>Build the API</user_query>",
            },
          ],
        },
      },
      {
        role: "assistant",
        message: {
          content: [
            { type: "text", text: "I’ll inspect the project." },
            { type: "tool_use", id: "tool-1", name: "Read", input: { path: "README.md" } },
          ],
        },
      },
      { type: "turn_ended", status: "completed" },
    ])
  );
  fs.mkdirSync(path.dirname(SUBAGENT_TRANSCRIPT), { recursive: true });
  fs.writeFileSync(
    SUBAGENT_TRANSCRIPT,
    jsonl([
      { role: "user", message: { content: [{ type: "text", text: "Inspect routes" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "Done" }] } },
    ])
  );
  const chatDir = path.join(CURSOR_HOME, "chats", "workspace-a", SESSION_ID);
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(
    path.join(chatDir, "meta.json"),
    JSON.stringify({
      createdAtMs: Date.parse("2026-09-19T04:02:00.000Z"),
      updatedAtMs: Date.parse("2026-09-19T04:20:00.000Z"),
      hasConversation: true,
      title: "Ship the backend",
      cwd: "/Users/example/project",
    })
  );
  fs.writeFileSync(path.join(chatDir, "prompt_history.json"), JSON.stringify(["Build the API"]));

  const app = createApp();
  server = await startServer(app, 0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  if (db) db.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("Cursor local history", () => {
  it("backfills provider metadata, card context, subagents, and snapshots", async () => {
    // Reproduce a pre-v2.2.2 row created by Cursor's Claude-compatible hook:
    // the event existed, but CCAM had classified it as Claude and had only the
    // generic session/agent labels shown in the reported screenshot.
    stmts.insertSession.run(
      SESSION_ID,
      `Session ${SESSION_ID.slice(0, 8)}`,
      "active",
      null,
      "Grok 4.6",
      null
    );
    stmts.insertAgent.run(
      `${SESSION_ID}-main`,
      SESSION_ID,
      `Main Agent - Session ${SESSION_ID.slice(0, 8)}`,
      "main",
      null,
      "working",
      null,
      null,
      null
    );

    const result = await syncCursorSessions(require("../db"));
    assert.equal(result.filesScanned, 1);
    assert.equal(result.backfilled, 1);
    const session = stmts.getSession.get(SESSION_ID);
    assert.equal(session.provider, "cursor");
    assert.equal(session.name, "Ship the backend");
    assert.equal(session.cwd, "/Users/example/project");
    assert.equal(session.card_prompt_preview, "Build the API");
    assert.equal(JSON.parse(session.metadata).turn_count, 1);
    const agents = stmts.listAgentsBySession.all(SESSION_ID);
    assert.equal(agents.length, 2);
    assert.ok(agents.some((agent) => agent.name === "Cursor · Ship the backend"));
    assert.ok(agents.some((agent) => agent.task === "Inspect routes"));
    assert.ok(fs.existsSync(path.join(DATA_DIR, "cursor-transcripts", `${SESSION_ID}.jsonl`)));

    const unchanged = await syncCursorSessions(require("../db"));
    assert.equal(
      unchanged.skipped,
      1,
      "unchanged Cursor history should not be reparsed every poll"
    );

    fs.appendFileSync(
      SUBAGENT_TRANSCRIPT,
      jsonl([
        {
          role: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "sub-tool-1", name: "Read", input: { path: "app.js" } },
            ],
          },
        },
        { type: "turn_ended", status: "completed" },
      ])
    );
    const refreshedSubagent = await syncCursorSessions(require("../db"));
    assert.equal(refreshedSubagent.backfilled, 1);
    const subagent = stmts.getAgent.get(`${SESSION_ID}-cursor-worker-a`);
    assert.equal(subagent.status, "completed");
    assert.equal(JSON.parse(subagent.metadata).tool_count, 1);

    const stale = new Date(Date.now() - 11 * 60 * 1000);
    fs.utimesSync(TRANSCRIPT, stale, stale);
    const completed = await syncCursorSessions(require("../db"));
    assert.equal(completed.backfilled, 1);
    assert.equal(stmts.getSession.get(SESSION_ID).status, "completed");
    assert.equal(stmts.getAgent.get(`${SESSION_ID}-main`).status, "completed");

    fs.appendFileSync(TRANSCRIPT, jsonl([{ type: "turn_started" }]));
    const reactivated = await syncCursorSessions(require("../db"));
    assert.equal(reactivated.backfilled, 1);
    assert.equal(stmts.getSession.get(SESSION_ID).status, "active");
    assert.equal(stmts.getAgent.get(`${SESSION_ID}-main`).status, "waiting");
  });

  it("renders Cursor conversation records and survives source cleanup", async () => {
    fs.rmSync(path.join(CURSOR_HOME, "projects"), { recursive: true, force: true });
    const response = await request(`/api/sessions/${SESSION_ID}/transcript?limit=50`);
    assert.equal(response.status, 200);
    assert.equal(response.body.messages.length, 2);
    assert.equal(response.body.messages[0].content[0].text, "Build the API");
    assert.equal(response.body.messages[0].timestamp, "2026-09-19T04:02:00.000Z");
    assert.equal(response.body.messages[1].content[1].name, "Read");

    const list = await request(`/api/sessions/${SESSION_ID}/transcripts`);
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.transcripts.map((item) => item.id),
      ["main", "worker-a"]
    );

    const traversal = await request(
      `/api/sessions/${SESSION_ID}/transcript?agent_id=${encodeURIComponent(`../../${SESSION_ID}`)}`
    );
    assert.equal(traversal.status, 200);
    assert.deepEqual(traversal.body.messages, []);
  });

  it("includes Cursor in the Claude-compatible product scope", async () => {
    const claudeScope = await request("/api/sessions?providers=claude&limit=100");
    assert.equal(claudeScope.status, 200);
    assert.ok(claudeScope.body.sessions.some((session) => session.id === SESSION_ID));

    const cursorScope = await request("/api/sessions?providers=cursor&limit=100");
    assert.equal(cursorScope.status, 200);
    assert.ok(cursorScope.body.sessions.some((session) => session.id === SESSION_ID));

    const codexScope = await request("/api/sessions?providers=codex&limit=100");
    assert.equal(codexScope.status, 200);
    assert.ok(!codexScope.body.sessions.some((session) => session.id === SESSION_ID));
  });
});
