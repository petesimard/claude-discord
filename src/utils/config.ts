import { config as dotenvConfig } from 'dotenv';

// Load environment variables from .env file
dotenvConfig();

export interface Config {
  discordToken: string;
  workingPath: string;
  anthropicApiKey: string;
  allowedChannelId?: string;
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

export function loadConfig(): Config {
  const allowedChannelId = process.env.ALLOWED_CHANNEL_ID?.trim();

  return {
    discordToken: validateEnvVar('DISCORD_TOKEN', process.env.DISCORD_TOKEN),
    workingPath: validateEnvVar('WORKING_DIR', process.env.WORKING_DIR),
    anthropicApiKey: validateEnvVar('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY),
    allowedChannelId: allowedChannelId || undefined,
  };
}

export const config = loadConfig();
