/**
 * @file Regression tests for bounded-window rollout reads.
 *
 * Codex rollouts can exceed V8's maximum string length (~512 MiB). Decoding
 * one in a single `toString` threw ERR_STRING_TOO_LONG on every attempt, so
 * such a rollout could never be ingested. The ingestor now reads bounded
 * windows cut at line boundaries. These tests shrink the window to a few
 * hundred bytes and require the result to be IDENTICAL to a single-pass read:
 * same events, same token buckets (including the pricing speed carried across
 * windows), same cursors, and no duplicates on later appends.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { after, afterEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ccam-codex-large-"));
process.env.DASHBOARD_DB_PATH = path.join(TMP, "dashboard.db");
process.env.DASHBOARD_CODEX_HOME = path.join(TMP, "codex");

const { db } = require("../db");
const {
  ingestCodexTranscript,
  ingestCodexToolEvents,
  setReadWindowBytesForTests,
} = require("../lib/codex-ingest");

const DAY_DIR = path.join(process.env.DASHBOARD_CODEX_HOME, "sessions", "2026", "08", "02");
let sequence = 0;

/** A fresh, unique session id + rollout path. */
function newRollout() {
  sequence += 1;
  const id = `019a4ba6-a2b6-75f0-b186-${String(sequence).padStart(12, "0")}`;
  const file = path.join(DAY_DIR, `rollout-2026-08-02T09-00-00-${id}.jsonl`);
  return { id, file };
}

function at(minute) {
  return new Date(Date.UTC(2026, 7, 2, 9, 0, 0) + minute * 60_000).toISOString();
}

/**
 * A realistic rollout: a fast-tier turn context, many prompts, tool calls,
 * lifecycle markers, cumulative token snapshots spread through the file, and
 * one record far longer than the test window.
 */
function rolloutLines(sessionId, { contextPerTurn = false } = {}) {
  const lines = [];
  const push = (minute, type, payload) =>
    lines.push(JSON.stringify({ timestamp: at(minute), type, payload }));
  push(0, "session_meta", {
    id: sessionId,
    timestamp: at(0),
    cwd: "/workspace/large",
    cli_version: "1.0.0",
    model_provider: "openai",
  });
  // Early fast-tier context: token snapshots many windows later must still be
  // priced as "fast", which only works if speed carries across windows.
  push(1, "turn_context", { model: "gpt-5.6-terra", service_tier: "fast" });
  let input = 0;
  for (let i = 0; i < 40; i++) {
    const m = 2 + i * 3;
    if (contextPerTurn) push(m, "turn_context", { model: "gpt-5.6-terra", service_tier: "fast" });
    push(m, "event_msg", { type: "task_started" });
    push(m, "event_msg", {
      type: "user_message",
      message: `Prompt number ${i} for the large rollout`,
    });
    push(m + 1, "response_item", {
      type: "function_call",
      name: "exec_command",
      call_id: `cmd-${i}`,
      arguments: JSON.stringify({ cmd: `rg pattern-${i}` }),
    });
    input += 1_000 + i;
    push(m + 1, "event_msg", {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: Math.floor(input / 4),
          cache_write_input_tokens: 10 * i,
          output_tokens: 50 * (i + 1),
          reasoning_output_tokens: 5 * i,
        },
      },
    });
    push(m + 2, "event_msg", { type: "task_complete" });
  }
  // One oversized record (~12 KB) that no small window can hold.
  push(200, "event_msg", { type: "agent_message", message: "x".repeat(12_000) });
  return lines;
}

function writeRollout(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => `${l}\n`).join(""));
}

/** Everything the dashboard derives from a rollout, minus the session id. */
function snapshot(sessionId, file) {
  const events = db
    .prepare(
      `SELECT event_type, tool_name, summary, created_at, data FROM events
       WHERE session_id = ? ORDER BY created_at, event_type, summary, id`
    )
    .all(sessionId);
  const tokens = db
    .prepare(
      `SELECT model, speed, inference_geo, service_tier, context_size,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
       FROM token_usage WHERE session_id = ?
       ORDER BY model, speed, context_size`
    )
    .all(sessionId);
  const session = db
    .prepare("SELECT name, model, status, cwd FROM sessions WHERE id = ?")
    .get(sessionId);
  const cursor = db
    .prepare(
      `SELECT byte_offset, input_tokens, cached_input_tokens, output_tokens
       FROM codex_ingest_state WHERE transcript_path = ?`
    )
    .get(file);
  const toolCursor = db
    .prepare("SELECT byte_offset FROM codex_tool_ingest_state WHERE transcript_path = ?")
    .get(file);
  return { events, tokens, session, cursor, toolCursor };
}

afterEach(() => setReadWindowBytesForTests(undefined));
after(() => {
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe("Codex rollouts read in bounded windows", () => {
  it("produces exactly the same state as a single-pass read", () => {
    const whole = newRollout();
    const windowed = newRollout();
    writeRollout(whole.file, rolloutLines(whole.id));
    writeRollout(windowed.file, rolloutLines(windowed.id));
    const size = fs.statSync(windowed.file).size;

    const one = ingestCodexTranscript(whole.file);
    setReadWindowBytesForTests(300); // ~60+ windows for this fixture
    const many = ingestCodexTranscript(windowed.file);

    assert.equal(one.changed, true);
    assert.equal(many.changed, true);
    assert.equal(many.created, true, "created is reported once for the whole call");
    assert.equal(many.failed, undefined);
    assert.equal("more" in many, false, "internal window flags never leak to callers");
    assert.equal("carry" in many, false);
    assert.equal(many.events.length, one.events.length, "same events returned to the caller");
    assert.deepEqual(
      many.events.map((event) => [event.event_type, event.summary]),
      one.events.map((event) => [event.event_type, event.summary]),
      "windowing preserves the caller-visible transcript/tool event order"
    );

    const a = snapshot(whole.id, whole.file);
    const b = snapshot(windowed.id, windowed.file);
    assert.deepEqual(b.events, a.events);
    assert.deepEqual(b.tokens, a.tokens);
    assert.deepEqual(b.session, a.session);
    assert.deepEqual(b.cursor, a.cursor);
    assert.deepEqual(b.toolCursor, a.toolCursor);

    // And the shared state is the RIGHT state, not merely equal.
    assert.equal(b.cursor.byte_offset, size, "main cursor reached end of file");
    assert.equal(b.toolCursor.byte_offset, size, "tool cursor reached end of file");
    assert.equal(b.events.filter((e) => e.event_type === "codex_tool_call").length, 40);
    assert.equal(b.events.filter((e) => e.event_type === "codex_user_message").length, 40);
    assert.ok(b.tokens.length > 0);
    assert.ok(
      b.tokens.every((t) => t.speed === "fast"),
      `speed must carry across windows: ${JSON.stringify(b.tokens.map((t) => t.speed))}`
    );
  });

  it("grows the window for a single record longer than it", () => {
    const whole = newRollout();
    const tiny = newRollout();
    writeRollout(whole.file, rolloutLines(whole.id));
    writeRollout(tiny.file, rolloutLines(tiny.id));
    ingestCodexTranscript(whole.file);
    setReadWindowBytesForTests(64); // far smaller than the 12 KB record

    const result = ingestCodexTranscript(tiny.file);
    assert.equal(result.failed, undefined);
    const a = snapshot(whole.id, whole.file);
    const b = snapshot(tiny.id, tiny.file);
    assert.equal(
      b.cursor.byte_offset,
      fs.statSync(tiny.file).size,
      "read past the oversized record"
    );
    assert.deepEqual(b.events, a.events);
    assert.deepEqual(b.tokens, a.tokens);
  });

  it("continues from its cursor on later appends without duplicating", () => {
    const r = newRollout();
    // Real rollouts carry a turn context per turn. Speed is not persisted
    // between separate ingest calls (pre-existing and independent of
    // windowing), so a single leading context would diverge across calls.
    const lines = rolloutLines(r.id, { contextPerTurn: true });
    // 2 header lines + 6 per turn: split exactly at the start of turn 10.
    const split = 2 + 6 * 10;
    writeRollout(r.file, lines.slice(0, split));
    setReadWindowBytesForTests(256);
    ingestCodexTranscript(r.file);
    const firstCount = snapshot(r.id, r.file).events.length;

    // Append the rest, including a half-written final line.
    fs.appendFileSync(
      r.file,
      lines
        .slice(split)
        .map((l) => `${l}\n`)
        .join("")
    );
    fs.appendFileSync(r.file, '{"timestamp":"2026-08-02T12:00:00.000Z","type":"event_');
    ingestCodexTranscript(r.file);
    const s = snapshot(r.id, r.file);

    const full = newRollout();
    writeRollout(full.file, rolloutLines(full.id, { contextPerTurn: true }));
    setReadWindowBytesForTests(undefined);
    ingestCodexTranscript(full.file);
    const reference = snapshot(full.id, full.file);

    assert.ok(s.events.length > firstCount);
    assert.deepEqual(s.events, reference.events, "incremental windowed == single pass");
    assert.deepEqual(s.tokens, reference.tokens);
    // The cursor stops before the unterminated line, ready for its completion.
    const partialBytes = Buffer.byteLength(
      '{"timestamp":"2026-08-02T12:00:00.000Z","type":"event_'
    );
    assert.equal(s.cursor.byte_offset, fs.statSync(r.file).size - partialBytes);
  });

  it("continues past a capped window containing only malformed records", () => {
    const r = newRollout();
    const meta = JSON.stringify({
      timestamp: at(0),
      type: "session_meta",
      payload: {
        id: r.id,
        timestamp: at(0),
        cwd: "/workspace/large",
        cli_version: "1.0.0",
        model_provider: "openai",
      },
    });
    const windowBytes = Buffer.byteLength(`${meta}\n`);
    const malformed = "not-json\n".repeat(Math.ceil(windowBytes / Buffer.byteLength("not-json\n")));
    const valid = JSON.stringify({
      timestamp: at(1),
      type: "event_msg",
      payload: { type: "user_message", message: "Valid record after malformed window" },
    });
    fs.mkdirSync(path.dirname(r.file), { recursive: true });
    fs.writeFileSync(r.file, `${meta}\n${malformed}${valid}\n`);
    setReadWindowBytesForTests(windowBytes);

    const result = ingestCodexTranscript(r.file);
    const state = snapshot(r.id, r.file);

    assert.equal(result.failed, undefined);
    assert.equal(state.cursor.byte_offset, fs.statSync(r.file).size);
    assert.ok(
      state.events.some(
        (event) =>
          event.event_type === "codex_user_message" &&
          event.summary === "Valid record after malformed window"
      )
    );
  });

  it("indexes tool calls in windows and commits each window's cursor with its events", () => {
    const r = newRollout();
    writeRollout(r.file, rolloutLines(r.id));
    ingestCodexTranscript(r.file); // creates the session and indexes tools

    // Rewind only the tool cursor and wipe tool rows, then re-index in windows.
    db.prepare("DELETE FROM events WHERE session_id = ? AND event_type = 'codex_tool_call'").run(
      r.id
    );
    db.prepare("UPDATE codex_tool_ingest_state SET byte_offset = 0 WHERE transcript_path = ?").run(
      r.file
    );
    setReadWindowBytesForTests(200);
    const result = ingestCodexToolEvents(r.file);

    assert.equal(result.failed, undefined);
    assert.equal(result.events.length, 40);
    const s = snapshot(r.id, r.file);
    assert.equal(s.toolCursor.byte_offset, fs.statSync(r.file).size);
    assert.equal(s.events.filter((e) => e.event_type === "codex_tool_call").length, 40);
    // A second pass is a no-op: nothing re-indexed, nothing duplicated.
    assert.equal(ingestCodexToolEvents(r.file).events.length, 0);
  });
});
