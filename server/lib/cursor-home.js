/**
 * @file cursor-home.js
 * @description Resolves Cursor's local session roots, identifies Cursor agent
 * transcripts, discovers companion chat metadata, and locates durable dashboard
 * snapshots without depending on Cursor's retention policy.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { getDataDir } = require("./claude-home");

function getCursorHome() {
  return path.resolve(process.env.DASHBOARD_CURSOR_HOME || path.join(os.homedir(), ".cursor"));
}

function getCursorProjectsDir() {
  return path.join(getCursorHome(), "projects");
}

function getCursorChatsDir() {
  return path.join(getCursorHome(), "chats");
}

function getCursorSnapshotDir() {
  return path.join(getDataDir(), "cursor-transcripts");
}

function isCursorTranscriptPath(value) {
  if (typeof value !== "string" || !value) return false;
  const resolved = path.resolve(value);
  const relative = path.relative(getCursorProjectsDir(), resolved).split(path.sep).join("/");
  return (
    !relative.startsWith("../") && /^[^/]+\/agent-transcripts\/[^/]+\/[^/]+\.jsonl$/i.test(relative)
  );
}

function cursorSessionIdFromPath(transcriptPath) {
  if (!isCursorTranscriptPath(transcriptPath)) return null;
  const filename = path.basename(transcriptPath, ".jsonl");
  const parent = path.basename(path.dirname(transcriptPath));
  return filename === parent ? filename : null;
}

function findCursorChatDir(sessionId) {
  const root = getCursorChatsDir();
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const candidate = path.join(root, workspace.name, sessionId);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Cursor may rotate a chat while discovery is in progress.
    }
  }
  return null;
}

/** Build one session-id lookup for a sync pass instead of rescanning workspaces per transcript. */
function indexCursorChatDirs() {
  const indexed = new Map();
  let workspaces = [];
  try {
    workspaces = fs.readdirSync(getCursorChatsDir(), { withFileTypes: true });
  } catch {
    return indexed;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(getCursorChatsDir(), workspace.name);
    let sessions = [];
    try {
      sessions = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (session.isDirectory() && !indexed.has(session.name)) {
        indexed.set(session.name, path.join(workspaceDir, session.name));
      }
    }
  }
  return indexed;
}

function readCursorChatMetadata(sessionId, knownChatDir = undefined) {
  const chatDir = knownChatDir === undefined ? findCursorChatDir(sessionId) : knownChatDir;
  if (!chatDir) return { chatDir: null, meta: null, prompts: [] };
  let meta = null;
  let prompts = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(chatDir, "meta.json"), "utf8"));
    if (parsed && typeof parsed === "object") meta = parsed;
  } catch {
    // Metadata is optional while Cursor is creating a new chat.
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(chatDir, "prompt_history.json"), "utf8"));
    if (Array.isArray(parsed)) {
      prompts = parsed.filter((value) => typeof value === "string" && value.trim());
    }
  } catch {
    // The transcript reader remains useful even without prompt history.
  }
  return { chatDir, meta, prompts };
}

function findCursorTranscriptPath(sessionId) {
  const projectsDir = getCursorProjectsDir();
  let projects;
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const candidate = path.join(
      projectsDir,
      project.name,
      "agent-transcripts",
      sessionId,
      `${sessionId}.jsonl`
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function getCursorSnapshotPath(sessionId) {
  const candidate = path.join(getCursorSnapshotDir(), `${sessionId}.jsonl`);
  return fs.existsSync(candidate) ? candidate : null;
}

function getCursorSubagentPath(transcriptPath, agentId) {
  if (!transcriptPath || !agentId) return null;
  const candidate = path.join(path.dirname(transcriptPath), "subagents", `${agentId}.jsonl`);
  return fs.existsSync(candidate) ? candidate : null;
}

function getCursorSnapshotSubagentPath(sessionId, agentId) {
  const candidate = path.join(getCursorSnapshotDir(), sessionId, "subagents", `${agentId}.jsonl`);
  return fs.existsSync(candidate) ? candidate : null;
}

module.exports = {
  cursorSessionIdFromPath,
  findCursorChatDir,
  findCursorTranscriptPath,
  getCursorChatsDir,
  getCursorHome,
  getCursorProjectsDir,
  getCursorSnapshotDir,
  getCursorSnapshotPath,
  getCursorSnapshotSubagentPath,
  getCursorSubagentPath,
  isCursorTranscriptPath,
  indexCursorChatDirs,
  readCursorChatMetadata,
};
