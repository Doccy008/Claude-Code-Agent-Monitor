/**
 * @file cursor-ingest.js
 * @description Discovers, enriches, snapshots, and backfills Cursor agent
 * sessions from ~/.cursor. It repairs hook-created placeholder rows with native
 * titles, working directories, prompt summaries, turn counts, provider identity,
 * and subagent records while keeping the live hook path fail-safe.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const fs = require("fs");
const path = require("path");
const {
  cursorSessionIdFromPath,
  getCursorProjectsDir,
  getCursorSnapshotDir,
  indexCursorChatDirs,
  readCursorChatMetadata,
} = require("./cursor-home");

const RECENT_SESSION_MS = 10 * 60 * 1000;
const syncFingerprints = new Map();

function statFingerprint(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "-";
  }
}

function cursorSessionFingerprint(transcriptPath, chatDir) {
  const parts = [statFingerprint(transcriptPath)];
  if (chatDir) {
    parts.push(statFingerprint(path.join(chatDir, "meta.json")));
    parts.push(statFingerprint(path.join(chatDir, "prompt_history.json")));
  }
  const subagentsDir = path.join(path.dirname(transcriptPath), "subagents");
  let subagents = [];
  try {
    subagents = fs
      .readdirSync(subagentsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => `${entry.name}:${statFingerprint(path.join(subagentsDir, entry.name))}`)
      .sort();
  } catch {
    // No subagents is the common case.
  }
  parts.push(...subagents);
  return parts.join("|");
}

function trimPrompt(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function promptLabel(value) {
  const text = trimPrompt(value);
  if (!text) return null;
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function promptPreview(prompts) {
  const seen = new Set();
  return prompts
    .map(trimPrompt)
    .filter((text) => {
      const key = text.toLocaleLowerCase();
      if (!text || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(-2)
    .join("\n");
}

function isoFromMs(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return new Date(n).toISOString();
  return fallback;
}

/** Return the later valid ISO timestamp, preserving the fallback on bad input. */
function latestIso(first, second) {
  const firstMs = Date.parse(first);
  const secondMs = Date.parse(second);
  if (!Number.isFinite(firstMs)) return second;
  if (!Number.isFinite(secondMs)) return first;
  return firstMs >= secondMs ? first : second;
}

/** Parse stored metadata without letting an old malformed row stop discovery. */
function parseMetadata(value) {
  try {
    const parsed = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function copyIfNewer(source, destination) {
  let sourceStat;
  try {
    sourceStat = fs.statSync(source);
  } catch {
    return false;
  }
  let destinationStat = null;
  try {
    destinationStat = fs.statSync(destination);
  } catch {
    // Missing snapshot is the normal first-import case.
  }
  if (
    destinationStat &&
    destinationStat.size === sourceStat.size &&
    destinationStat.mtimeMs >= sourceStat.mtimeMs
  ) {
    return false;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  try {
    fs.utimesSync(destination, sourceStat.atime, sourceStat.mtime);
  } catch {
    // Snapshot content is already durable; timestamp preservation is optional.
  }
  return true;
}

function snapshotCursorTranscript(transcriptPath, sessionId) {
  let changed = copyIfNewer(
    transcriptPath,
    path.join(getCursorSnapshotDir(), `${sessionId}.jsonl`)
  );
  const subagentsDir = path.join(path.dirname(transcriptPath), "subagents");
  let entries = [];
  try {
    entries = fs.readdirSync(subagentsDir, { withFileTypes: true });
  } catch {
    return changed;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    changed =
      copyIfNewer(
        path.join(subagentsDir, entry.name),
        path.join(getCursorSnapshotDir(), sessionId, "subagents", entry.name)
      ) || changed;
  }
  return changed;
}

function cursorTextBlocks(entry) {
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => trimPrompt(block.text))
    .filter(Boolean);
}

function readCursorSubagent(filePath) {
  let body;
  try {
    body = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let firstPrompt = null;
  let toolCount = 0;
  let terminalStatus = null;
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.role === "user" && !firstPrompt) firstPrompt = cursorTextBlocks(entry)[0] || null;
    const content = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    toolCount += content.filter((block) => block?.type === "tool_use").length;
    if (entry.type === "turn_ended") {
      terminalStatus = entry.status === "error" ? "error" : "completed";
    }
  }
  return { firstPrompt, toolCount, terminalStatus };
}

function importCursorSubagents(dbModule, sessionId, transcriptPath, sessionActive) {
  const { db, stmts } = dbModule;
  const mainAgentId = `${sessionId}-main`;
  const subagentsDir = path.join(path.dirname(transcriptPath), "subagents");
  let entries = [];
  try {
    entries = fs.readdirSync(subagentsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let changed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const cursorAgentId = path.basename(entry.name, ".jsonl");
    const agentId = `${sessionId}-cursor-${cursorAgentId}`;
    const filePath = path.join(subagentsDir, entry.name);
    const fingerprint = statFingerprint(filePath);
    const existing = stmts.getAgent.get(agentId);
    const currentMeta = parseMetadata(existing?.metadata);
    let parsed = null;
    if (!existing || currentMeta.cursor_fingerprint !== fingerprint) {
      parsed = readCursorSubagent(filePath);
    }
    const task = parsed?.firstPrompt || existing?.task || null;
    const toolCount = parsed?.toolCount ?? currentMeta.tool_count ?? 0;
    const terminalStatus = parsed?.terminalStatus ?? currentMeta.cursor_terminal_status ?? null;
    const status = terminalStatus || (sessionActive ? "working" : "completed");
    const label = promptLabel(task) || `Cursor subagent ${cursorAgentId.slice(0, 8)}`;
    const metadata = JSON.stringify({
      ...currentMeta,
      cursor_agent_id: cursorAgentId,
      cursor_fingerprint: fingerprint,
      cursor_terminal_status: terminalStatus,
      tool_count: toolCount,
    });
    const endedAt =
      status === "working" || status === "waiting"
        ? null
        : isoFromMs(
            (() => {
              try {
                return fs.statSync(filePath).mtimeMs;
              } catch {
                return Date.now();
              }
            })(),
            new Date().toISOString()
          );

    if (!existing) {
      stmts.insertAgent.run(
        agentId,
        sessionId,
        label,
        "subagent",
        "cursor",
        status,
        task,
        mainAgentId,
        metadata
      );
      if (endedAt) {
        db.prepare("UPDATE agents SET ended_at = ?, updated_at = ? WHERE id = ?").run(
          endedAt,
          endedAt,
          agentId
        );
      }
      changed++;
      continue;
    }

    const update = db
      .prepare(
        `UPDATE agents SET
           name = ?, subagent_type = 'cursor', status = ?, task = ?,
           parent_agent_id = ?, metadata = ?, ended_at = ?, updated_at = ?
         WHERE id = ? AND (
           COALESCE(name, '') != COALESCE(?, '') OR
           COALESCE(subagent_type, '') != 'cursor' OR
           status != ? OR
           COALESCE(task, '') != COALESCE(?, '') OR
           COALESCE(parent_agent_id, '') != COALESCE(?, '') OR
           COALESCE(metadata, '') != COALESCE(?, '') OR
           COALESCE(ended_at, '') != COALESCE(?, '')
         )`
      )
      .run(
        label,
        status,
        task,
        mainAgentId,
        metadata,
        endedAt,
        endedAt || existing.updated_at,
        agentId,
        label,
        status,
        task,
        mainAgentId,
        metadata,
        endedAt
      );
    changed += update.changes;
  }
  return changed;
}

function discoverCursorTranscripts(root = getCursorProjectsDir()) {
  const results = [];
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const transcriptsRoot = path.join(root, project.name, "agent-transcripts");
    let sessions = [];
    try {
      sessions = fs.readdirSync(transcriptsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const transcriptPath = path.join(transcriptsRoot, session.name, `${session.name}.jsonl`);
      if (fs.existsSync(transcriptPath)) results.push(transcriptPath);
    }
  }
  return results;
}

function enrichCursorSession(dbModule, transcriptPath, options = {}) {
  const { db, stmts } = dbModule;
  const sessionId = options.sessionId || cursorSessionIdFromPath(transcriptPath);
  if (!sessionId) return { changed: false, created: false, session: null };

  let stat;
  try {
    stat = fs.statSync(transcriptPath);
  } catch {
    return { changed: false, created: false, session: stmts.getSession.get(sessionId) || null };
  }
  const { meta, prompts } = readCursorChatMetadata(sessionId, options.chatDir);
  const existing = stmts.getSession.get(sessionId);
  const recent = Date.now() - stat.mtimeMs < RECENT_SESSION_MS;
  const createdAt = isoFromMs(meta?.createdAtMs, stat.birthtime.toISOString());
  const updatedAt = latestIso(
    isoFromMs(meta?.updatedAtMs, stat.mtime.toISOString()),
    stat.mtime.toISOString()
  );
  const firstPrompt = prompts[0] || null;
  const nativeTitle = trimPrompt(meta?.title);
  const name = nativeTitle || promptLabel(firstPrompt) || `Cursor session ${sessionId.slice(0, 8)}`;
  const cwd = typeof meta?.cwd === "string" && meta.cwd.trim() ? meta.cwd.trim() : null;
  const model = typeof options.model === "string" && options.model ? options.model : null;
  let changed = false;
  let created = false;

  if (!existing) {
    const metadata = JSON.stringify({
      imported: true,
      cursor: true,
      cursor_ingest_recent: recent,
      turn_count: prompts.length,
      user_messages: prompts.length,
      has_conversation: meta?.hasConversation === true,
    });
    stmts.insertSession.run(sessionId, name, recent ? "active" : "completed", cwd, model, metadata);
    db.prepare(
      `UPDATE sessions
       SET provider = 'cursor', transcript_path = ?, started_at = ?, updated_at = ?, ended_at = ?
       WHERE id = ?`
    ).run(transcriptPath, createdAt, updatedAt, recent ? null : updatedAt, sessionId);
    stmts.insertAgent.run(
      `${sessionId}-main`,
      sessionId,
      `Cursor · ${name}`,
      "main",
      null,
      recent ? "waiting" : "completed",
      firstPrompt,
      null,
      JSON.stringify({ cursor: true })
    );
    if (!recent) {
      db.prepare("UPDATE agents SET ended_at = ?, updated_at = ? WHERE id = ?").run(
        updatedAt,
        updatedAt,
        `${sessionId}-main`
      );
    }
    created = true;
    changed = true;
  } else {
    const currentMeta = parseMetadata(existing.metadata);
    const shouldComplete = !recent && existing.status === "active";
    const shouldReactivate =
      recent &&
      currentMeta.cursor_ingest_recent === false &&
      (existing.status === "completed" || existing.status === "abandoned");
    const desiredStatus = shouldComplete
      ? "completed"
      : shouldReactivate
        ? "active"
        : existing.status;
    const desiredEndedAt = shouldComplete ? updatedAt : shouldReactivate ? null : existing.ended_at;
    const nextMeta = {
      ...currentMeta,
      cursor: true,
      cursor_ingest_recent: recent,
      turn_count: prompts.length || currentMeta.turn_count || 0,
      user_messages: prompts.length || currentMeta.user_messages || 0,
      has_conversation: meta?.hasConversation === true || currentMeta.has_conversation === true,
    };
    const placeholder =
      !existing.name ||
      existing.name === `Session ${sessionId.slice(0, 8)}` ||
      existing.name === `Cursor session ${sessionId.slice(0, 8)}`;
    const desiredName = placeholder ? name : existing.name;
    const update = db
      .prepare(
        `UPDATE sessions SET
           name = ?,
           status = ?,
           ended_at = ?,
           cwd = COALESCE(?, cwd),
           model = COALESCE(?, model),
           provider = 'cursor',
           transcript_path = ?,
           metadata = ?,
           started_at = CASE WHEN started_at > ? THEN ? ELSE started_at END,
           updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
         WHERE id = ? AND (
           COALESCE(name, '') != COALESCE(?, '') OR
           status != ? OR
           COALESCE(ended_at, '') != COALESCE(?, '') OR
           (? IS NOT NULL AND COALESCE(cwd, '') != ?) OR
           (? IS NOT NULL AND COALESCE(model, '') != ?) OR
           provider != 'cursor' OR
           COALESCE(transcript_path, '') != ? OR
           COALESCE(metadata, '') != ?
         )`
      )
      .run(
        desiredName,
        desiredStatus,
        desiredEndedAt,
        cwd,
        model,
        transcriptPath,
        JSON.stringify(nextMeta),
        createdAt,
        createdAt,
        updatedAt,
        updatedAt,
        sessionId,
        desiredName,
        desiredStatus,
        desiredEndedAt,
        cwd,
        cwd,
        model,
        model,
        transcriptPath,
        JSON.stringify(nextMeta)
      );
    changed = update.changes > 0;

    let main = stmts.getAgent.get(`${sessionId}-main`);
    if (!main) {
      stmts.insertAgent.run(
        `${sessionId}-main`,
        sessionId,
        `Cursor · ${desiredName}`,
        "main",
        null,
        recent ? "waiting" : "completed",
        firstPrompt,
        null,
        JSON.stringify({ cursor: true })
      );
      if (!recent) {
        db.prepare("UPDATE agents SET ended_at = ?, updated_at = ? WHERE id = ?").run(
          updatedAt,
          updatedAt,
          `${sessionId}-main`
        );
      }
      changed = true;
      main = stmts.getAgent.get(`${sessionId}-main`);
    } else {
      const autoMain =
        /^Main Agent(?: - Session [0-9a-f]{8})?$/i.test(main.name || "") ||
        /^Cursor · (?:Cursor session )?[0-9a-f]{8}$/i.test(main.name || "");
      const desiredMainName = autoMain ? `Cursor · ${desiredName}` : main.name;
      const desiredTask = main.task || firstPrompt;
      const currentAgentMeta = parseMetadata(main.metadata);
      const nextAgentMeta = JSON.stringify({ ...currentAgentMeta, cursor: true });
      const desiredMainStatus = shouldComplete
        ? main.status === "error"
          ? "error"
          : "completed"
        : shouldReactivate && main.status !== "error"
          ? "waiting"
          : main.status;
      const desiredMainEndedAt = shouldComplete
        ? updatedAt
        : shouldReactivate
          ? null
          : main.ended_at;
      const mainUpdate = db
        .prepare(
          `UPDATE agents SET name = ?, status = ?, task = ?, metadata = ?, ended_at = ?, updated_at = ?
           WHERE id = ? AND (
             COALESCE(name, '') != COALESCE(?, '') OR
             status != ? OR
             COALESCE(task, '') != COALESCE(?, '') OR
             COALESCE(metadata, '') != COALESCE(?, '') OR
             COALESCE(ended_at, '') != COALESCE(?, '')
           )`
        )
        .run(
          desiredMainName,
          desiredMainStatus,
          desiredTask,
          nextAgentMeta,
          desiredMainEndedAt,
          updatedAt,
          main.id,
          desiredMainName,
          desiredMainStatus,
          desiredTask,
          nextAgentMeta,
          desiredMainEndedAt
        );
      changed = mainUpdate.changes > 0 || changed;
    }
  }

  const preview = promptPreview(prompts);
  if (preview) {
    const previewUpdate = stmts.updateSessionCardPromptPreview.run(preview, sessionId, preview);
    changed = previewUpdate.changes > 0 || changed;
  }
  const refreshedSession = stmts.getSession.get(sessionId);
  const subagents = importCursorSubagents(
    dbModule,
    sessionId,
    transcriptPath,
    refreshedSession?.status === "active" && recent
  );
  changed = subagents > 0 || changed;
  snapshotCursorTranscript(transcriptPath, sessionId);

  return { changed, created, session: stmts.getSession.get(sessionId), subagents };
}

async function syncCursorSessions(dbModule, options = {}) {
  const transcripts = discoverCursorTranscripts(options.root);
  const chatDirs = indexCursorChatDirs();
  const counters = { filesScanned: transcripts.length, imported: 0, backfilled: 0, skipped: 0 };
  for (let index = 0; index < transcripts.length; index++) {
    const transcriptPath = transcripts[index];
    const sessionId = cursorSessionIdFromPath(transcriptPath);
    const chatDir = sessionId ? chatDirs.get(sessionId) || null : null;
    const fingerprint = cursorSessionFingerprint(transcriptPath, chatDir);
    const existing = sessionId ? dbModule.stmts.getSession.get(sessionId) : null;
    let recencyExpired = false;
    if (existing?.status === "active") {
      try {
        recencyExpired = Date.now() - fs.statSync(transcriptPath).mtimeMs >= RECENT_SESSION_MS;
      } catch {
        recencyExpired = false;
      }
    }
    if (
      syncFingerprints.get(transcriptPath) === fingerprint &&
      existing?.provider === "cursor" &&
      existing.transcript_path === transcriptPath &&
      !recencyExpired
    ) {
      counters.skipped++;
      continue;
    }
    const result = enrichCursorSession(dbModule, transcriptPath, { sessionId, chatDir });
    if (result.session) {
      syncFingerprints.set(transcriptPath, cursorSessionFingerprint(transcriptPath, chatDir));
    }
    if (result.created) counters.imported++;
    else if (result.changed) counters.backfilled++;
    else counters.skipped++;
    if (result.changed && typeof options.onSession === "function") options.onSession(result);
    if (index > 0 && index % 25 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return counters;
}

module.exports = {
  discoverCursorTranscripts,
  enrichCursorSession,
  importCursorSubagents,
  snapshotCursorTranscript,
  syncCursorSessions,
};
