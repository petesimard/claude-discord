import { config as dotenvConfig } from 'dotenv';

// Load environment variables from .env file
dotenvConfig();

export interface ChannelSettings {
  path: string;
  autoUpdate?: boolean; // Auto git pull before new conversations
  forumChannelId?: string; // Forum channel to create session threads in
}

export interface Config {
  discordToken: string;
  anthropicApiKey: string;
  channelMappings: Map<string, ChannelSettings>;
}

function validateEnvVar(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
      `Please check your .env file and ensure ${name} is set.`
    );
  }
  return value;
}

function parseChannelMappings(mappingsJson?: string): Map<string, ChannelSettings> {
  const mappings = new Map<string, ChannelSettings>();

  if (!mappingsJson || !mappingsJson.trim()) {
    return mappings;
  }

  try {
    const parsed = JSON.parse(mappingsJson);
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [channelId, settings] of Object.entries(parsed)) {
        if (typeof settings === 'object' && settings !== null && 'path' in settings) {
          const channelSettings = settings as { path: string; autoUpdate?: boolean; forumChannelId?: string | number };
          if (typeof channelSettings.path === 'string') {
            // Ensure forumChannelId is a string (Discord IDs must be strings to avoid truncation)
            let forumChannelId: string | undefined = undefined;
            if (channelSettings.forumChannelId !== undefined) {
              forumChannelId = String(channelSettings.forumChannelId);
              console.log(`[Config] Channel ${channelId}: forumChannelId = "${forumChannelId}" (type: ${typeof channelSettings.forumChannelId})`);
            }

            mappings.set(channelId, {
              path: channelSettings.path,
              autoUpdate: channelSettings.autoUpdate === true,
              forumChannelId: forumChannelId
            });
          }
        }
      }
    }
  } catch (error) {
    console.warn('Failed to parse CHANNEL_MAPPINGS, ignoring:', error);
  }

  return mappings;
}

export function loadConfig(): Config {
  const channelMappings = parseChannelMappings(process.env.CHANNEL_MAPPINGS);

  if (channelMappings.size === 0) {
    throw new Error(
      '\n' +
      '═══════════════════════════════════════════════════════════════════════\n' +
      '  ❌ ERROR: No channel mappings configured!\n' +
      '═══════════════════════════════════════════════════════════════════════\n' +
      '\n' +
      'The bot requires CHANNEL_MAPPINGS to be set in your .env file.\n' +
      '\n' +
      'How to configure:\n' +
      '  1. Get your Discord channel ID:\n' +
      '     • Enable Developer Mode in Discord (User Settings → Advanced)\n' +
      '     • Right-click on a channel and select "Copy ID"\n' +
      '\n' +
      '  2. Add to your .env file:\n' +
      '     CHANNEL_MAPPINGS={"YOUR_CHANNEL_ID":{"path":"/path/to/your/project"}}\n' +
      '\n' +
      'Example:\n' +
      '  CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/my-project"}}\n' +
      '\n' +
      'Multiple channels:\n' +
      '  CHANNEL_MAPPINGS={"123":{"path":"/project1"},"456":{"path":"/project2"}}\n' +
      '\n' +
      '═══════════════════════════════════════════════════════════════════════\n'
    );
  }

  return {
    discordToken: validateEnvVar('DISCORD_TOKEN', process.env.DISCORD_TOKEN),
    anthropicApiKey: validateEnvVar('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY),
    channelMappings,
  };
}

/**
 * Get the working path for a specific channel
 * Returns undefined if channel is not configured
 */
export function getWorkingPathForChannel(channelId: string): string | undefined {
  const settings = config.channelMappings.get(channelId);
  return settings?.path;
}

/**
 * Get the channel settings for a specific channel
 * Returns undefined if channel is not configured
 */
export function getChannelSettings(channelId: string): ChannelSettings | undefined {
  return config.channelMappings.get(channelId);
}

/**
 * Check if a channel is allowed to use the bot
 * Only channels in CHANNEL_MAPPINGS are allowed
 */
export function isChannelAllowed(channelId: string): boolean {
  return config.channelMappings.has(channelId);
}

/**
 * Get all configured channel IDs
 */
export function getAllowedChannelIds(): string[] {
  return Array.from(config.channelMappings.keys());
}

export const config = loadConfig();
