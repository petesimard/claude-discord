/**
 * Session management for maintaining Claude Code conversation context.
 * Maps forum threads to Claude Code session IDs and source channel IDs for conversation continuity.
 */

import * as fs from 'fs';
import * as path from 'path';

interface ThreadSessionData {
  sessionId: string;
  sourceChannelId: string; // The channel where /claude was originally run
  worktreePath?: string; // The worktree path for this session (if using worktrees)
  worktreeBranch?: string; // The worktree branch name (if using worktrees)
}

// Map of Discord forum thread ID -> session data
const threadSessions = new Map<string, ThreadSessionData>();

// Session file path
const SESSIONS_FILE = path.join(process.cwd(), '.discord-sessions.json');

/**
 * Get the existing session data for a forum thread, or undefined if none exists
 */
export function getThreadSession(threadId: string): ThreadSessionData | undefined {
  return threadSessions.get(threadId);
}

/**
 * Store a session ID and source channel ID for a forum thread
 */
export function setThreadSession(
  threadId: string,
  sessionId: string,
  sourceChannelId: string,
  worktreePath?: string,
  worktreeBranch?: string
): void {
  threadSessions.set(threadId, { sessionId, sourceChannelId, worktreePath, worktreeBranch });
  const worktreeInfo = worktreePath ? `, worktree: ${worktreePath}` : '';
  const branchInfo = worktreeBranch ? `, branch: ${worktreeBranch}` : '';
  console.log(`[Sessions] Mapped thread ${threadId} to session ${sessionId} (source channel: ${sourceChannelId}${worktreeInfo}${branchInfo})`);

  // Save to disk
  saveSessions();
}

/**
 * Check if a thread has an associated session
 */
export function hasThreadSession(threadId: string): boolean {
  return threadSessions.has(threadId);
}

/**
 * Clear the session for a specific thread
 */
export function clearThreadSession(threadId: string): void {
  threadSessions.delete(threadId);
  console.log(`[Sessions] Removed mapping for thread ${threadId}`);

  // Save to disk
  saveSessions();
}

/**
 * Clear all sessions
 */
export function clearAllSessions(): void {
  threadSessions.clear();

  // Save to disk
  saveSessions();
}

/**
 * Get the total number of active sessions
 */
export function getSessionCount(): number {
  return threadSessions.size;
}

/**
 * Save sessions to disk
 */
function saveSessions(): void {
  try {
    const sessionsArray = Array.from(threadSessions.entries()).map(([threadId, data]) => ({
      threadId,
      ...data
    }));

    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsArray, null, 2), 'utf-8');
    console.log(`[Sessions] Saved ${sessionsArray.length} session(s) to disk`);
  } catch (error) {
    console.error('[Sessions] Failed to save sessions to disk:', error);
  }
}

/**
 * Load sessions from disk on startup
 */
export function loadSessions(): void {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) {
      console.log('[Sessions] No saved sessions file found, starting fresh');
      return;
    }

    const fileContent = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const sessionsArray = JSON.parse(fileContent) as Array<{
      threadId: string;
      sessionId: string;
      sourceChannelId: string;
      worktreePath?: string;
      worktreeBranch?: string;
    }>;

    for (const session of sessionsArray) {
      threadSessions.set(session.threadId, {
        sessionId: session.sessionId,
        sourceChannelId: session.sourceChannelId,
        worktreePath: session.worktreePath,
        worktreeBranch: session.worktreeBranch
      });
    }

    console.log(`[Sessions] Loaded ${sessionsArray.length} session(s) from disk`);
  } catch (error) {
    console.error('[Sessions] Failed to load sessions from disk:', error);
  }
}

/**
 * Get all sessions (for debugging/export)
 */
export function getAllSessions(): Map<string, ThreadSessionData> {
  return new Map(threadSessions);
}
