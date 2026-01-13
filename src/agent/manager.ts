import { query, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { detectVcs, VcsType } from '../utils/vcs.js';
import type { ChannelSettings } from '../utils/config.js';
import { createWorktree, WorktreeInfo } from '../utils/worktree.js';
import * as path from 'path';

export interface AgentMessage {
  type: 'status' | 'result' | 'error';
  content: string;
  sessionId?: string;
  vcsType?: VcsType;
  worktreePath?: string;
  worktreeBranch?: string;
}

export type MessageCallback = (message: AgentMessage) => Promise<void>;

export interface ExecutionResult {
  sessionId: string;
  worktreePath?: string;
  worktreeBranch?: string;
}

/**
 * Execute a Claude Code prompt with streaming updates
 * @param prompt The user's prompt to execute
 * @param onMessage Callback for streaming status updates
 * @param workingPath The working directory for this execution
 * @param channelSettings The channel settings (for autoUpdate, etc.)
 * @param resumeSessionId Optional session ID to resume a previous conversation
 * @param existingWorktreePath Optional worktree path when resuming a session
 * @param existingWorktreeBranch Optional worktree branch when resuming a session
 * @param skipWorktree Optional flag to skip worktree creation even if configured
 * @returns The execution result containing session ID and worktree path
 */
export async function executeClaudePrompt(
  prompt: string,
  onMessage: MessageCallback,
  workingPath: string,
  channelSettings: ChannelSettings,
  resumeSessionId?: string,
  existingWorktreePath?: string,
  existingWorktreeBranch?: string,
  skipWorktree?: boolean
): Promise<ExecutionResult> {
  // Save the original working directory
  const originalCwd = process.cwd();
  let actualWorkingPath = workingPath;
  let createdWorktreeInfo: WorktreeInfo | undefined = undefined;
  let resumedWorktreeInfo: WorktreeInfo | undefined = undefined;

  try {
    console.log(`[Agent] Executing prompt (session: ${resumeSessionId || 'new'})`);
    console.log(`[Agent] Original working directory: ${originalCwd}`);
    console.log(`[Agent] Target working directory: ${workingPath}`);

    // Handle worktree creation for new conversations
    if (!resumeSessionId && channelSettings.workTreeBase && !skipWorktree) {
      // This is a new conversation and worktrees are enabled (and not skipped)
      const workTreeBase = channelSettings.workTreeBase === '../'
        ? path.resolve(workingPath, '..')
        : path.resolve(channelSettings.workTreeBase);

      console.log(`[Agent] Worktrees enabled, base: ${workTreeBase}`);

      // Generate a temporary session ID for the worktree name
      const tempSessionId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;

      try {
        await onMessage({
          type: 'status',
          content: '🌳 Creating worktree for this session...'
        });

        createdWorktreeInfo = await createWorktree(workingPath, workTreeBase, tempSessionId);
        actualWorkingPath = createdWorktreeInfo.path;

        console.log(`[Agent] Using worktree: ${actualWorkingPath} on branch ${createdWorktreeInfo.branch}`);

        await onMessage({
          type: 'status',
          content: `✅ Worktree created on branch ${createdWorktreeInfo.branch}`
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[Agent] Failed to create worktree: ${errorMessage}`);
        await onMessage({
          type: 'status',
          content: '⚠️  Failed to create worktree, using main directory instead'
        });
        // Fall back to main directory
        createdWorktreeInfo = undefined;
        actualWorkingPath = workingPath;
      }
    } else if (existingWorktreePath && existingWorktreeBranch) {
      // Resume a session with an existing worktree
      console.log(`[Agent] Resuming with existing worktree: ${existingWorktreePath} on branch ${existingWorktreeBranch}`);
      actualWorkingPath = existingWorktreePath;
      resumedWorktreeInfo = {
        path: existingWorktreePath,
        branch: existingWorktreeBranch
      };
    }

    console.log(`[Agent] Final working directory: ${actualWorkingPath}`);

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
    if (!fs.existsSync(actualWorkingPath)) {
      throw new Error(`Working directory does not exist: ${actualWorkingPath}\n\nPlease create the directory or update your CHANNEL_MAPPINGS in the .env file.`);
    }

    // Check if directory is readable
    try {
      fs.accessSync(actualWorkingPath, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
      throw new Error(`No read/write permissions for working directory: ${actualWorkingPath}\n\nPlease check directory permissions.`);
    }

    // Change to the configured working directory
    process.chdir(actualWorkingPath);
    console.log(`[Agent] Changed to working directory: ${process.cwd()}`);

    // Detect VCS type
    const vcsType = detectVcs(actualWorkingPath);
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
            cwd: actualWorkingPath,
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
      workingDirectory: actualWorkingPath,
      settingSources: ["project" as SettingSource],
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

    // console.log('[Agent] Starting query with options:', JSON.stringify({
    //   workingDirectory: options.workingDirectory,
    //   allowedTools: options.allowedTools,
    //   permissionMode: options.permissionMode,
    //   resume: options.resume || 'none'
    // }));

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
        const worktreeInfo = createdWorktreeInfo || resumedWorktreeInfo;
        await onMessage({
          type: 'result',
          content: result,
          sessionId: sessionId,
          vcsType: vcsType,
          worktreePath: worktreeInfo?.path,
          worktreeBranch: worktreeInfo?.branch
        });
      }

      // Handle error messages
      if ('error' in message) {
        const error = (message as any).error;
        const errorContent = (message as any).message?.content?.[0]?.text || String(error);
        hasError = true;
        console.log(`[Agent] Got error: ${error}`);

        // Check for billing errors
        const worktreeInfo = createdWorktreeInfo || resumedWorktreeInfo;
        if (error === 'billing_error' || errorContent.includes('Credit balance is too low')) {
          await onMessage({
            type: 'error',
            content: `❌ Billing Error: ${errorContent}\n\nYour Anthropic API key has insufficient credits. Please add credits at https://console.anthropic.com/`,
            sessionId: sessionId,
            vcsType: vcsType,
            worktreePath: worktreeInfo?.path,
            worktreeBranch: worktreeInfo?.branch
          });
        } else {
          await onMessage({
            type: 'error',
            content: `Error: ${errorContent}`,
            sessionId: sessionId,
            vcsType: vcsType,
            worktreePath: worktreeInfo?.path,
            worktreeBranch: worktreeInfo?.branch
          });
        }
      }
    }

    // Only send generic completion if we didn't get a result or error
    if (!hasResult && !hasError) {
      console.log('[Agent] No result received, sending generic completion');
      const worktreeInfo = createdWorktreeInfo || resumedWorktreeInfo;
      await onMessage({
        type: 'result',
        content: 'Task completed.',
        sessionId: sessionId,
        vcsType: vcsType,
        worktreePath: worktreeInfo?.path,
        worktreeBranch: worktreeInfo?.branch
      });
    }

    // Return the session ID and worktree info for continuation
    if (!sessionId) {
      throw new Error('No session ID was captured from agent execution');
    }

    const worktreeInfo = createdWorktreeInfo || resumedWorktreeInfo;
    return {
      sessionId,
      worktreePath: worktreeInfo?.path,
      worktreeBranch: worktreeInfo?.branch
    };

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
        `  → Check directory exists and is writable: ${actualWorkingPath}\n\n` +
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
