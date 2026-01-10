import { query } from '@anthropic-ai/claude-agent-sdk';
import { config } from '../utils/config.js';
import { detectVcs, VcsType } from '../utils/vcs.js';

export interface AgentMessage {
  type: 'status' | 'result' | 'error';
  content: string;
  sessionId?: string;
  vcsType?: VcsType;
}

export type MessageCallback = (message: AgentMessage) => Promise<void>;

/**
 * Execute a Claude Code prompt with streaming updates
 * @param prompt The user's prompt to execute
 * @param onMessage Callback for streaming status updates
 * @param resumeSessionId Optional session ID to resume a previous conversation
 * @returns The session ID for this execution
 */
export async function executeClaudePrompt(
  prompt: string,
  onMessage: MessageCallback,
  resumeSessionId?: string
): Promise<string> {
  // Save the original working directory
  const originalCwd = process.cwd();

  try {
    console.log(`[Agent] Executing prompt (session: ${resumeSessionId || 'new'})`);
    console.log(`[Agent] Original working directory: ${originalCwd}`);
    console.log(`[Agent] Target working directory: ${config.workingPath}`);

    // Check if the working directory exists
    const fs = await import('fs');
    if (!fs.existsSync(config.workingPath)) {
      throw new Error(`Working directory does not exist: ${config.workingPath}\n\nPlease create the directory or update WORKING_DIR in your .env file.`);
    }

    // Change to the configured working directory
    process.chdir(config.workingPath);
    console.log(`[Agent] Changed to working directory: ${process.cwd()}`);

    // Detect VCS type
    const vcsType = detectVcs(config.workingPath);
    console.log(`[Agent] Detected VCS type: ${vcsType}`);

    // Configure the agent with all tools and bypass permissions
    const options = {
      workingDirectory: config.workingPath,
      allowedTools: [
        'Read',
        'Write',
        'Edit',
        'Bash',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch'
      ],
      permissionMode: 'bypassPermissions' as const,
      ...(resumeSessionId && { resume: resumeSessionId })
    };

    let currentTool: string | null = null;
    let sessionId: string | undefined = resumeSessionId;
    let hasResult = false;
    let hasError = false;

    // Execute the query and stream messages
    for await (const message of query({ prompt, options })) {
      // Debug: Log message type
      console.log(`[Agent] Message type: ${(message as any).type}, subtype: ${(message as any).subtype}, has result: ${'result' in message}`);

      // Capture session ID from init message
      if ('subtype' in message && message.subtype === 'init' && 'session_id' in message) {
        sessionId = message.session_id as string;
        console.log(`[Agent] Session ID: ${sessionId}`);
      }

      // Handle tool use messages (status updates)
      if ('type' in message && (message as any).type === 'tool_use') {
        const toolName = (message as any).name || 'unknown';
        if (toolName !== currentTool) {
          currentTool = toolName;
          await onMessage({
            type: 'status',
            content: `🔄 Working... (using ${toolName} tool)`
          });
        }
      }

      // Handle result messages (final output)
      if ('result' in message) {
        const result = (message as any).result;
        hasResult = true;
        console.log(`[Agent] Got result: ${result?.substring(0, 100)}...`);
        await onMessage({
          type: 'result',
          content: result,
          sessionId: sessionId,
          vcsType: vcsType
        });
      }

      // Handle error messages
      if ('error' in message) {
        const error = (message as any).error;
        const errorContent = (message as any).message?.content?.[0]?.text || String(error);
        hasError = true;
        console.log(`[Agent] Got error: ${error}`);

        // Check for billing errors
        if (error === 'billing_error' || errorContent.includes('Credit balance is too low')) {
          await onMessage({
            type: 'error',
            content: `❌ Billing Error: ${errorContent}\n\nYour Anthropic API key has insufficient credits. Please add credits at https://console.anthropic.com/`,
            sessionId: sessionId,
            vcsType: vcsType
          });
        } else {
          await onMessage({
            type: 'error',
            content: `Error: ${errorContent}`,
            sessionId: sessionId,
            vcsType: vcsType
          });
        }
      }
    }

    // Only send generic completion if we didn't get a result or error
    if (!hasResult && !hasError) {
      console.log('[Agent] No result received, sending generic completion');
      await onMessage({
        type: 'result',
        content: 'Task completed.',
        sessionId: sessionId,
        vcsType: vcsType
      });
    }

    // Return the session ID for continuation
    if (!sessionId) {
      throw new Error('No session ID was captured from agent execution');
    }

    return sessionId;

  } catch (error) {
    // Handle any errors from the agent execution
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[Agent] Error:', errorMessage);

    await onMessage({
      type: 'error',
      content: `Failed to execute: ${errorMessage}`
    });
    throw error;
  } finally {
    // Always restore the original working directory
    process.chdir(originalCwd);
    console.log(`[Agent] Restored working directory to: ${process.cwd()}`);
  }
}
