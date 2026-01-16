import { REST, Routes, Events } from 'discord.js';
import { config } from './utils/config.js';
import { startBot, client } from './bot.js';
import { claudeCommand, claudeContinueCommand, claudeQuickCommand } from './commands/claude.js';

/**
 * Register slash commands with Discord
 */
async function registerCommands(): Promise<void> {
  const commands = [
    claudeCommand.toJSON(),
    claudeContinueCommand.toJSON(),
    claudeQuickCommand.toJSON()
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
    console.log(`  🔑 Discord token: ${config.discordToken.substring(0, 10)}...`);
    if (config.anthropicApiKey) {
      console.log(`  🔑 Anthropic API key: ${config.anthropicApiKey.substring(0, 16)}...`);
      console.log(`  📦 Mode: Agent SDK`);
    } else {
      console.log(`  🔑 Anthropic API key: Not set (using Claude CLI)`);
      console.log(`  📦 Mode: Claude Code CLI`);
    }
    console.log(`  🗺️  Channel mappings (${config.channelMappings.size} channel${config.channelMappings.size === 1 ? '' : 's'}):`);
    for (const [channelId, settings] of config.channelMappings.entries()) {
      console.log(`     ${channelId} → ${settings.path}`);
    }
    console.log('');

    // Start the bot
    await startBot();

    // Wait for the client to be ready before registering commands
    await new Promise<void>((resolve) => {
      client.once(Events.ClientReady, () => resolve());
    });

    // Register slash commands
    await registerCommands();

    console.log('');
    console.log('✅ Bot is fully initialized and ready to use!');
    console.log('💬 Commands:');
    console.log('   /claude [prompt] - Start a new conversation');
    console.log('   /claude-continue [session-id] [prompt] - Continue a previous conversation');
    console.log('   /claude-quick [prompt] - Quick execution in main channel (no worktree/thread)');
  } catch (error) {
    console.error('❌ Failed to start bot:', error);
    process.exit(1);
  }
}

// Start the bot
main();
