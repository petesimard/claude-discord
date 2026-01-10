import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { executeClaudePrompt, AgentMessage } from '../agent/manager.js';
import { config } from '../utils/config.js';

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
  if (config.allowedChannelId && channelId !== config.allowedChannelId) {
    await interaction.reply({
      content: '❌ This bot is restricted to a specific channel.',
      ephemeral: true,
    });
    return;
  }

  // Defer the reply immediately since agent execution can take a while
  await interaction.deferReply();

  let lastStatus = '';
  let hasResult = false;
  const startTime = Date.now();

  try {
    // Send initial status embed
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

    // Execute the prompt with streaming updates (starts fresh - no session resumption)
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
            const embed = createResultEmbed(prompt, message.content, duration);
            const components = message.sessionId ? [createContinueButton(message.sessionId)] : [];
            await interaction.editReply({ content: '', embeds: [embed], components });
          } else if (message.type === 'error') {
            // Error occurred - use embed
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const embed = createErrorEmbed(prompt, message.content, duration);
            const components = message.sessionId ? [createContinueButton(message.sessionId)] : [];
            await interaction.editReply({ content: '', embeds: [embed], components });
          }
        } catch (discordError) {
          // Handle Discord API errors (rate limits, etc.)
          console.error('Failed to update Discord message:', discordError);
        }
      }
    );

    // If no result was sent, ensure we have a completion message
    if (!hasResult) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const embed = createResultEmbed(prompt, 'Task completed.', duration);
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
        duration
      );
      await interaction.editReply({ content: '', embeds: [embed] });
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
  if (config.allowedChannelId && channelId !== config.allowedChannelId) {
    await interaction.reply({
      content: '❌ This bot is restricted to a specific channel.',
      ephemeral: true,
    });
    return;
  }

  // Defer the reply immediately since agent execution can take a while
  await interaction.deferReply();

  let lastStatus = '';
  let hasResult = false;
  const startTime = Date.now();

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
            const embed = createResultEmbed(prompt, message.content, duration);
            const components = message.sessionId ? [createContinueButton(message.sessionId)] : [];
            await interaction.editReply({ content: '', embeds: [embed], components });
          } else if (message.type === 'error') {
            // Error occurred - use embed
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const embed = createErrorEmbed(prompt, message.content, duration);
            const components = message.sessionId ? [createContinueButton(message.sessionId)] : [];
            await interaction.editReply({ content: '', embeds: [embed], components });
          }
        } catch (discordError) {
          // Handle Discord API errors (rate limits, etc.)
          console.error('Failed to update Discord message:', discordError);
        }
      },
      resumeSessionId // Pass the session ID to resume
    );

    // If no result was sent, ensure we have a completion message
    if (!hasResult) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const embed = createResultEmbed(prompt, 'Task completed.', duration);
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
        duration
      );
      await interaction.editReply({ content: '', embeds: [embed] });
    } catch (discordError) {
      console.error('Failed to send error message to Discord:', discordError);
    }
  }
}

/**
 * Create a button for continuing the conversation
 */
export function createContinueButton(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  const continueButton = new ButtonBuilder()
    .setCustomId(`continue_${sessionId}`)
    .setLabel('Continue Conversation')
    .setStyle(ButtonStyle.Primary)
    .setEmoji('💬');

  const commitButton = new ButtonBuilder()
    .setCustomId(`commit_${sessionId}`)
    .setLabel('Commit to SVN')
    .setStyle(ButtonStyle.Success)
    .setEmoji('✅');

  return new ActionRowBuilder<ButtonBuilder>().addComponents(continueButton, commitButton);
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
 * Create a success result embed
 */
export function createResultEmbed(prompt: string, result: string, duration: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0x00ff00) // Green
    .setTitle('✅ Task Completed')
    .setDescription(formatResult(result))
    .addFields(
      { name: '📝 Prompt', value: truncateMessage(prompt, 1024), inline: false },
      { name: '⏱️ Duration', value: `${duration}s`, inline: true }
    )
    .setFooter({ text: 'Claude Code Agent' })
    .setTimestamp();

  return embed;
}

/**
 * Create an error embed
 */
export function createErrorEmbed(prompt: string, error: string, duration: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xff0000) // Red
    .setTitle('❌ Error')
    .setDescription(truncateMessage(error, 3900))
    .addFields(
      { name: '📝 Prompt', value: truncateMessage(prompt, 1024), inline: false },
      { name: '⏱️ Duration', value: `${duration}s`, inline: true }
    )
    .setFooter({ text: 'Claude Code Agent' })
    .setTimestamp();

  return embed;
}
