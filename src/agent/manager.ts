import { query, SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { detectVcs, VcsType } from '../utils/vcs.js';
import type { ChannelSettings } from '../utils/config.js';
import { createWorktree, WorktreeInfo } from '../utils/worktree.js';
import { config } from '../utils/config.js';
import { spawn } from 'child_process';
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
 * Unified message format for both SDK and CLI
 */
interface StreamMessage {
  type: 'init' | 'assistant' | 'tool_use' | 'result' | 'error';
  sessionId?: string;
  content?: string;
  toolName?: string;
  error?: string;
}

/**
 * Interface for executing Claude queries - implemented by both SDK and CLI
 */
interface ClaudeExecutor {
  execute(prompt: string, workingPath: string, resumeSessionId?: string): AsyncGenerator<StreamMessage>;
}

/**
 * SDK-based executor using the Claude Agent SDK
 */
class SdkExecutor implements ClaudeExecutor {
  async *execute(prompt: string, workingPath: string, resumeSessionId?: string): AsyncGenerator<StreamMessage> {
    const options = {
      workingDirectory: workingPath,
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
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        DEBUG: process.env.DEBUG || '0'
      },
      onStderr: (data: string) => {
        console.error('[Agent] Claude CLI stderr:', data);
      },
      onStdout: (data: string) => {
        console.log('[Agent] Claude CLI stdout:', data);
      }
    };

    for await (const message of query({ prompt, options })) {
      // Capture session ID from init message
      if ('subtype' in message && message.subtype === 'init' && 'session_id' in message) {
        yield {
          type: 'init',
          sessionId: message.session_id as string
        };
      }

      // Handle assistant messages (intermediate commentary)
      if ('type' in message && (message as any).type === 'assistant' && !('result' in message)) {
        const messageContent = (message as any).message?.content;
        if (Array.isArray(messageContent)) {
          for (const block of messageContent) {
            if (block.type === 'text' && block.text) {
              yield {
                type: 'assistant',
                content: block.text
              };
            }
          }
        }
      }

      // Handle tool use messages
      if ('type' in message && (message as any).type === 'tool_use') {
        const toolName = (message as any).name || 'unknown';
        yield {
          type: 'tool_use',
          toolName: toolName
        };
      }

      // Handle result messages
      if ('result' in message) {
        const result = (message as any).result;
        yield {
          type: 'result',
          content: result
        };
      }

      // Handle error messages
      if ('error' in message) {
        const error = (message as any).error;
        const errorContent = (message as any).message?.content?.[0]?.text || String(error);
        yield {
          type: 'error',
          error: error,
          content: errorContent
        };
      }
    }
  }
}

/**
 * CLI-based executor using the claude command
 */
class CliExecutor implements ClaudeExecutor {
  async *execute(prompt: string, workingPath: string, resumeSessionId?: string): AsyncGenerator<StreamMessage> {
    // Use --print for non-interactive output
    // Use --dangerously-skip-permissions to match SDK behavior
    const args = ['--print', '--dangerously-skip-permissions', prompt];

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }

    console.log(`[Agent] Spawning claude CLI with args:`, args);

    const claudeProcess = spawn('claude', args, {
      cwd: workingPath,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Close stdin immediately
    if (claudeProcess.stdin) {
      claudeProcess.stdin.end();
    }

    let sessionId: string | undefined = resumeSessionId;
    let outputBuffer = '';
    let errorBuffer = '';
    let currentTool: string | null = null;

    // Create promise-based handlers for the process
    const processPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log('[Agent] CLI process timed out after 10 minutes');
        claudeProcess.kill('SIGTERM');
        reject(new Error('Claude CLI process timed out after 10 minutes'));
      }, 600000);

      claudeProcess.on('close', (code) => {
        clearTimeout(timeout);
        console.log(`[Agent] Claude CLI exited with code ${code}`);

        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Claude CLI exited with code ${code}: ${errorBuffer || outputBuffer}`));
        }
      });

      claudeProcess.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });

    // Set up data handlers that will yield messages
    const messageQueue: StreamMessage[] = [];
    let dataResolve: (() => void) | null = null;

    const pushMessage = (message: StreamMessage) => {
      messageQueue.push(message);
      if (dataResolve) {
        dataResolve();
        dataResolve = null;
      }
    };

    claudeProcess.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      outputBuffer += text;

      // Look for session ID in output
      const sessionIdMatch = text.match(/Session ID: ([a-f0-9-]+)/i);
      if (sessionIdMatch && !sessionId) {
        sessionId = sessionIdMatch[1];
        console.log(`[Agent] Captured session ID from CLI: ${sessionId}`);
        pushMessage({ type: 'init', sessionId });
      }

      // Detect tool usage patterns in output
      const toolMatch = text.match(/(?:Using|Calling)\s+(\w+)\s+tool/i);
      if (toolMatch && toolMatch[1] !== currentTool) {
        currentTool = toolMatch[1];
        pushMessage({ type: 'tool_use', toolName: currentTool });
      }

      // Send any text content as assistant messages
      const lines = text.trim().split('\n');
      for (const line of lines) {
        if (line.trim() && !line.includes('Session ID:')) {
          pushMessage({ type: 'assistant', content: line });
        }
      }
    });

    claudeProcess.stderr.on('data', (data: Buffer) => {
      const text = data.toString();
      errorBuffer += text;
      console.log(`[Agent] CLI stderr: ${text}`);
    });

    // Yield messages as they come in
    try {
      while (true) {
        if (messageQueue.length > 0) {
          yield messageQueue.shift()!;
        } else {
          // Wait for more data or process completion
          await Promise.race([
            processPromise,
            new Promise<void>((resolve) => {
              dataResolve = resolve;
            })
          ]);

          // Check if process is done
          if (claudeProcess.exitCode !== null) {
            break;
          }
        }
      }

      // Yield any remaining messages
      while (messageQueue.length > 0) {
        yield messageQueue.shift()!;
      }

      // Send final result
      yield {
        type: 'result',
        content: outputBuffer.trim() || 'Task completed.'
      };

    } catch (error) {
      // Send error message
      const errorMessage = error instanceof Error ? error.message : String(error);
      yield {
        type: 'error',
        error: 'execution_error',
        content: errorMessage
      };
      throw error;
    }
  }
}

/**
 * Check if the claude CLI is available
 * @returns Promise that resolves to true if claude CLI is available, false otherwise
 */
async function checkClaudeCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const checkProcess = spawn('which', ['claude']);

    checkProcess.on('close', (code) => {
      resolve(code === 0);
    });

    checkProcess.on('error', () => {
      resolve(false);
    });
  });
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

    // Create the appropriate executor based on configuration
    let executor: ClaudeExecutor;

    if (config.useCli) {
      console.log('[Agent] Using Claude Code CLI mode');

      // Check if claude CLI is available
      const cliAvailable = await checkClaudeCliAvailable();
      if (!cliAvailable) {
        throw new Error(
          'Claude Code CLI is not installed or not in PATH.\n\n' +
          'Please install Claude Code CLI:\n' +
          '  https://github.com/anthropics/claude-code\n\n' +
          'Or set ANTHROPIC_API_KEY in .env to use the Agent SDK instead.'
        );
      }

      console.log('[Agent] Claude CLI is available');
      executor = new CliExecutor();
    } else {
      // SDK mode - verify API key is set
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY environment variable is not set!');
      }
      console.log(`[Agent] Using Agent SDK mode`);
      console.log(`[Agent] API key is set: ${process.env.ANTHROPIC_API_KEY.substring(0, 10)}...`);
      executor = new SdkExecutor();
    }

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

    // Execute the query using the unified executor and stream messages
    let currentTool: string | null = null;
    let sessionId: string | undefined = resumeSessionId;
    let hasResult = false;
    let hasError = false;

    for await (const message of executor.execute(prompt, actualWorkingPath, resumeSessionId)) {
      // Debug: Log message type
      console.log(`[Agent] Message type: ${message.type}, sessionId: ${message.sessionId || 'none'}`);

      // Capture session ID from init message
      if (message.type === 'init' && message.sessionId) {
        sessionId = message.sessionId;
        console.log(`[Agent] Session ID: ${sessionId}`);
      }

      // Handle assistant messages (intermediate commentary)
      if (message.type === 'assistant' && message.content) {
        console.log(`[Agent] Assistant message: ${message.content.substring(0, 100)}...`);
        await onMessage({
          type: 'status',
          content: message.content
        });
      }

      // Handle tool use messages (status updates)
      if (message.type === 'tool_use' && message.toolName) {
        if (message.toolName !== currentTool) {
          currentTool = message.toolName;
          await onMessage({
            type: 'status',
            content: `🔄 Working... (using ${message.toolName} tool)`
          });
        }
      }

      // Handle result messages (final output)
      if (message.type === 'result' && message.content) {
        hasResult = true;
        console.log(`[Agent] Got result: ${message.content.substring(0, 100)}...`);
        const worktreeInfo = createdWorktreeInfo || resumedWorktreeInfo;
        await onMessage({
          type: 'result',
          content: message.content,
          sessionId: sessionId,
          vcsType: vcsType,
          worktreePath: worktreeInfo?.path,
          worktreeBranch: worktreeInfo?.branch
        });
      }

      // Handle error messages
      if (message.type === 'error') {
        const errorContent = message.content || message.error || 'Unknown error';
        hasError = true;
        console.log(`[Agent] Got error: ${message.error}`);

        // Check for billing errors
        const worktreeInfo = createdWorktreeInfo || resumedWorktreeInfo;
        if (message.error === 'billing_error' || errorContent.includes('Credit balance is too low')) {
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
