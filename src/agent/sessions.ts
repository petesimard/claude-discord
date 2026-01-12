/**
 * Session management for maintaining Claude Code conversation context.
 * Maps forum threads to Claude Code session IDs and source channel IDs for conversation continuity.
 */

interface ThreadSessionData {
  sessionId: string;
  sourceChannelId: string; // The channel where /claude was originally run
  worktreePath?: string; // The worktree path for this session (if using worktrees)
}

// Map of Discord forum thread ID -> session data
const threadSessions = new Map<string, ThreadSessionData>();

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
  worktreePath?: string
): void {
  threadSessions.set(threadId, { sessionId, sourceChannelId, worktreePath });
  const worktreeInfo = worktreePath ? `, worktree: ${worktreePath}` : '';
  console.log(`[Sessions] Mapped thread ${threadId} to session ${sessionId} (source channel: ${sourceChannelId}${worktreeInfo})`);
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
}

/**
 * Clear all sessions
 */
export function clearAllSessions(): void {
  threadSessions.clear();
}

/**
 * Get the total number of active sessions
 */
export function getSessionCount(): number {
  return threadSessions.size;
}
