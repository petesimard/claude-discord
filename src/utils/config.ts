import { config as dotenvConfig } from 'dotenv';

// Load environment variables from .env file
dotenvConfig();

export interface Config {
  discordToken: string;
  workingPath: string;
  anthropicApiKey: string;
  allowedChannelId?: string;
  channelMappings: Map<string, string>;
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

function parseChannelMappings(mappingsJson?: string): Map<string, string> {
  const mappings = new Map<string, string>();

  if (!mappingsJson || !mappingsJson.trim()) {
    return mappings;
  }

  try {
    const parsed = JSON.parse(mappingsJson);
    if (typeof parsed === 'object' && parsed !== null) {
      for (const [channelId, path] of Object.entries(parsed)) {
        if (typeof path === 'string') {
          mappings.set(channelId, path);
        }
      }
    }
  } catch (error) {
    console.warn('Failed to parse CHANNEL_MAPPINGS, ignoring:', error);
  }

  return mappings;
}

export function loadConfig(): Config {
  const allowedChannelId = process.env.ALLOWED_CHANNEL_ID?.trim();
  const channelMappings = parseChannelMappings(process.env.CHANNEL_MAPPINGS);

  return {
    discordToken: validateEnvVar('DISCORD_TOKEN', process.env.DISCORD_TOKEN),
    workingPath: validateEnvVar('WORKING_DIR', process.env.WORKING_DIR),
    anthropicApiKey: validateEnvVar('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY),
    allowedChannelId: allowedChannelId || undefined,
    channelMappings,
  };
}

/**
 * Get the working path for a specific channel
 * Falls back to default working path if no mapping exists
 */
export function getWorkingPathForChannel(channelId: string): string {
  const mapping = config.channelMappings.get(channelId);
  return mapping || config.workingPath;
}

/**
 * Check if a channel is allowed to use the bot
 * - If CHANNEL_MAPPINGS is set, only mapped channels are allowed
 * - Otherwise, if ALLOWED_CHANNEL_ID is set, only that channel is allowed
 * - Otherwise, all channels are allowed
 */
export function isChannelAllowed(channelId: string): boolean {
  // If channel mappings are configured, restrict to only mapped channels
  if (config.channelMappings.size > 0) {
    return config.channelMappings.has(channelId);
  }

  // Otherwise, use ALLOWED_CHANNEL_ID if set
  if (config.allowedChannelId) {
    return channelId === config.allowedChannelId;
  }

  // No restrictions - allow all channels
  return true;
}

export const config = loadConfig();
