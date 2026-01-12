import { query } from '@anthropic-ai/claude-agent-sdk';
import { detectVcs, VcsType } from '../utils/vcs.js';
import type { ChannelSettings } from '../utils/config.js';

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
 * @param workingPath The working directory for this execution
 * @param channelSettings The channel settings (for autoUpdate, etc.)
 * @param resumeSessionId Optional session ID to resume a previous conversation
 * @returns The session ID for this execution
 */
export async function executeClaudePrompt(
  prompt: string,
  onMessage: MessageCallback,
  workingPath: string,
  channelSettings: ChannelSettings,
  resumeSessionId?: string
): Promise<string> {
  // Save the original working directory
  const originalCwd = process.cwd();

  try {
    console.log(`[Agent] Executing prompt (session: ${resumeSessionId || 'new'})`);
    console.log(`[Agent] Original working directory: ${originalCwd}`);
    console.log(`[Agent] Target working directory: ${workingPath}`);

    // Log DEBUG mode status
    if (process.env.DEBUG === '1') {
      console.log('[Agent] 🐛 DEBUG mode is ENABLED - verbose output will be shown');
    }

    // Verify API key is set
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is not set!');
    }
    console.log(`[Agent] API key is set: ${process.env.ANTHROPIC_API_KEY.substring(0, 10)}...`);

    // Check if the working directory exists
    const fs = await import('fs');
    if (!fs.existsSync(workingPath)) {
      throw new Error(`Working directory does not exist: ${workingPath}\n\nPlease create the directory or update your CHANNEL_MAPPINGS in the .env file.`);
    }

    // Check if directory is readable
    try {
      fs.accessSync(workingPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
      throw new Error(`No read/write permissions for working directory: ${workingPath}\n\nPlease check directory permissions.`);
    }

    // Change to the configured working directory
    process.chdir(workingPath);
    console.log(`[Agent] Changed to working directory: ${process.cwd()}`);

    // Detect VCS type
    const vcsType = detectVcs(workingPath);
    console.log(`[Agent] Detected VCS type: ${vcsType}`);

    // Auto-update repository if enabled and this is a new conversation
    if (channelSettings.autoUpdate && !resumeSessionId) {
      console.log('[Agent] Auto-update is enabled, updating repository...');
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      try {
        await onMessage({
          type: 'status',
          content: '🔄 Updating repository...'
        });

        if (vcsType === 'git') {
          console.log('[Agent] Running git pull...');
          const result = await execAsync('git pull', {
            cwd: workingPath,
            timeout: 30000
          });
          const updateOutput = result.stdout || result.stderr || 'Git pull completed';
          console.log('[Agent] Git pull output:', updateOutput.trim());

          await onMessage({
            type: 'status',
            content: '✅ Repository updated'
          });
        } else {
          console.log('[Agent] No Git repository detected, skipping auto-update');
        }
      } catch (updateError) {
        console.error('[Agent] Auto-update failed:', updateError);
        await onMessage({
          type: 'status',
          content: '⚠️ Repository update failed, continuing anyway...'
        });
      }
    }

    // Configure the agent with all tools and bypass permissions
    const options = {
      workingDirectory: workingPath,
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
      ...(resumeSessionId && { resume: resumeSessionId }),
      // Explicitly pass API key and DEBUG flag via environment
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        DEBUG: process.env.DEBUG || '0'
      },
      // Enable debug logging to capture Claude CLI output
      onStderr: (data: string) => {
        console.error('[Agent] Claude CLI stderr:', data);
      },
      onStdout: (data: string) => {
        console.log('[Agent] Claude CLI stdout:', data);
      }
    };

    let currentTool: string | null = null;
    let sessionId: string | undefined = resumeSessionId;
    let hasResult = false;
    let hasError = false;

    console.log('[Agent] Starting query with options:', JSON.stringify({
      workingDirectory: options.workingDirectory,
      allowedTools: options.allowedTools,
      permissionMode: options.permissionMode,
      resume: options.resume || 'none'
    }));

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
    console.error('[Agent] Error stack:', error instanceof Error ? error.stack : 'No stack trace');

    // Provide helpful error messages for common issues
    let userMessage = `Failed to execute: ${errorMessage}`;

    if (errorMessage.includes('process exited with code 1')) {
      userMessage =
        '❌ Claude Code agent failed to start.\n\n' +
        'Common causes:\n' +
        '• **API Key Issue**: Invalid or insufficient credits\n' +
        '  → Check your ANTHROPIC_API_KEY in .env\n' +
        '  → Verify credits at https://console.anthropic.com/\n\n' +
        '• **Claude Code CLI Issue**: Not installed or not in PATH\n' +
        '  → Verify installation: `claude --version`\n' +
        '  → Reinstall if needed: https://claude.ai/install.sh\n\n' +
        '• **Directory Issue**: Permission or path problems\n' +
        `  → Check directory exists and is writable: ${workingPath}\n\n` +
        'Run the bot with more verbose logging to see detailed errors.';
    }

    await onMessage({
      type: 'error',
      content: userMessage
    });
    throw error;
  } finally {
    // Always restore the original working directory
    process.chdir(originalCwd);
    console.log(`[Agent] Restored working directory to: ${process.cwd()}`);
  }
}
