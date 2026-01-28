import { Client, GatewayIntentBits, Events, EmbedBuilder, Channel, ButtonBuilder, ButtonStyle, ActionRowBuilder, Message } from 'discord.js';
import { config, getWorkingPathForChannel, getChannelSettings, isChannelAllowed, ChannelSettings } from './utils/config.js';
import { handleClaudeCommand, handleClaudeContinueCommand, handleClaudeQuickCommand, createActionButtons, createResultEmbed, createErrorEmbed, truncateMessage } from './commands/claude.js';
import { executeClaudePrompt, AgentMessage } from './agent/manager.js';
import { getThreadSession, loadSessions } from './agent/sessions.js';
import { removeWorktree } from './utils/worktree.js';
import { commitAndGetInfo } from './utils/git.js';
import { processImageAttachments, generateImagePromptAddition } from './utils/images.js';
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

// Track cancelled requests by request ID
const cancelledRequests = new Set<string>();

/**
 * Mark a request as cancelled
 */
function cancelRequest(requestId: string): void {
  cancelledRequests.add(requestId);
  console.log(`[Bot] Request ${requestId} marked as cancelled`);
}

/**
 * Check if a request was cancelled
 */
function isRequestCancelled(requestId: string): boolean {
  return cancelledRequests.has(requestId);
}

/**
 * Clear cancellation flag for a request
 */
function clearCancellation(requestId: string): void {
  cancelledRequests.delete(requestId);
}

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
      // Extract session ID from customId: commit_${sessionId}_${vcsType}
      const parts = interaction.customId.split('_');
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
        // Get commit hash
        const commitResult = await execAsync('git log -1 --pretty=format:"%H"', { cwd: workingPath });
        const commitHash = commitResult.stdout.trim();

        // Get the original message and embed
        const originalMessage = interaction.message;
        const originalEmbed = originalMessage?.embeds[0];

        if (originalEmbed) {
          // Update the original embed by adding commit info field
          const updatedEmbed = EmbedBuilder.from(originalEmbed);
          updatedEmbed.addFields({
            name: '✅ Committed',
            value: `\`${commitHash.substring(0, 7)}\` ${commitMessage}`,
            inline: false
          });

          // Create restore button (plus merge/close if in worktree)
          const buttons: ButtonBuilder[] = [
            new ButtonBuilder()
              .setCustomId(`restore_${commitHash}_${sessionId}`)
              .setLabel('Restore to this point')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('⏮️'),
          ];
          if (permissions.worktreeBranch && permissions.worktreeBranch.startsWith('worktree/')) {
            buttons.push(
              new ButtonBuilder()
                .setCustomId(`merge_${sessionId}`)
                .setLabel('Merge into main')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🔀'),
              new ButtonBuilder()
                .setCustomId(`close_worktree_${sessionId}`)
                .setLabel('Close worktree')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️'),
            );
          }
          const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

          // Update the original message with the new embed and button
          await originalMessage.edit({ embeds: [updatedEmbed], components: [actionRow] });
          await interaction.editReply({ content: '✅ Changes committed successfully!', embeds: [], components: [] });
        } else {
          // Fallback: create new embed if original not found
          const embed = new EmbedBuilder()
            .setColor(0x00ff00) // Green
            .setTitle('✅ Changes Committed to Git')
            .setDescription(`\`${commitHash.substring(0, 7)}\` ${commitMessage}`)
            .addFields(
              { name: '⏱️ Duration', value: `${duration}s`, inline: true }
            )
            .setFooter({ text: 'Claude Code Agent' })
            .setTimestamp();

          const fallbackButtons: ButtonBuilder[] = [
            new ButtonBuilder()
              .setCustomId(`restore_${commitHash}_${sessionId}`)
              .setLabel('Restore to this point')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('⏮️'),
          ];
          if (permissions.worktreeBranch && permissions.worktreeBranch.startsWith('worktree/')) {
            fallbackButtons.push(
              new ButtonBuilder()
                .setCustomId(`merge_${sessionId}`)
                .setLabel('Merge into main')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🔀'),
              new ButtonBuilder()
                .setCustomId(`close_worktree_${sessionId}`)
                .setLabel('Close worktree')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️'),
            );
          }
          const fallbackActionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...fallbackButtons);

          await interaction.editReply({ content: '', embeds: [embed], components: [fallbackActionRow] });
        }
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
    } else if (interaction.customId.startsWith('cancel_working_')) {
      // Handle cancellation of working request
      const requestId = interaction.customId.replace('cancel_working_', '');

      // Defer the reply immediately
      await interaction.deferReply();

      console.log(`[Bot] User requested cancellation of request ${requestId}`);

      // Mark the request as cancelled
      cancelRequest(requestId);

      // Use unified permission checker
      const permissions = getChannelPermissions(interaction.channel!);
      if (!permissions) {
        await interaction.editReply({
          content: '❌ This bot is not configured for this channel.',
        });
        return;
      }

      // Check if we need to revert (auto-commit enabled)
      if (permissions.settings.autoCommit) {
        try {
          const { exec } = await import('child_process');
          const { promisify } = await import('util');
          const execAsync = promisify(exec);

          // Get the commit hash to revert to (HEAD)
          const hashResult = await execAsync('git log -1 --pretty=format:"%H"', { cwd: permissions.workingPath });
          const currentCommit = hashResult.stdout.trim();

          // Get the commit message
          const commitInfoResult = await execAsync(`git log -1 --pretty=format:"%s" ${currentCommit}`, { cwd: permissions.workingPath });
          const commitMessage = commitInfoResult.stdout.trim();

          // Reset to discard any uncommitted changes made by the cancelled request
          await execAsync('git reset --hard HEAD', { cwd: permissions.workingPath });

          console.log(`[Bot] Reverted to commit ${currentCommit.substring(0, 7)} after cancellation`);

          const embed = new EmbedBuilder()
            .setColor(0xff6b6b) // Red/pink
            .setTitle('🛑 Request Cancelled')
            .setDescription('The request has been cancelled and any uncommitted changes have been discarded.')
            .addFields(
              { name: '📝 Reverted to', value: `\`${currentCommit.substring(0, 7)}\` ${commitMessage}`, inline: false }
            )
            .setFooter({ text: 'Claude Code Agent' })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });

          // Update the original status message
          const originalMessage = interaction.message;
          if (originalMessage) {
            const cancelledEmbed = new EmbedBuilder()
              .setColor(0xff6b6b) // Red/pink
              .setTitle('🛑 Request Cancelled')
              .setDescription('This request was cancelled by the user.')
              .setFooter({ text: 'Claude Code Agent' })
              .setTimestamp();

            await originalMessage.edit({ embeds: [cancelledEmbed], components: [] });
          }
        } catch (error) {
          console.error('[Bot] Failed to revert after cancellation:', error);
          const embed = new EmbedBuilder()
            .setColor(0xff6b6b) // Red/pink
            .setTitle('🛑 Request Cancelled')
            .setDescription('The request has been cancelled, but failed to revert changes. You may need to manually reset your repository.')
            .setFooter({ text: 'Claude Code Agent' })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
        }
      } else {
        // No auto-commit, just cancel
        const embed = new EmbedBuilder()
          .setColor(0xff6b6b) // Red/pink
          .setTitle('🛑 Request Cancelled')
          .setDescription('The request has been cancelled.')
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        // Update the original status message
        const originalMessage = interaction.message;
        if (originalMessage) {
          const cancelledEmbed = new EmbedBuilder()
            .setColor(0xff6b6b) // Red/pink
            .setTitle('🛑 Request Cancelled')
            .setDescription('This request was cancelled by the user.')
            .setFooter({ text: 'Claude Code Agent' })
            .setTimestamp();

          await originalMessage.edit({ embeds: [cancelledEmbed], components: [] });
        }
      }
    } else if (interaction.customId.startsWith('restore_')) {
      // Handle restore to commit
      // Custom ID format: restore_${commitHash}_${sessionId}
      const parts = interaction.customId.split('_');
      const commitHash = parts[1];

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

      try {
        // Send initial status
        await interaction.editReply('⏳ Restoring to commit...');

        // Reset to the specified commit
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        // Use git reset --hard to restore to the commit
        await execAsync(`git reset --hard ${commitHash}`, { cwd: workingPath });

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Get commit info for display
        const commitInfo = await execAsync(`git log -1 --pretty=format:"%H%n%s" ${commitHash}`, { cwd: workingPath });
        const [hash, subject] = commitInfo.stdout.split('\n');

        // Create success embed
        const embed = new EmbedBuilder()
          .setColor(0x00ff00) // Green
          .setTitle('✅ Restored to Commit')
          .setDescription(`Successfully reset the worktree to the specified commit.\n\n**All changes after this commit have been discarded.**`)
          .addFields(
            { name: '📝 Commit', value: `\`${hash.substring(0, 7)}\` ${subject}`, inline: false },
            { name: '⏱️ Duration', value: `${duration}s`, inline: true }
          )
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        await interaction.editReply({ content: '', embeds: [embed] });

      } catch (error) {
        // Handle any errors during execution
        console.error('Error restoring to commit:', error);

        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        const embed = new EmbedBuilder()
          .setColor(0xff0000) // Red
          .setTitle('❌ Failed to Restore')
          .setDescription('```\n' + errorMessage.substring(0, 3900) + '\n```')
          .addFields(
            { name: '⏱️ Duration', value: `${duration}s`, inline: true }
          )
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        await interaction.editReply({ content: '', embeds: [embed] });
      }
    }
    return;
  }
});

/**
 * Process a queued @ mention request
 */
async function processQueuedRequest(queuedReq: QueuedRequest): Promise<void> {
  const { message, prompt: originalPrompt } = queuedReq;

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

  // Get the current commit hash before processing (for potential revert)
  let previousCommitHash: string | null = null;
  if (permissions.settings.autoCommit) {
    try {
      const { exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);
      const hashResult = await execAsync('git log -1 --pretty=format:"%H"', { cwd: permissions.workingPath });
      previousCommitHash = hashResult.stdout.trim();
      console.log(`[Bot] Previous commit hash: ${previousCommitHash?.substring(0, 7)}`);
    } catch (error) {
      console.error('[Bot] Failed to get previous commit hash:', error);
    }
  }

  // Process image attachments if any
  let prompt = originalPrompt;
  const attachments = Array.from(message.attachments.values());

  if (attachments.length > 0) {
    console.log(`[Bot] Processing ${attachments.length} attachment(s)`);
    try {
      const savedImages = await processImageAttachments(attachments, permissions.workingPath);
      if (savedImages.length > 0) {
        console.log(`[Bot] Saved ${savedImages.length} image(s)`);
        // Append image information to the prompt
        prompt = originalPrompt + generateImagePromptAddition(savedImages);
      }
    } catch (error) {
      console.error('[Bot] Failed to process image attachments:', error);
      await message.reply('⚠️ Warning: Failed to process some image attachments. Continuing with text prompt only.');
    }
  }

  let lastStatus = '';
  let hasResult = false;
  const startTime = Date.now();
  const statusMessages: string[] = [];

  try {
    // Use the existing queue message if available, otherwise create a new one
    let statusMessage: Message;

    const initialEmbed = new EmbedBuilder()
      .setColor(0x3498db) // Blue
      .setTitle('⏳ Resuming Claude Code Session...')
      .setDescription('Continuing the previous conversation...')
      .addFields(
        { name: '📝 Prompt', value: truncateMessage(originalPrompt || 'Analyzing attached images...', 1024), inline: false }
      )
      .setFooter({ text: 'Claude Code Agent' })
      .setTimestamp();

    // Add image attachment info if present
    const imageAttachments = attachments.filter(att => att.contentType?.startsWith('image/'));
    if (imageAttachments.length > 0) {
      initialEmbed.addFields({
        name: '🖼️ Images',
        value: `${imageAttachments.length} image(s) attached`,
        inline: true
      });
    }

    if (queuedReq.queueMessage) {
      // Reuse the queue status message
      statusMessage = queuedReq.queueMessage;
      await statusMessage.edit({ embeds: [initialEmbed], components: [] });
      console.log(`[Bot] Reusing queue message for processing`);
    } else {
      // Create a new reply (for immediate processing)
      statusMessage = await message.reply({ embeds: [initialEmbed] });
    }

    // Execute the prompt with the existing session ID and worktree
    await executeClaudePrompt(
      prompt,
      async (agentMessage: AgentMessage) => {
        try {
          // Check if request was cancelled
          if (isRequestCancelled(queuedReq.id)) {
            console.log(`[Bot] Request ${queuedReq.id} was cancelled, stopping updates`);
            return;
          }

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
                  { name: '📝 Prompt', value: truncateMessage(originalPrompt || 'Analyzing attached images...', 1024), inline: false },
                  { name: '⏱️ Duration', value: `${duration}s`, inline: true }
                )
                .setFooter({ text: 'Claude Code Agent' })
                .setTimestamp();

              // Add image info if present
              if (imageAttachments.length > 0) {
                statusEmbed.addFields({
                  name: '🖼️ Images',
                  value: `${imageAttachments.length} image(s)`,
                  inline: true
                });
              }

              // Add cancel button
              const cancelButton = new ButtonBuilder()
                .setCustomId(`cancel_working_${queuedReq.id}`)
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🛑');

              const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(cancelButton);

              await statusMessage.edit({ embeds: [statusEmbed], components: [actionRow] });
            }
          } else if (agentMessage.type === 'result') {
            // Final result - use embed
            hasResult = true;
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const embed = createResultEmbed(prompt, agentMessage.content, duration, agentMessage.worktreePath, agentMessage.worktreeBranch, permissions.settings.branchUrl);

            // Check if autoCommit is enabled and we have a Git repository
            let commitInfo: { hash: string; message: string } | null = null;
            if (permissions.settings.autoCommit && agentMessage.vcsType === 'git') {
              console.log('[Bot] Auto-commit enabled, committing changes...');
              commitInfo = await commitAndGetInfo(permissions.workingPath);
              if (commitInfo) {
                console.log(`[Bot] Auto-committed: ${commitInfo.hash.substring(0, 7)} - ${commitInfo.message}`);
                // Add commit info to the embed
                embed.addFields({
                  name: '✅ Auto-Committed',
                  value: `\`${commitInfo.hash.substring(0, 7)}\` ${commitInfo.message}`,
                  inline: false
                });
              }
            }

            // Create action buttons (or restore button if committed)
            let components: any[] = [];
            if (commitInfo) {
              // Show restore button if changes were committed
              const restoreButton = new ButtonBuilder()
                .setCustomId(`restore_${commitInfo.hash}_${agentMessage.sessionId}`)
                .setLabel('Restore to this point')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('⏮️');
              const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(restoreButton);
              components = [actionRow];
            } else {
              // Show regular action buttons
              const actionButtons = agentMessage.sessionId ? createActionButtons(agentMessage.sessionId, agentMessage.vcsType, agentMessage.worktreeBranch) : undefined;
              components = actionButtons ? [actionButtons] : [];
            }

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
    // Clean up cancellation flag
    clearCancellation(queuedReq.id);

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
  let prompt = message.content.replace(/<@!?\d+>/g, '').trim();

  // Check for image attachments
  const hasImages = message.attachments.size > 0 &&
    Array.from(message.attachments.values()).some(att => att.contentType?.startsWith('image/'));

  if (!prompt && !hasImages) {
    await message.reply('Please provide a prompt and/or attach images with the mention.');
    return;
  }

  // If there's no text but there are images, add a default prompt
  if (!prompt && hasImages) {
    prompt = 'Please analyze the attached image(s).';
  }

  // Check if a request is currently being processed
  if (isProcessing()) {
    console.log(`[Queue] Request already in progress, queueing this request`);

    // Send queued status embed first
    const queueEmbed = new EmbedBuilder()
      .setColor(0xffa500) // Orange
      .setTitle('⏳ Request Queued')
      .setDescription(`Your request is in the queue and will be processed when the current request completes.`)
      .addFields(
        { name: '📝 Prompt', value: truncateMessage(prompt, 1024), inline: false }
      )
      .setFooter({ text: 'Claude Code Agent' })
      .setTimestamp();

    const queueMessage = await message.reply({ embeds: [queueEmbed] });

    // Add this request to the queue with the queue message
    const queuedReq = enqueueRequest(message, prompt, queueMessage);
    const position = getQueuePosition(queuedReq.id);

    // Create cancel button
    const cancelButton = new ButtonBuilder()
      .setCustomId(`cancel_queue_${queuedReq.id}`)
      .setLabel('Cancel Request')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌');

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(cancelButton);

    // Update the embed with position and cancel button
    queueEmbed.data.fields = [
      { name: '📝 Prompt', value: truncateMessage(prompt, 1024), inline: false },
      { name: '📊 Queue Position', value: `${position} of ${getQueueSize()}`, inline: true }
    ];

    await queueMessage.edit({ embeds: [queueEmbed], components: [actionRow] });
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
