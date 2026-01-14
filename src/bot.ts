import { Client, GatewayIntentBits, Events, EmbedBuilder, Channel, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { config, getWorkingPathForChannel, getChannelSettings, isChannelAllowed, ChannelSettings } from './utils/config.js';
import { handleClaudeCommand, handleClaudeContinueCommand, handleClaudeQuickCommand, createCommitButton, createActionButtons, createResultEmbed, createErrorEmbed, truncateMessage } from './commands/claude.js';
import { executeClaudePrompt, AgentMessage } from './agent/manager.js';
import { VcsType } from './utils/vcs.js';
import { getThreadSession, loadSessions } from './agent/sessions.js';
import { removeWorktree } from './utils/worktree.js';
import {
  enqueueRequest,
  dequeueRequestById,
  getNextRequest,
  setCurrentRequest,
  isProcessing,
  getQueuePosition,
  getQueueSize,
  type QueuedRequest
} from './agent/queue.js';

// Create Discord client with necessary intents
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Required to read message content and mentions
  ],
});

/**
 * Unified permission and settings checker for all handlers.
 * Works for both regular channels and forum threads by checking session data.
 * @param channel The Discord channel or thread
 * @returns Channel settings and working path, or null if not authorized
 */
function getChannelPermissions(channel: Channel): {
  settings: ChannelSettings;
  workingPath: string;
  worktreePath?: string;
  worktreeBranch?: string;
} | null {
  // Check if this is a forum thread
  if (channel.isThread()) {
    // Get session data to find the source channel
    const sessionData = getThreadSession(channel.id);
    if (!sessionData) {
      return null;
    }

    // Get settings from the source channel (where /claude was run)
    const settings = getChannelSettings(sessionData.sourceChannelId);
    if (!settings) {
      return null;
    }

    // For threads, use worktree path if available, otherwise use the main path
    const workingPath = sessionData.worktreePath || settings.path;

    return {
      settings,
      workingPath,
      worktreePath: sessionData.worktreePath,
      worktreeBranch: sessionData.worktreeBranch,
    };
  } else {
    // Regular channel - check if it's allowed
    if (!isChannelAllowed(channel.id)) {
      return null;
    }

    const settings = getChannelSettings(channel.id);
    if (!settings) {
      return null;
    }

    const workingPath = getWorkingPathForChannel(channel.id);
    if (!workingPath) {
      return null;
    }

    return {
      settings,
      workingPath,
    };
  }
}

/**
 * Commits changes in the working directory to Git.
 * @param workingPath The path to the working directory
 * @param updateStatus Optional callback to update status messages (for merge flow)
 * @returns Promise that resolves to true if commit was successful or no changes, false on error
 */
async function commitChanges(
  workingPath: string,
  updateStatus?: (message: string) => Promise<void>
): Promise<boolean> {
  const statusUpdate = updateStatus || (async () => { });

  try {
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    // Send initial status
    await statusUpdate('⏳ Checking for changes...');

    // Git workflow
    const statusResult = await execAsync('git status --porcelain', { cwd: workingPath });

    if (!statusResult.stdout.trim()) {
      // No changes to commit
      return true; // Success - no changes is not an error
    }

    // Parse git status to generate commit message
    const changes = statusResult.stdout.trim().split('\n');
    const added = changes.filter(line => line.startsWith('A') || line.startsWith('??')).length;
    const modified = changes.filter(line => line.startsWith('M') || line.startsWith(' M')).length;
    const deleted = changes.filter(line => line.startsWith('D') || line.startsWith(' D')).length;

    // Generate auto commit message
    const messageParts = [];
    if (added > 0) messageParts.push(`${added} file${added > 1 ? 's' : ''} added`);
    if (modified > 0) messageParts.push(`${modified} file${modified > 1 ? 's' : ''} modified`);
    if (deleted > 0) messageParts.push(`${deleted} file${deleted > 1 ? 's' : ''} deleted`);

    const commitMessage = messageParts.length > 0
      ? `Auto-commit: ${messageParts.join(', ')}`
      : 'Auto-commit: Changes made via Claude Code';

    // Update status
    await statusUpdate(`📝 Committing changes to Git...\n💬 Message: "${commitMessage}"`);

    // Add all changes and commit
    await execAsync('git add -A', { cwd: workingPath });
    await execAsync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}\n\nCo-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"`, {
      cwd: workingPath
    });

    return true; // Success
  } catch (error) {
    // Handle any errors during execution
    console.error('Error committing:', error);
    return false; // Failure
  }
}

// ClientReady event - bot is online and ready
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Bot is ready! Logged in as ${readyClient.user.tag}`);
  console.log(`🤖 Claude Code agent is ready to receive commands`);
  console.log(`📨 Message event listeners: ${client.listenerCount(Events.MessageCreate)}`);

  // Load saved sessions from disk
  loadSessions();

  // Send welcome message to all configured channels
  const channelsToNotify = Array.from(config.channelMappings.keys());

  // Send welcome message to each allowed channel
  for (const channelId of channelsToNotify) {
    try {
      const channel = await readyClient.channels.fetch(channelId);
      if (channel?.isTextBased() && 'send' in channel) {
        const workingDir = getWorkingPathForChannel(channelId);
        if (!workingDir) continue;

        const embed = new EmbedBuilder()
          .setColor(0x00ff00) // Green
          .setTitle('🤖 Claude Code Bot Online')
          .setDescription('I\'m ready to help you with your code!')
          .addFields(
            { name: '📁 Working Directory', value: `\`${workingDir}\``, inline: false },
            { name: '💬 Commands', value: '`/claude [prompt]` - Start a new conversation\n`/claude-continue [session-id] [prompt]` - Continue a conversation', inline: false },
            { name: '✨ Features', value: '• Interactive Continue buttons\n• Auto-detect Git/SVN with commit buttons\n• Live status updates\n• Session-based conversations', inline: false }
          )
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        await channel.send({ embeds: [embed] });
        console.log(`📨 Sent welcome message to channel ${channelId}`);
      }
    } catch (error) {
      console.warn(`⚠️  Could not send welcome message to channel ${channelId}:`, error instanceof Error ? error.message : error);
    }
  }
});

// Handle interactions (slash commands, buttons, modals)
client.on(Events.InteractionCreate, async (interaction) => {
  // Handle slash commands
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'claude') {
      await handleClaudeCommand(interaction);
    } else if (interaction.commandName === 'claude-continue') {
      await handleClaudeContinueCommand(interaction);
    } else if (interaction.commandName === 'claude-quick') {
      await handleClaudeQuickCommand(interaction);
    }
    return;
  }

  // Handle button clicks
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('commit_')) {
      // Extract session ID and VCS type from customId: commit_${sessionId}_${vcsType}
      const parts = interaction.customId.split('_');
      const vcsType = parts[parts.length - 1] as VcsType;
      const sessionId = parts.slice(1, -1).join('_');

      // Defer the reply immediately
      await interaction.deferReply();

      // Use unified permission checker
      const permissions = getChannelPermissions(interaction.channel!);
      if (!permissions) {
        await interaction.editReply({
          content: '❌ This bot is not configured for this channel.',
        });
        return;
      }

      const workingPath = permissions.workingPath;
      const startTime = Date.now();

      // Create status update function for commitChanges
      const updateStatus = async (message: string) => {
        await interaction.editReply(message);
      };

      // Check for changes first to determine commit message
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      const statusResult = await execAsync('git status --porcelain', { cwd: workingPath });

      if (!statusResult.stdout.trim()) {
        // No changes to commit
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const embed = new EmbedBuilder()
          .setColor(0xffa500) // Orange
          .setTitle('ℹ️ No Changes to Commit')
          .setDescription('There are no uncommitted changes in the working directory.')
          .addFields(
            { name: '⏱️ Duration', value: `${duration}s`, inline: true }
          )
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        await interaction.editReply({ content: '', embeds: [embed] });
        return;
      }

      // Parse git status to generate commit message
      const changes = statusResult.stdout.trim().split('\n');
      const added = changes.filter(line => line.startsWith('A') || line.startsWith('??')).length;
      const modified = changes.filter(line => line.startsWith('M') || line.startsWith(' M')).length;
      const deleted = changes.filter(line => line.startsWith('D') || line.startsWith(' D')).length;

      // Generate auto commit message
      const messageParts = [];
      if (added > 0) messageParts.push(`${added} file${added > 1 ? 's' : ''} added`);
      if (modified > 0) messageParts.push(`${modified} file${modified > 1 ? 's' : ''} modified`);
      if (deleted > 0) messageParts.push(`${deleted} file${deleted > 1 ? 's' : ''} deleted`);

      const commitMessage = messageParts.length > 0
        ? `Auto-commit: ${messageParts.join(', ')}`
        : 'Auto-commit: Changes made via Claude Code';

      // Call commit function
      const success = await commitChanges(workingPath, updateStatus);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      if (success) {
        // Get commit result for display
        const commitResult = await execAsync('git log -1 --pretty=format:"%H%n%s%n%b"', { cwd: workingPath });

        // Create success embed
        const embed = new EmbedBuilder()
          .setColor(0x00ff00) // Green
          .setTitle('✅ Changes Committed to Git')
          .setDescription('```\n' + (commitResult.stdout || 'Commit successful').substring(0, 3900) + '\n```')
          .addFields(
            { name: '💬 Commit Message', value: commitMessage.substring(0, 1024), inline: false },
            { name: '⏱️ Duration', value: `${duration}s`, inline: true }
          )
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        const commitButton = sessionId ? createCommitButton(sessionId, vcsType) : undefined;
        const components = commitButton ? [commitButton] : [];
        await interaction.editReply({ content: '', embeds: [embed], components });
      } else {
        // Handle error
        const errorMessage = 'Failed to commit changes';
        const embed = new EmbedBuilder()
          .setColor(0xff0000) // Red
          .setTitle('❌ Git Commit Failed')
          .setDescription('```\n' + errorMessage.substring(0, 3900) + '\n```')
          .addFields(
            { name: '⏱️ Duration', value: `${duration}s`, inline: true }
          )
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        await interaction.editReply({ content: '', embeds: [embed] });
      }
    } else if (interaction.customId.startsWith('merge_')) {
      // Defer the reply immediately
      await interaction.deferReply();

      // Use unified permission checker
      const permissions = getChannelPermissions(interaction.channel!);
      if (!permissions) {
        await interaction.editReply({
          content: '❌ This bot is not configured for this channel.',
        });
        return;
      }

      const worktreePath = permissions.worktreePath;
      const worktreeBranch = permissions.worktreeBranch;

      if (!worktreePath || !worktreeBranch) {
        await interaction.editReply({
          content: '❌ No worktree information found for this session.',
        });
        return;
      }

      if (!worktreeBranch.startsWith('worktree/')) {
        await interaction.editReply({
          content: '❌ This session is not using a worktree branch.',
        });
        return;
      }

      const mainRepoPath = permissions.settings.path;
      const startTime = Date.now();

      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        // Send initial status
        await interaction.editReply('⏳ Preparing to merge into main...');

        // Check if worktree has uncommitted changes and commit them if needed
        const statusResult = await execAsync('git status --porcelain', { cwd: worktreePath });
        if (statusResult.stdout.trim()) {
          await interaction.editReply('📝 Uncommitted changes detected. Committing changes before merge...');

          // Create status update function for commitChanges
          const updateStatus = async (message: string) => {
            await interaction.editReply(message);
          };

          // Commit the changes
          const commitSuccess = await commitChanges(worktreePath, updateStatus);
          if (!commitSuccess) {
            await interaction.editReply({
              content: '❌ Failed to commit changes. Please commit them manually before merging.',
            });
            return;
          }
        }

        await interaction.editReply('🔄 Switching to main branch...');

        // Switch to main repo and checkout main/master
        const { stdout: branchList } = await execAsync('git branch', { cwd: mainRepoPath });
        const hasMain = branchList.includes(' main');
        const mainBranch = hasMain ? 'main' : 'master';

        await execAsync(`git checkout ${mainBranch}`, { cwd: mainRepoPath });

        await interaction.editReply(`🔀 Merging ${worktreeBranch} into ${mainBranch}...`);

        // Merge the worktree branch into main
        const mergeResult = await execAsync(`git merge ${worktreeBranch} --no-ff -m "Merge worktree session: ${worktreeBranch}"`, {
          cwd: mainRepoPath
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Create success embed
        const embed = new EmbedBuilder()
          .setColor(0x00ff00) // Green
          .setTitle('✅ Merged into ' + mainBranch)
          .setDescription('```\n' + (mergeResult.stdout || mergeResult.stderr || 'Merge successful').substring(0, 3900) + '\n```')
          .addFields(
            { name: '🔀 Branch', value: worktreeBranch, inline: false },
            { name: '🎯 Target', value: mainBranch, inline: true },
            { name: '⏱️ Duration', value: `${duration}s`, inline: true }
          )
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        await interaction.editReply({ content: '', embeds: [embed] });

      } catch (error) {
        // Handle any errors during execution
        console.error('Error merging:', error);

        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        const embed = new EmbedBuilder()
          .setColor(0xff0000) // Red
          .setTitle('❌ Merge Failed')
          .setDescription('```\n' + errorMessage.substring(0, 3900) + '\n```')
          .addFields(
            { name: '⏱️ Duration', value: `${duration}s`, inline: true }
          )
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        await interaction.editReply({ content: '', embeds: [embed] });
      }
    } else if (interaction.customId.startsWith('close_worktree_')) {
      // Defer the reply immediately
      await interaction.deferReply();

      // Use unified permission checker
      const permissions = getChannelPermissions(interaction.channel!);
      if (!permissions) {
        await interaction.editReply({
          content: '❌ This bot is not configured for this channel.',
        });
        return;
      }

      const worktreePath = permissions.worktreePath;
      const worktreeBranch = permissions.worktreeBranch;

      if (!worktreePath || !worktreeBranch) {
        await interaction.editReply({
          content: '❌ No worktree information found for this session.',
        });
        return;
      }

      if (!worktreeBranch.startsWith('worktree/')) {
        await interaction.editReply({
          content: '❌ This session is not using a worktree branch.',
        });
        return;
      }

      const mainRepoPath = permissions.settings.path;
      const startTime = Date.now();

      try {
        // Send initial status
        await interaction.editReply('⏳ Closing worktree...');

        // Remove the worktree (this also deletes the branch)
        await removeWorktree(mainRepoPath, worktreePath);

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Create success embed
        const embed = new EmbedBuilder()
          .setColor(0x00ff00) // Green
          .setTitle('✅ Worktree Closed')
          .setDescription('The worktree has been removed and the branch has been deleted.')
          .addFields(
            { name: '🌳 Worktree', value: `\`${worktreePath}\``, inline: false },
            { name: '🔀 Branch', value: `\`${worktreeBranch}\``, inline: true },
            { name: '⏱️ Duration', value: `${duration}s`, inline: true }
          )
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        await interaction.editReply({ content: '', embeds: [embed] });

      } catch (error) {
        // Handle any errors during execution
        console.error('Error closing worktree:', error);

        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        const embed = new EmbedBuilder()
          .setColor(0xff0000) // Red
          .setTitle('❌ Failed to Close Worktree')
          .setDescription('```\n' + errorMessage.substring(0, 3900) + '\n```')
          .addFields(
            { name: '⏱️ Duration', value: `${duration}s`, inline: true }
          )
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        await interaction.editReply({ content: '', embeds: [embed] });
      }
    } else if (interaction.customId.startsWith('cancel_queue_')) {
      // Handle queue cancellation
      const requestId = interaction.customId.replace('cancel_queue_', '');

      // Try to remove the request from the queue
      const removed = dequeueRequestById(requestId);

      if (removed) {
        const embed = new EmbedBuilder()
          .setColor(0xff6b6b) // Red/pink
          .setTitle('❌ Request Cancelled')
          .setDescription('Your queued request has been cancelled and removed from the queue.')
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        await interaction.update({ embeds: [embed], components: [] });
        console.log(`[Queue] Request ${requestId} cancelled by user`);
      } else {
        // Request might already be processing or completed
        const embed = new EmbedBuilder()
          .setColor(0xffa500) // Orange
          .setTitle('⚠️ Cannot Cancel')
          .setDescription('This request is either already being processed or has been completed.')
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        await interaction.update({ embeds: [embed], components: [] });
      }
    }
    return;
  }
});

/**
 * Process a queued @ mention request
 */
async function processQueuedRequest(queuedReq: QueuedRequest): Promise<void> {
  const { message, prompt } = queuedReq;

  // Use unified permission checker
  const permissions = getChannelPermissions(message.channel);
  if (!permissions) {
    console.log(`[Bot] ❌ No session or permissions found for thread ${message.channel.id}`);
    await message.reply('⚠️ No session found for this thread. Please start a new conversation with `/claude` in a configured channel.');
    return;
  }

  // Get the session data to get the session ID
  const sessionData = getThreadSession(message.channel.id);
  if (!sessionData) {
    console.log(`[Bot] ❌ No session found for thread ${message.channel.id}`);
    await message.reply('⚠️ No session found for this thread. Please start a new conversation with `/claude` in a configured channel.');
    return;
  }

  console.log(`[Bot] ✅ Processing queued request ${queuedReq.id} for session ${sessionData.sessionId}`);

  let lastStatus = '';
  let hasResult = false;
  const startTime = Date.now();
  const statusMessages: string[] = [];

  try {
    // Send initial status embed
    const initialEmbed = new EmbedBuilder()
      .setColor(0x3498db) // Blue
      .setTitle('⏳ Resuming Claude Code Session...')
      .setDescription('Continuing the previous conversation...')
      .addFields(
        { name: '📝 Prompt', value: truncateMessage(prompt, 1024), inline: false }
      )
      .setFooter({ text: 'Claude Code Agent' })
      .setTimestamp();

    let statusMessage = await message.reply({ embeds: [initialEmbed] });

    // Execute the prompt with the existing session ID and worktree
    await executeClaudePrompt(
      prompt,
      async (agentMessage: AgentMessage) => {
        try {
          if (agentMessage.type === 'status') {
            // Accumulate status messages
            if (agentMessage.content !== lastStatus) {
              lastStatus = agentMessage.content;
              statusMessages.push(agentMessage.content);

              const duration = ((Date.now() - startTime) / 1000).toFixed(1);

              // Build the activity log
              let activityLog = '';
              const maxLogLength = 3000;

              for (let i = statusMessages.length - 1; i >= 0; i--) {
                const entry = `• ${statusMessages[i]}\n`;
                if (activityLog.length + entry.length > maxLogLength) {
                  activityLog = `...${activityLog}`;
                  break;
                }
                activityLog = entry + activityLog;
              }

              const statusEmbed = new EmbedBuilder()
                .setColor(0x3498db) // Blue
                .setTitle('🤖 Claude Code Agent Working...')
                .setDescription(activityLog || 'Processing your request...')
                .addFields(
                  { name: '📝 Prompt', value: truncateMessage(prompt, 1024), inline: false },
                  { name: '⏱️ Duration', value: `${duration}s`, inline: true }
                )
                .setFooter({ text: 'Claude Code Agent' })
                .setTimestamp();

              await statusMessage.edit({ embeds: [statusEmbed] });
            }
          } else if (agentMessage.type === 'result') {
            // Final result - use embed
            hasResult = true;
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const embed = createResultEmbed(prompt, agentMessage.content, duration, agentMessage.worktreePath, agentMessage.worktreeBranch, permissions.settings.branchUrl);
            const actionButtons = agentMessage.sessionId ? createActionButtons(agentMessage.sessionId, agentMessage.vcsType, agentMessage.worktreeBranch) : undefined;
            const components = actionButtons ? [actionButtons] : [];
            await statusMessage.edit({ embeds: [embed], components });
          } else if (agentMessage.type === 'error') {
            // Error occurred - use embed
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const embed = createErrorEmbed(prompt, agentMessage.content, duration, agentMessage.worktreePath, agentMessage.worktreeBranch, permissions.settings.branchUrl);
            const actionButtons = agentMessage.sessionId ? createActionButtons(agentMessage.sessionId, agentMessage.vcsType, agentMessage.worktreeBranch) : undefined;
            const components = actionButtons ? [actionButtons] : [];
            await statusMessage.edit({ embeds: [embed], components });
          }
        } catch (discordError) {
          // Handle Discord API errors (rate limits, etc.)
          console.error('Failed to update Discord message:', discordError);
        }
      },
      permissions.settings.path,
      permissions.settings,
      sessionData.sessionId, // Pass the session ID to resume
      sessionData.worktreePath, // Pass the worktree path if it exists
      sessionData.worktreeBranch // Pass the worktree branch if it exists
    );

    // If no result was sent, ensure we have a completion message
    if (!hasResult) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const embed = createResultEmbed(prompt, 'Task completed.', duration, undefined, undefined, permissions.settings.branchUrl);
      await statusMessage.edit({ embeds: [embed] });
    }
  } catch (error) {
    // Handle any errors during execution
    console.error('Error executing Claude prompt:', error);

    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    try {
      const embed = createErrorEmbed(
        prompt,
        `${errorMessage}\n\nPlease check the bot logs for more details.`,
        duration,
        undefined,
        undefined,
        permissions.settings.branchUrl
      );
      await message.reply({ embeds: [embed] });
    } catch (replyError) {
      console.error('Failed to send error embed:', replyError);
      await message.reply(`❌ Error: ${errorMessage}`);
    }
  } finally {
    // Mark this request as complete and process next queued request
    setCurrentRequest(null);
    const nextRequest = getNextRequest();
    if (nextRequest) {
      console.log(`[Queue] Processing next queued request ${nextRequest.id}`);
      setCurrentRequest(nextRequest);
      await processQueuedRequest(nextRequest);
    } else {
      console.log(`[Queue] No more requests in queue`);
    }
  }
}

// Handle messages (for @mentions in forum threads to continue conversations)
client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) {
    return;
  }

  // Check if bot was mentioned
  if (!message.mentions.has(client.user!)) {
    return;
  }

  // Check if message is in a forum thread
  if (!message.channel.isThread()) {
    console.log(`[Bot] Message is not in a thread, ignoring`);
    return;
  }

  console.log(`[Bot] Checking for session in thread ${message.channel.id}`);

  // Use unified permission checker
  const permissions = getChannelPermissions(message.channel);
  if (!permissions) {
    console.log(`[Bot] ❌ No session or permissions found for thread ${message.channel.id}`);
    await message.reply('⚠️ No session found for this thread. Please start a new conversation with `/claude` in a configured channel.');
    return;
  }

  // Get the session data to get the session ID
  const sessionData = getThreadSession(message.channel.id);
  if (!sessionData) {
    console.log(`[Bot] ❌ No session found for thread ${message.channel.id}`);
    await message.reply('⚠️ No session found for this thread. Please start a new conversation with `/claude` in a configured channel.');
    return;
  }

  console.log(`[Bot] ✅ Found session ${sessionData.sessionId} for thread ${message.channel.id}`);

  // Verify the thread is in the expected forum channel
  const parentChannel = message.channel.parent;
  if (!parentChannel) {
    console.log(`[Bot] ❌ Thread ${message.channel.id} has no parent channel`);
    await message.reply('⚠️ Error: thread has no parent channel.');
    return;
  }

  if (permissions.settings.forumChannelId && parentChannel.id !== permissions.settings.forumChannelId) {
    console.log(`[Bot] ❌ Thread parent ${parentChannel.id} does not match expected forum channel`);
    await message.reply('⚠️ This thread is not in the correct forum channel.');
    return;
  }

  // Extract the prompt (remove bot mention)
  const prompt = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!prompt) {
    await message.reply('Please provide a prompt along with the mention.');
    return;
  }

  // Check if a request is currently being processed
  if (isProcessing()) {
    console.log(`[Queue] Request already in progress, queueing this request`);

    // Add this request to the queue
    const queuedReq = enqueueRequest(message, prompt);
    const position = getQueuePosition(queuedReq.id);

    // Create cancel button
    const cancelButton = new ButtonBuilder()
      .setCustomId(`cancel_queue_${queuedReq.id}`)
      .setLabel('Cancel Request')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌');

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(cancelButton);

    // Send queued status embed
    const queueEmbed = new EmbedBuilder()
      .setColor(0xffa500) // Orange
      .setTitle('⏳ Request Queued')
      .setDescription(`Your request is in the queue and will be processed when the current request completes.`)
      .addFields(
        { name: '📝 Prompt', value: truncateMessage(prompt, 1024), inline: false },
        { name: '📊 Queue Position', value: `${position} of ${getQueueSize()}`, inline: true }
      )
      .setFooter({ text: 'Claude Code Agent' })
      .setTimestamp();

    await message.reply({ embeds: [queueEmbed], components: [actionRow] });
    return;
  }

  // No request in progress, process immediately
  console.log(`[Bot] No request in progress, processing immediately`);
  const queuedReq = { id: `immediate-${Date.now()}`, message, prompt, timestamp: Date.now() };
  setCurrentRequest(queuedReq);
  await processQueuedRequest(queuedReq);
});

// Error handling
client.on(Events.Error, (error) => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

// Login to Discord
export async function startBot(): Promise<void> {
  try {
    await client.login(config.discordToken);
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

// Graceful shutdown
export async function stopBot(): Promise<void> {
  console.log('Shutting down bot...');
  await client.destroy();
  process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', stopBot);
process.on('SIGTERM', stopBot);
