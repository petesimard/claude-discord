import { Client, GatewayIntentBits, Events, EmbedBuilder } from 'discord.js';
import { config, getWorkingPathForChannel, getChannelSettings, isChannelAllowed } from './utils/config.js';
import { handleClaudeCommand, handleClaudeContinueCommand, createCommitButton, createResultEmbed, createErrorEmbed, truncateMessage } from './commands/claude.js';
import { executeClaudePrompt, AgentMessage } from './agent/manager.js';
import { VcsType } from './utils/vcs.js';
import { getThreadSession } from './agent/sessions.js';

// Create Discord client with necessary intents
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Required to read message content and mentions
  ],
});

// ClientReady event - bot is online and ready
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Bot is ready! Logged in as ${readyClient.user.tag}`);
  console.log(`🤖 Claude Code agent is ready to receive commands`);
  console.log(`📨 Message event listeners: ${client.listenerCount(Events.MessageCreate)}`);

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
      if (!workingPath) {
        await interaction.editReply({
          content: '❌ No working directory configured for this channel.',
        });
        return;
      }

      const startTime = Date.now();

      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        // Send initial status
        await interaction.editReply('⏳ Checking for changes...');

        // Git workflow
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

        // Update status
        await interaction.editReply(`📝 Committing changes to Git...\n💬 Message: "${commitMessage}"`);

        // Add all changes and commit
        await execAsync('git add -A', { cwd: workingPath });
        const commitResult = await execAsync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}\n\nCo-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"`, {
          cwd: workingPath
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Create success embed
        const embed = new EmbedBuilder()
          .setColor(0x00ff00) // Green
          .setTitle('✅ Changes Committed to Git')
          .setDescription('```\n' + (commitResult.stdout || commitResult.stderr || 'Commit successful').substring(0, 3900) + '\n```')
          .addFields(
            { name: '💬 Commit Message', value: commitMessage.substring(0, 1024), inline: false },
            { name: '⏱️ Duration', value: `${duration}s`, inline: true }
          )
          .setFooter({ text: 'Claude Code Agent' })
          .setTimestamp();

        const commitButton = sessionId ? createCommitButton(sessionId, vcsType) : undefined;
        const components = commitButton ? [commitButton] : [];
        await interaction.editReply({ content: '', embeds: [embed], components });

      } catch (error) {
        // Handle any errors during execution
        console.error('Error committing:', error);

        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

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
    }
    return;
  }
});

// Handle messages (for @mentions in forum threads to continue conversations)
client.on(Events.MessageCreate, async (message) => {
  console.log(`[Bot] 🔔 MessageCreate event fired! Channel: ${message.channel.id}, Author: ${message.author.tag}, Bot: ${message.author.bot}`);

  // Ignore bot messages
  if (message.author.bot) {
    console.log(`[Bot] Ignoring bot message`);
    return;
  }

  console.log(`[Bot] Message content: "${message.content}"`);
  console.log(`[Bot] Channel type: ${message.channel.type}, Is thread: ${message.channel.isThread()}`);
  console.log(`[Bot] Mentions: ${message.mentions.users.map(u => u.tag).join(', ')}`);
  console.log(`[Bot] Bot mentioned: ${message.mentions.has(client.user!)}`);

  // Check if bot was mentioned
  if (!message.mentions.has(client.user!)) {
    console.log(`[Bot] Bot not mentioned, ignoring`);
    return;
  }

  // Check if message is in a forum thread
  if (!message.channel.isThread()) {
    console.log(`[Bot] Message is not in a thread, ignoring`);
    return;
  }

  console.log(`[Bot] Checking for session in thread ${message.channel.id}`);

  // Get the session data for this thread
  const sessionData = getThreadSession(message.channel.id);
  if (!sessionData) {
    console.log(`[Bot] ❌ No session found for thread ${message.channel.id}`);
    await message.reply('⚠️ No session found for this thread. Please start a new conversation with `/claude` in a configured channel.');
    return;
  }

  console.log(`[Bot] ✅ Found session ${sessionData.sessionId} for thread ${message.channel.id} (source channel: ${sessionData.sourceChannelId})`);

  // Get channel settings from the source channel (where /claude was run)
  const channelSettings = getChannelSettings(sessionData.sourceChannelId);
  if (!channelSettings) {
    console.log(`[Bot] ❌ No settings found for source channel ${sessionData.sourceChannelId}`);
    await message.reply('⚠️ Configuration error: source channel no longer configured.');
    return;
  }

  console.log(`[Bot] Using settings from source channel ${sessionData.sourceChannelId}: path=${channelSettings.path}`);

  // Verify the thread is in the expected forum channel
  const parentChannel = message.channel.parent;
  if (!parentChannel) {
    console.log(`[Bot] ❌ Thread ${message.channel.id} has no parent channel`);
    await message.reply('⚠️ Error: thread has no parent channel.');
    return;
  }

  console.log(`[Bot] Thread parent channel: ${parentChannel.id}, Expected forum channel: ${channelSettings.forumChannelId}`);

  if (channelSettings.forumChannelId && parentChannel.id !== channelSettings.forumChannelId) {
    console.log(`[Bot] ❌ Thread parent ${parentChannel.id} does not match expected forum channel ${channelSettings.forumChannelId}`);
    await message.reply('⚠️ This thread is not in the correct forum channel.');
    return;
  }

  console.log(`[Bot] ✅ Thread is in the correct forum channel`);

  // Extract the prompt (remove bot mention)
  const prompt = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!prompt) {
    await message.reply('Please provide a prompt along with the mention.');
    return;
  }

  console.log(`[Bot] Continuing session ${sessionData.sessionId} in thread ${message.channel.id} with prompt: ${prompt}`);

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

    let statusMessage = await message.reply({ embeds: [initialEmbed] });

    // Execute the prompt with the existing session ID
    await executeClaudePrompt(
      prompt,
      async (agentMessage: AgentMessage) => {
        try {
          if (agentMessage.type === 'status') {
            // Update status if it changed
            if (agentMessage.content !== lastStatus) {
              lastStatus = agentMessage.content;
              const duration = ((Date.now() - startTime) / 1000).toFixed(1);
              const statusEmbed = new EmbedBuilder()
                .setColor(0x3498db) // Blue
                .setTitle(agentMessage.content)
                .setDescription('Processing your request...')
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
            const embed = createResultEmbed(prompt, agentMessage.content, duration);
            const commitButton = agentMessage.sessionId ? createCommitButton(agentMessage.sessionId, agentMessage.vcsType) : undefined;
            const components = commitButton ? [commitButton] : [];
            await statusMessage.edit({ embeds: [embed], components });
          } else if (agentMessage.type === 'error') {
            // Error occurred - use embed
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);
            const embed = createErrorEmbed(prompt, agentMessage.content, duration);
            const commitButton = agentMessage.sessionId ? createCommitButton(agentMessage.sessionId, agentMessage.vcsType) : undefined;
            const components = commitButton ? [commitButton] : [];
            await statusMessage.edit({ embeds: [embed], components });
          }
        } catch (discordError) {
          // Handle Discord API errors (rate limits, etc.)
          console.error('Failed to update Discord message:', discordError);
        }
      },
      channelSettings.path,
      channelSettings,
      sessionData.sessionId // Pass the session ID to resume
    );

    // If no result was sent, ensure we have a completion message
    if (!hasResult) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      const embed = createResultEmbed(prompt, 'Task completed.', duration);
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
        duration
      );
      await message.reply({ embeds: [embed] });
    } catch (discordError) {
      console.error('Failed to send error message to Discord:', discordError);
    }
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
