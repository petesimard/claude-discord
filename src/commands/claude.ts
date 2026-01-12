import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, MessageFlags } from 'discord.js';
import { executeClaudePrompt, AgentMessage } from '../agent/manager.js';
import { getChannelSettings, isChannelAllowed } from '../utils/config.js';
import { VcsType, getCommitButtonLabel } from '../utils/vcs.js';
import { setThreadSession } from '../agent/sessions.js';
import * as path from 'path';

// Define the /claude command structure
export const claudeCommand = new SlashCommandBuilder()
  .setName('claude')
  .setDescription('Execute a Claude Code prompt')
  .addStringOption((option) =>
    option
      .setName('prompt')
      .setDescription('The prompt to send to Claude Code')
      .setRequired(true)
  );

// Define the /claude-continue command structure
export const claudeContinueCommand = new SlashCommandBuilder()
  .setName('claude-continue')
  .setDescription('Continue a previous Claude Code conversation')
  .addStringOption((option) =>
    option
      .setName('session-id')
      .setDescription('The session ID from a previous conversation')
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName('prompt')
      .setDescription('The prompt to send to Claude Code')
      .setRequired(true)
  );

/**
 * Handle the /claude slash command
 */
export async function handleClaudeCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const prompt = interaction.options.getString('prompt', true);
  const channelId = interaction.channelId;

  // Check if the command is from an allowed channel
  if (!isChannelAllowed(channelId)) {
    await interaction.reply({
      content: '❌ This bot is not configured for this channel.',
      ephemeral: true,
    });
    return;
  }

  // Get the channel settings
  const channelSettings = getChannelSettings(channelId);
  if (!channelSettings) {
    await interaction.reply({
      content: '❌ No settings configured for this channel.',
      ephemeral: true,
    });
    return;
  }

  // Defer the reply immediately since agent execution can take a while
  // Make ephemeral if using forum channels (so the ack doesn't clutter the source channel)
  await interaction.deferReply({
    flags: channelSettings.forumChannelId ? MessageFlags.Ephemeral : undefined
  });

  let lastStatus = '';
  let hasResult = false;
  const startTime = Date.now();
  let thread: any = null;
  let statusMessage: any = null;

  try {
    // Check if we should create a forum thread
    if (channelSettings.forumChannelId) {
      console.log(`[Claude] Attempting to fetch forum channel: ${channelSettings.forumChannelId} (length: ${channelSettings.forumChannelId.length})`);

      // Verify the forum channel is accessible
      let forumChannel;
      try {
        forumChannel = await interaction.client.channels.fetch(channelSettings.forumChannelId);
      } catch (error) {
        throw new Error(
          `Cannot access forum channel ${channelSettings.forumChannelId}. ` +
          `Make sure:\n` +
          `1. The channel ID is correct (right-click forum channel → Copy ID)\n` +
          `2. The forum channel is in the SAME server as the command channel\n` +
          `3. The bot has "View Channel" permission for the forum channel\n` +
          `\nError: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      if (!forumChannel || forumChannel.type !== ChannelType.GuildForum) {
        throw new Error(
          `Channel ${channelSettings.forumChannelId} is not a forum channel. ` +
          `Make sure you're using the ID of a forum channel (the parent channel with posts, not a post itself).`
        );
      }

      // Create a thread name from the prompt (max 100 characters)
      const threadName = prompt.length > 100 ? prompt.substring(0, 97) + '...' : prompt;

      // Send initial ack to interaction
      await interaction.editReply({ content: `✅ Creating forum thread for your request...` });

      // Create the forum thread
      thread = await forumChannel.threads.create({
        name: threadName,
        message: {
          content: `🤖 Claude Code Session\n📝 **Prompt:** ${prompt}`,
        },
      });

      console.log(`[Claude] Created forum thread ${thread.id} for session`);

      // Update interaction with thread link
      await interaction.editReply({ content: `✅ Session thread created: <#${thread.id}>` });

      // Send initial status in the thread
      const initialEmbed = new EmbedBuilder()
        .setColor(0x3498db) // Blue
        .setTitle('⏳ Starting Claude Code Agent...')
        .setDescription('Initializing agent and preparing to execute your request.')
        .addFields(
          { name: '📝 Prompt', value: truncateMessage(prompt, 1024), inline: false }
        )
        .setFooter({ text: 'Claude Code Agent' })
        .setTimestamp();

      statusMessage = await thread.send({ embeds: [initialEmbed] });
    } else {
      // No forum channel configured - use regular channel
      const initialEmbed = new EmbedBuilder()
        .setColor(0x3498db) // Blue
        .setTitle('⏳ Starting Claude Code Agent...')
        .setDescription('Initializing agent and preparing to execute your request.')
        .addFields(
          { name: '📝 Prompt', value: truncateMessage(prompt, 1024), inline: false }
        )
        .setFooter({ text: 'Claude Code Agent' })
        .setTimestamp();

      await interaction.editReply({ embeds: [initialEmbed] });
    }

    // Execute the prompt with streaming updates (starts fresh - no session resumption)
    const result = await executeClaudePrompt(
      prompt,
      async (message: AgentMessage) => {
        try {
          if (message.type === 'status') {
            // Update status if it changed
            if (message.content !== lastStatus) {
              lastStatus = message.content;
              const duration = ((Date.now() - startTime) / 1000).toFixed(1);
              const statusEmbed = new EmbedBuilder()
                .setColor(0x3498db) // Blue
                .setTitle(message.content)
                .setDescription('Processing your request...')
                .addFields(
                  { name: '📝 Prompt', value: truncateMessage(prompt, 1024), inline: false },
                  { name: '⏱️ Duration', value: `${duration}s`, inline: true }
                )
                .setFooter({ text: 'Claude Code Agent' })
                .setTimestamp();

              if (thread && statusMessage) {
                await statusMessage.edit({ embeds: [statusEmbed] });
              } else {
                await interaction.editReply({ embeds: [statusEmbed] });
              }
            }
          } else if (message.type === 'result') {
            // Final result - use embed
            hasResult = true;
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const embed = createResultEmbed(prompt, message.content, duration, message.worktreePath, message.worktreeBranch, channelSettings.branchUrl);
            const actionButtons = message.sessionId ? createActionButtons(message.sessionId, message.vcsType, message.worktreeBranch) : undefined;
            const components = actionButtons ? [actionButtons] : [];

            if (thread && statusMessage) {
              await statusMessage.edit({ embeds: [embed], components });
              // Store the thread -> session mapping with source channel and worktree info
              if (message.sessionId) {
                setThreadSession(thread.id, message.sessionId, channelId, message.worktreePath, message.worktreeBranch);
                console.log(`[Claude] Mapped thread ${thread.id} to session ${message.sessionId} (source: ${channelId})`);
              }
            } else {
              await interaction.editReply({ content: '', embeds: [embed], components });
            }
          } else if (message.type === 'error') {
            // Error occurred - use embed
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const embed = createErrorEmbed(prompt, message.content, duration, message.worktreePath, message.worktreeBranch, channelSettings.branchUrl);
            const actionButtons = message.sessionId ? createActionButtons(message.sessionId, message.vcsType, message.worktreeBranch) : undefined;
            const components = actionButtons ? [actionButtons] : [];

            if (thread && statusMessage) {
              await statusMessage.edit({ embeds: [embed], components });
              // Store the thread -> session mapping even on error
              if (message.sessionId) {
                setThreadSession(thread.id, message.sessionId, channelId, message.worktreePath, message.worktreeBranch);
              }
            } else {
              await interaction.editReply({ content: '', embeds: [embed], components });
            }
          }
        } catch (discordError) {
          // Handle Discord API errors (rate limits, etc.)
          console.error('Failed to update Discord message:', discordError);
        }
      },
      channelSettings.path,
      channelSettings
    );

    // If no result was sent, ensure we have a completion message
    if (!hasResult) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const embed = createResultEmbed(prompt, 'Task completed.', duration, result.worktreePath, result.worktreeBranch, channelSettings.branchUrl);

      if (thread && statusMessage) {
        await statusMessage.edit({ embeds: [embed] });
        // Store the thread -> session mapping
        setThreadSession(thread.id, result.sessionId, channelId, result.worktreePath, result.worktreeBranch);
      } else {
        await interaction.editReply({ content: '', embeds: [embed] });
      }
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
        channelSettings.branchUrl
      );

      if (thread && statusMessage) {
        await statusMessage.edit({ embeds: [embed] });
      } else {
        await interaction.editReply({ content: '', embeds: [embed] });
      }
    } catch (discordError) {
      console.error('Failed to send error message to Discord:', discordError);
    }
  }
}

/**
 * Handle the /claude-continue slash command
 */
export async function handleClaudeContinueCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const resumeSessionId = interaction.options.getString('session-id', true);
  const prompt = interaction.options.getString('prompt', true);
  const channelId = interaction.channelId;

  // Check if the command is from an allowed channel
  if (!isChannelAllowed(channelId)) {
    await interaction.reply({
      content: '❌ This bot is not configured for this channel.',
      ephemeral: true,
    });
    return;
  }

  // Defer the reply immediately since agent execution can take a while
  await interaction.deferReply();

  let lastStatus = '';
  let hasResult = false;
  const startTime = Date.now();

  // Get the channel settings (before try block so it's accessible in catch)
  const channelSettings = getChannelSettings(channelId);
  if (!channelSettings) {
    await interaction.editReply({
      content: '❌ No settings configured for this channel.',
    });
    return;
  }

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

    await interaction.editReply({ embeds: [initialEmbed] });

    // Execute the prompt with the existing session ID
    await executeClaudePrompt(
      prompt,
      async (message: AgentMessage) => {
        try {
          if (message.type === 'status') {
            // Update status if it changed
            if (message.content !== lastStatus) {
              lastStatus = message.content;
              const duration = ((Date.now() - startTime) / 1000).toFixed(1);
              const statusEmbed = new EmbedBuilder()
                .setColor(0x3498db) // Blue
                .setTitle(message.content)
                .setDescription('Processing your request...')
                .addFields(
                  { name: '📝 Prompt', value: truncateMessage(prompt, 1024), inline: false },
                  { name: '⏱️ Duration', value: `${duration}s`, inline: true }
                )
                .setFooter({ text: 'Claude Code Agent' })
                .setTimestamp();
              await interaction.editReply({ embeds: [statusEmbed] });
            }
          } else if (message.type === 'result') {
            // Final result - use embed
            hasResult = true;
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const embed = createResultEmbed(prompt, message.content, duration, message.worktreePath, message.worktreeBranch, channelSettings.branchUrl);
            const actionButtons = message.sessionId ? createActionButtons(message.sessionId, message.vcsType, message.worktreeBranch) : undefined;
            const components = actionButtons ? [actionButtons] : [];
            await interaction.editReply({ content: '', embeds: [embed], components });
          } else if (message.type === 'error') {
            // Error occurred - use embed
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const embed = createErrorEmbed(prompt, message.content, duration, message.worktreePath, message.worktreeBranch, channelSettings.branchUrl);
            const actionButtons = message.sessionId ? createActionButtons(message.sessionId, message.vcsType, message.worktreeBranch) : undefined;
            const components = actionButtons ? [actionButtons] : [];
            await interaction.editReply({ content: '', embeds: [embed], components });
          }
        } catch (discordError) {
          // Handle Discord API errors (rate limits, etc.)
          console.error('Failed to update Discord message:', discordError);
        }
      },
      channelSettings.path,
      channelSettings,
      resumeSessionId // Pass the session ID to resume
    );

    // If no result was sent, ensure we have a completion message
    if (!hasResult) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const embed = createResultEmbed(prompt, 'Task completed.', duration, undefined, undefined, channelSettings.branchUrl);
      await interaction.editReply({ content: '', embeds: [embed] });
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
        channelSettings.branchUrl
      );
      await interaction.editReply({ content: '', embeds: [embed] });
    } catch (discordError) {
      console.error('Failed to send error message to Discord:', discordError);
    }
  }
}

/**
 * Create action buttons (commit and/or merge)
 */
export function createActionButtons(
  sessionId: string,
  vcsType: VcsType = 'none',
  worktreeBranch?: string
): ActionRowBuilder<ButtonBuilder> | undefined {
  const buttons: ButtonBuilder[] = [];

  // Add commit button if Git is detected
  if (vcsType === 'git') {
    const commitButton = new ButtonBuilder()
      .setCustomId(`commit_${sessionId}_${vcsType}`)
      .setLabel(getCommitButtonLabel(vcsType))
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅');
    buttons.push(commitButton);
  }

  // Add merge button if working in a worktree
  if (worktreeBranch && worktreeBranch.startsWith('worktree/')) {
    const mergeButton = new ButtonBuilder()
      .setCustomId(`merge_${sessionId}`)
      .setLabel('Merge into main')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🔀');
    buttons.push(mergeButton);
  }

  if (buttons.length > 0) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
  }

  return undefined;
}

/**
 * Create commit button if Git is detected (deprecated - use createActionButtons)
 */
export function createCommitButton(sessionId: string, vcsType: VcsType = 'none'): ActionRowBuilder<ButtonBuilder> | undefined {
  return createActionButtons(sessionId, vcsType);
}

/**
 * Truncate message to fit Discord's embed description limit
 */
export function truncateMessage(message: string, maxLength: number = 4000): string {
  if (message.length <= maxLength) {
    return message;
  }

  const truncated = message.substring(0, maxLength - 50);
  return `${truncated}\n\n... (output truncated)`;
}

/**
 * Format the result content for display
 */
export function formatResult(content: string): string {
  const truncated = truncateMessage(content, 3900);

  // If content looks like code or has multiple lines, wrap in code block
  if (truncated.includes('\n') || truncated.length > 100) {
    return `\`\`\`\n${truncated}\n\`\`\``;
  }

  return truncated;
}

/**
 * Extract branch ID from worktree path
 * The branch ID is the full worktree directory name
 * Example: /home/outwar-worktrees/outwar-com-1768240643512-q3om9o -> outwar-com-1768240643512-q3om9o
 */
function extractBranchId(worktreePath: string): string {
  return path.basename(worktreePath);
}

/**
 * Create a success result embed
 */
export function createResultEmbed(
  prompt: string,
  result: string,
  duration: string,
  worktreePath?: string,
  worktreeBranch?: string,
  branchUrl?: string
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x00ff00) // Green
    .setTitle('✅ Task Completed')
    .setDescription(formatResult(result))
    .addFields(
      { name: '📝 Prompt', value: truncateMessage(prompt, 1024), inline: false },
      { name: '⏱️ Duration', value: `${duration}s`, inline: true }
    );

  // Add worktree information if present
  if (worktreePath && worktreeBranch) {
    embed.addFields(
      { name: '🌳 Worktree', value: `\`${worktreePath}\``, inline: false },
      { name: '🔀 Branch', value: `\`${worktreeBranch}\``, inline: true }
    );

    // Add branch URL if branchUrl template is provided
    if (branchUrl) {
      const branchId = extractBranchId(worktreePath);
      const fullUrl = branchUrl.replace('[branchId]', branchId);
      embed.addFields(
        { name: '🔗 Branch URL', value: fullUrl, inline: true }
      );
    }
  }

  embed.setFooter({ text: 'Claude Code Agent' })
    .setTimestamp();

  return embed;
}

/**
 * Create an error embed
 */
export function createErrorEmbed(
  prompt: string,
  error: string,
  duration: string,
  worktreePath?: string,
  worktreeBranch?: string,
  branchUrl?: string
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xff0000) // Red
    .setTitle('❌ Error')
    .setDescription(truncateMessage(error, 3900))
    .addFields(
      { name: '📝 Prompt', value: truncateMessage(prompt, 1024), inline: false },
      { name: '⏱️ Duration', value: `${duration}s`, inline: true }
    );

  // Add worktree information if present
  if (worktreePath && worktreeBranch) {
    embed.addFields(
      { name: '🌳 Worktree', value: `\`${worktreePath}\``, inline: false },
      { name: '🔀 Branch', value: `\`${worktreeBranch}\``, inline: true }
    );

    // Add branch URL if branchUrl template is provided
    if (branchUrl) {
      const branchId = extractBranchId(worktreePath);
      const fullUrl = branchUrl.replace('[branchId]', branchId);
      embed.addFields(
        { name: '🔗 Branch URL', value: fullUrl, inline: true }
      );
    }
  }

  embed.setFooter({ text: 'Claude Code Agent' })
    .setTimestamp();

  return embed;
}
