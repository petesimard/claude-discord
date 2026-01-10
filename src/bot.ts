import { Client, GatewayIntentBits, Events, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder } from 'discord.js';
import { config, getWorkingPathForChannel, isChannelAllowed } from './utils/config.js';
import { handleClaudeCommand, handleClaudeContinueCommand, createContinueButton, createResultEmbed, createErrorEmbed } from './commands/claude.js';
import { executeClaudePrompt, AgentMessage } from './agent/manager.js';
import { VcsType } from './utils/vcs.js';

// Create Discord client with necessary intents
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

// ClientReady event - bot is online and ready
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Bot is ready! Logged in as ${readyClient.user.tag}`);
  console.log(`📁 Working directory: ${config.workingPath}`);
  console.log(`🤖 Claude Code agent is ready to receive commands`);

  // Send welcome message to allowed channels if configured
  const channelsToNotify: string[] = [];

  if (config.channelMappings.size > 0) {
    // If channel mappings are set, notify all mapped channels
    channelsToNotify.push(...config.channelMappings.keys());
  } else if (config.allowedChannelId) {
    // If only ALLOWED_CHANNEL_ID is set, notify that channel
    channelsToNotify.push(config.allowedChannelId);
  }

  // Send welcome message to each allowed channel
  for (const channelId of channelsToNotify) {
    try {
      const channel = await readyClient.channels.fetch(channelId);
      if (channel?.isTextBased() && 'send' in channel) {
        const workingDir = getWorkingPathForChannel(channelId);
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
    }
    return;
  }

  // Handle button clicks
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('continue_')) {
      const sessionId = interaction.customId.replace('continue_', '');

      // Create a modal for the user to enter their prompt
      const modal = new ModalBuilder()
        .setCustomId(`modal_continue_${sessionId}`)
        .setTitle('Continue Conversation');

      const promptInput = new TextInputBuilder()
        .setCustomId('prompt')
        .setLabel('What would you like to ask?')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Enter your follow-up prompt here...')
        .setRequired(true)
        .setMaxLength(2000);

      const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(promptInput);
      modal.addComponents(actionRow);

      await interaction.showModal(modal);
    } else if (interaction.customId.startsWith('commit_')) {
      // Extract session ID and VCS type from customId: commit_${sessionId}_${vcsType}
      const parts = interaction.customId.split('_');
      const vcsType = parts[parts.length - 1] as VcsType;
      const sessionId = parts.slice(1, -1).join('_');

      // Defer the reply immediately
      await interaction.deferReply();

      const channelId = interaction.channelId;

      // Check if the command is from an allowed channel
      if (!isChannelAllowed(channelId)) {
        await interaction.editReply({
          content: '❌ This bot is not configured for this channel.',
        });
        return;
      }

      // Get the working path for this channel
      const workingPath = getWorkingPathForChannel(channelId);

      const startTime = Date.now();

      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        // Send initial status
        await interaction.editReply('⏳ Checking for changes...');

        let statusResult;
        let commitResult;
        let commitMessage;

        if (vcsType === 'git') {
          // Git workflow
          statusResult = await execAsync('git status --porcelain', { cwd: workingPath });

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
          const parts = [];
          if (added > 0) parts.push(`${added} file${added > 1 ? 's' : ''} added`);
          if (modified > 0) parts.push(`${modified} file${modified > 1 ? 's' : ''} modified`);
          if (deleted > 0) parts.push(`${deleted} file${deleted > 1 ? 's' : ''} deleted`);

          commitMessage = parts.length > 0
            ? `Auto-commit: ${parts.join(', ')}`
            : 'Auto-commit: Changes made via Claude Code';

          // Update status
          await interaction.editReply(`📝 Committing changes to Git...\n💬 Message: "${commitMessage}"`);

          // Add all changes and commit
          await execAsync('git add -A', { cwd: workingPath });
          commitResult = await execAsync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}\n\nCo-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"`, {
            cwd: workingPath
          });
        } else {
          // SVN workflow
          statusResult = await execAsync('svn status', { cwd: workingPath });

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

          // Parse SVN status to generate commit message
          const changes = statusResult.stdout.trim().split('\n');
          const added = changes.filter(line => line.startsWith('A')).length;
          const modified = changes.filter(line => line.startsWith('M')).length;
          const deleted = changes.filter(line => line.startsWith('D')).length;

          // Generate auto commit message
          const parts = [];
          if (added > 0) parts.push(`${added} file${added > 1 ? 's' : ''} added`);
          if (modified > 0) parts.push(`${modified} file${modified > 1 ? 's' : ''} modified`);
          if (deleted > 0) parts.push(`${deleted} file${deleted > 1 ? 's' : ''} deleted`);

          commitMessage = parts.length > 0
            ? `Auto-commit: ${parts.join(', ')}`
            : 'Auto-commit: Changes made via Claude Code';

          // Update status
          await interaction.editReply(`📝 Committing changes to SVN...\n💬 Message: "${commitMessage}"`);

          // Perform the commit
          commitResult = await execAsync(`svn commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
            cwd: workingPath
          });
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Create success embed
        const vcsName = vcsType === 'git' ? 'Git' : 'SVN';
        const embed = new EmbedBuilder()
          .setColor(0x00ff00) // Green
          .setTitle(`✅ Changes Committed to ${vcsName}`)
          .setDescription('```\n' + (commitResult.stdout || commitResult.stderr || 'Commit successful').substring(0, 3900) + '\n```')
          .addFields(
            { name: '💬 Commit Message', value: commitMessage.substring(0, 1024), inline: false },
            { name: '⏱️ Duration', value: `${duration}s`, inline: true }
          )
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        const components = sessionId ? [createContinueButton(sessionId, vcsType)] : [];
        await interaction.editReply({ content: '', embeds: [embed], components });

      } catch (error) {
        // Handle any errors during execution
        console.error('Error committing:', error);

        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        const vcsName = vcsType === 'git' ? 'Git' : 'SVN';
        const embed = new EmbedBuilder()
          .setColor(0xff0000) // Red
          .setTitle(`❌ ${vcsName} Commit Failed`)
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

  // Handle modal submissions
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('modal_continue_')) {
      const sessionId = interaction.customId.replace('modal_continue_', '');
      const prompt = interaction.fields.getTextInputValue('prompt');

      // Defer the reply immediately
      await interaction.deferReply();

      const channelId = interaction.channelId;

      // Check if the command is from an allowed channel
      if (!isChannelAllowed(channelId || '')) {
        await interaction.editReply({
          content: '❌ This bot is not configured for this channel.',
        });
        return;
      }

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
            { name: '📝 Prompt', value: prompt.substring(0, 1024), inline: false }
          )
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        await interaction.editReply({ embeds: [initialEmbed] });

        // Get the working path for this channel
        const workingPath = getWorkingPathForChannel(channelId || '');

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
                      { name: '📝 Prompt', value: prompt.substring(0, 1024), inline: false },
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
                const components = message.sessionId ? [createContinueButton(message.sessionId, message.vcsType)] : [];
                await interaction.editReply({ content: '', embeds: [embed], components });
              } else if (message.type === 'error') {
                // Error occurred - use embed
                const duration = ((Date.now() - startTime) / 1000).toFixed(1);
                const embed = createErrorEmbed(prompt, message.content, duration);
                const components = message.sessionId ? [createContinueButton(message.sessionId, message.vcsType)] : [];
                await interaction.editReply({ content: '', embeds: [embed], components });
              }
            } catch (discordError) {
              // Handle Discord API errors (rate limits, etc.)
              console.error('Failed to update Discord message:', discordError);
            }
          },
          workingPath,
          sessionId // Pass the session ID to resume
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
    return;
  }
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
