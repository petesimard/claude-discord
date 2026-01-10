import { REST, Routes } from 'discord.js';
import { config } from './utils/config.js';
import { startBot, client } from './bot.js';
import { claudeCommand, claudeContinueCommand } from './commands/claude.js';

/**
 * Register slash commands with Discord
 */
async function registerCommands(): Promise<void> {
  const commands = [
    claudeCommand.toJSON(),
    claudeContinueCommand.toJSON()
  ];

  const rest = new REST({ version: '10' }).setToken(config.discordToken);

  try {
    console.log('🔄 Registering slash commands...');

    // Get the client application ID
    const clientId = client.user?.id;
    if (!clientId) {
      throw new Error('Client not ready. Cannot register commands.');
    }

    // Register commands globally
    await rest.put(Routes.applicationCommands(clientId), {
      body: commands,
    });

    console.log('✅ Successfully registered slash commands');
  } catch (error) {
    console.error('❌ Failed to register slash commands:', error);
    throw error;
  }
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  console.log('🚀 Starting Claude Discord Bot...');
  console.log('');

  try {
    // Validate configuration
    console.log('Configuration:');
    console.log(`  📁 Working directory: ${config.workingPath}`);
    console.log(`  🔑 Discord token: ${config.discordToken.substring(0, 20)}...`);
    console.log(`  🔑 Anthropic API key: ${config.anthropicApiKey.substring(0, 20)}...`);
    if (config.allowedChannelId) {
      console.log(`  🔒 Allowed channel: ${config.allowedChannelId} (restricted)`);
    } else {
      console.log(`  🌐 Allowed channel: All channels`);
    }
    console.log('');

    // Start the bot
    await startBot();

    // Wait for the client to be ready before registering commands
    await new Promise<void>((resolve) => {
      client.once('ready', () => resolve());
    });

    // Register slash commands
    await registerCommands();

    console.log('');
    console.log('✅ Bot is fully initialized and ready to use!');
    console.log('💬 Commands:');
    console.log('   /claude [prompt] - Start a new conversation');
    console.log('   /claude-continue [session-id] [prompt] - Continue a previous conversation');
  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

// Start the bot
main();
