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
  }
  return { firstPrompt, toolCount };
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
    if (stmts.getAgent.get(agentId)) continue;
    const parsed = readCursorSubagent(path.join(subagentsDir, entry.name));
    const task = parsed?.firstPrompt || null;
    const label = promptLabel(task) || `Cursor subagent ${cursorAgentId.slice(0, 8)}`;
    stmts.insertAgent.run(
      agentId,
      sessionId,
      label,
      "subagent",
      "cursor",
      sessionActive ? "working" : "completed",
      task,
      mainAgentId,
      JSON.stringify({ cursor_agent_id: cursorAgentId, tool_count: parsed?.toolCount || 0 })
    );
    if (!sessionActive) {
      db.prepare(
        "UPDATE agents SET ended_at = COALESCE(ended_at, started_at), updated_at = started_at WHERE id = ?"
      ).run(agentId);
    }
    changed++;
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
  const updatedAt = isoFromMs(meta?.updatedAtMs, stat.mtime.toISOString());
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
    created = true;
    changed = true;
  } else {
    const currentMeta = (() => {
      try {
        return existing.metadata ? JSON.parse(existing.metadata) : {};
      } catch {
        return {};
      }
    })();
    const nextMeta = {
      ...currentMeta,
      cursor: true,
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
           cwd = COALESCE(?, cwd),
           model = COALESCE(?, model),
           provider = 'cursor',
           transcript_path = ?,
           metadata = ?,
           started_at = CASE WHEN started_at > ? THEN ? ELSE started_at END,
           updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END
         WHERE id = ? AND (
           COALESCE(name, '') != COALESCE(?, '') OR
           (? IS NOT NULL AND COALESCE(cwd, '') != ?) OR
           (? IS NOT NULL AND COALESCE(model, '') != ?) OR
           provider != 'cursor' OR
           COALESCE(transcript_path, '') != ? OR
           COALESCE(metadata, '') != ?
         )`
      )
      .run(
        desiredName,
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
      changed = true;
      main = stmts.getAgent.get(`${sessionId}-main`);
    } else {
      const autoMain =
        /^Main Agent(?: - Session [0-9a-f]{8})?$/i.test(main.name || "") ||
        /^Cursor · (?:Cursor session )?[0-9a-f]{8}$/i.test(main.name || "");
      const desiredMainName = autoMain ? `Cursor · ${desiredName}` : main.name;
      const desiredTask = main.task || firstPrompt;
      const currentAgentMeta = (() => {
        try {
          return main.metadata ? JSON.parse(main.metadata) : {};
        } catch {
          return {};
        }
      })();
      const nextAgentMeta = JSON.stringify({ ...currentAgentMeta, cursor: true });
      const mainUpdate = db
        .prepare(
          `UPDATE agents SET name = ?, task = ?, metadata = ?, updated_at = ?
           WHERE id = ? AND (
             COALESCE(name, '') != COALESCE(?, '') OR
             COALESCE(task, '') != COALESCE(?, '') OR
             COALESCE(metadata, '') != COALESCE(?, '')
           )`
        )
        .run(
          desiredMainName,
          desiredTask,
          nextAgentMeta,
          updatedAt,
          main.id,
          desiredMainName,
          desiredTask,
          nextAgentMeta
        );
      changed = mainUpdate.changes > 0 || changed;
    }
  }

  const preview = promptPreview(prompts);
  if (preview) {
    const previewUpdate = stmts.updateSessionCardPromptPreview.run(preview, sessionId, preview);
    changed = previewUpdate.changes > 0 || changed;
  }
  const subagents = importCursorSubagents(dbModule, sessionId, transcriptPath, recent);
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
    if (
      syncFingerprints.get(transcriptPath) === fingerprint &&
      existing?.provider === "cursor" &&
      existing.transcript_path === transcriptPath
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
