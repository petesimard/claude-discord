/**
 * Session management for maintaining Claude Code conversation context per Discord channel.
 * Each channel gets its own session ID to maintain conversation history.
 */

// Map of Discord channel ID -> Claude Code session ID
const channelSessions = new Map<string, string>();

/**
 * Get the existing session ID for a channel, or undefined if none exists
 */
export function getSession(channelId: string): string | undefined {
  return channelSessions.get(channelId);
}

/**
 * Store a session ID for a channel
 */
export function setSession(channelId: string, sessionId: string): void {
  channelSessions.set(channelId, sessionId);
}

/**
 * Clear the session for a specific channel
 */
export function clearSession(channelId: string): void {
  channelSessions.delete(channelId);
}

/**
 * Clear all sessions
 */
export function clearAllSessions(): void {
  channelSessions.clear();
}

/**
 * Get the total number of active sessions
 */
export function getSessionCount(): number {
  return channelSessions.size;
}
