# Claude Discord Bot

A Discord bot that integrates with Claude Code, allowing you to interact with an autonomous AI agent directly from Discord. The bot supports slash commands with session-based conversation continuity.

## Features

- 🤖 Execute Claude Code prompts via `/claude` slash command
- 💬 **Interactive "Continue Conversation" buttons** - Click to continue any conversation with a modal popup
- ✅ **Smart VCS commit buttons** - Auto-detects Git or SVN and shows the appropriate commit button
- 🔗 Session-based conversation context - continue any conversation from any channel
- 📊 **Live status embeds** - Watch the agent work in real-time with dynamic status updates
- 🛠️ Full access to Claude Code tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch)
- ⚡ Streaming responses with automatic embed updates
- 🎨 Rich Discord embeds with color-coded results (blue while working, green on success, red on error)
- ⏱️ Live execution time tracking
- 🔒 Secure configuration via environment variables
- 🗺️ **Channel-to-directory mappings** - Different channels work on different projects
- 📨 **Welcome messages** - Bot sends instructions to allowed channels when it connects
- 🚪 Optional channel restriction (limit bot to specific channels)

## Prerequisites

Before you begin, you'll need:

1. **Node.js 18 or higher** - [Download here](https://nodejs.org/)
2. **Claude Code CLI** - Required by the Agent SDK
3. **Discord Bot Token** - From Discord Developer Portal
4. **Anthropic API Key** - From Anthropic Console
5. **SVN (Subversion)** - Optional, only needed if you want to use the "Commit to SVN" button

### Installing Claude Code

The Agent SDK requires Claude Code as its runtime. Install it using one of these methods:

```bash
# macOS/Linux/WSL
curl -fsSL https://claude.ai/install.sh | bash

# Homebrew
brew install --cask claude-code

# npm
npm install -g @anthropic-ai/claude-code
```

See [Claude Code setup](https://code.claude.com/docs/en/setup) for Windows and other options.

## Setup

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name
3. Go to the "Bot" section and click "Add Bot"
4. Under "Token", click "Copy" to get your bot token
5. Enable these Privileged Gateway Intents:
   - Server Members Intent (optional)
   - Message Content Intent (optional)

### 2. Invite the Bot to Your Server

1. In the Developer Portal, go to "OAuth2" > "URL Generator"
2. Select these scopes:
   - `bot`
   - `applications.commands`
3. Select these bot permissions:
   - Send Messages
   - Use Slash Commands
4. Copy the generated URL and open it in your browser
5. Select your server and authorize the bot

### 3. Get an Anthropic API Key

1. Go to the [Anthropic Console](https://console.anthropic.com/)
2. Sign in or create an account
3. Navigate to "API Keys"
4. Create a new API key and copy it

### 4. Configure the Bot

1. Clone this repository:
   ```bash
   git clone <your-repo-url>
   cd claude-discord
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file from the example:
   ```bash
   cp .env.example .env
   ```

4. Edit `.env` and fill in your credentials:
   ```env
   DISCORD_TOKEN=your_discord_bot_token_here
   ANTHROPIC_API_KEY=your_anthropic_api_key_here
   CHANNEL_MAPPINGS={"1234567890123456789":{"path":"/path/to/project1"},"9876543210987654321":{"path":"/path/to/project2"}}
   ```

   - `DISCORD_TOKEN`: Your Discord bot token from step 1
   - `ANTHROPIC_API_KEY`: Your Anthropic API key from step 3
   - `CHANNEL_MAPPINGS`: **(Required)** JSON mapping of Discord channel IDs to their settings - see below

## Usage

### Development Mode

Run the bot in development mode with hot reloading:

```bash
npm run dev
```

### Production Mode

Build and run in production:

```bash
# Build TypeScript to JavaScript
npm run build

# Start the bot
npm start
```

### Using the Bot in Discord

The bot provides two slash commands for interacting with Claude Code:

#### `/claude [prompt]` - Start a New Conversation

Each `/claude` command starts a **fresh conversation** with no memory of previous interactions.

1. Type `/claude` in any channel
2. Enter your prompt in the `prompt` field
3. Press Enter

**Examples:**

```
/claude list all files in this directory
/claude create a README.md file for a web app
/claude find all TODO comments in the codebase
/claude run the tests and fix any failures
```

#### Continuing a Conversation - Click the "Continue Conversation" Button

Each response includes a **"💬 Continue Conversation"** button at the bottom. Click it to continue that specific conversation:

1. Click the **"💬 Continue Conversation"** button on any previous response
2. A text box will pop up
3. Enter your follow-up prompt
4. Click Submit

**Alternative: Manual `/claude-continue` Command**

You can also continue conversations manually using the session ID:

```
/claude-continue abc123def456 now find all places that call it
```

#### Committing Changes (Git or SVN)

Each response includes a commit button **if Git or SVN is detected** in your working directory. The button label changes based on what's detected:
- **"✅ Commit to Git"** - If `.git` directory is found
- **"✅ Commit to SVN"** - If `.svn` directory is found
- **No button** - If neither is detected

Click the button to commit all changes with an auto-generated message:

1. Click the **"✅ Commit to Git/SVN"** button on any response
2. The bot automatically commits all changes

**For Git**, the bot will:
- Check for uncommitted changes with `git status`
- Generate a commit message based on the changes (e.g., "Auto-commit: 3 files modified, 1 file added")
- Run `git add -A` to stage all changes
- Commit with the auto-generated message
- Add "Co-Authored-By: Claude Sonnet 4.5" to the commit

**For SVN**, the bot will:
- Check for uncommitted changes with `svn status`
- Generate a commit message based on the changes
- Commit all changes with `svn commit`
- Display the SVN output and confirmation

### How It Works

1. **Initial Response**: Bot displays a **blue embed** with "⏳ Starting Claude Code agent..." or "⏳ Resuming Claude Code session..." showing your prompt
2. **Working Status**: Embed updates in real-time showing:
   - Current tool being used (e.g., "🔄 Working... (using Read tool)")
   - Live execution time counter
   - Your original prompt
3. **Completion**: Embed changes to **green** with final results:
   - ✅ Green color-coded success message
   - Formatted result output (with code blocks for multi-line responses)
   - Original prompt for reference
   - Execution duration
   - **💬 "Continue Conversation" button** for easy follow-ups
   - **✅ "Commit to SVN" button** to commit any changes made
   - Timestamp
4. **Error Handling**: Rich embed with:
   - ❌ Red color-coded error message
   - Detailed error information
   - Original prompt for context
   - Execution duration
   - **💬 "Continue Conversation" button** (if session is available)
   - **✅ "Commit to SVN" button** to commit any changes made (if session is available)

### Session Management

Each conversation with Claude Code has its own **session**:

- **Fresh Start**: Every `/claude` command starts a new conversation with no memory of previous interactions
- **Continue Sessions**: Use `/claude-continue [session-id] [prompt]` to continue a specific conversation
- **Easy Continuation**: Click the "💬 Continue Conversation" button on any response to continue that conversation
- **Session Persistence**: Sessions persist until the bot restarts
- **Cross-Channel**: Sessions work across any channel - you can continue a conversation started in one channel from another channel

**Example:**

```
User: /claude read the auth.py file
Bot: ✅ Task Completed
     I've read the authentication module...
     [💬 Continue Conversation] [✅ Commit to SVN] (buttons)

User: (Clicks Continue Conversation, types:) "now find all places that call it"
Bot: ✅ Task Completed
     I found 5 places that call the auth module...
     (The agent remembers what "it" refers to from the previous message)
     [💬 Continue Conversation] [✅ Commit to SVN] (buttons)

User: (Clicks Commit to SVN)
Bot: ✅ Changes Committed to SVN
     Committed revision 1234.
     💬 Commit Message: Auto-commit: 5 files modified
     [💬 Continue Conversation] [✅ Commit to SVN] (buttons)
```

## Configuration Options

### Channel Mappings (CHANNEL_MAPPINGS) - Required

The `CHANNEL_MAPPINGS` environment variable is the core configuration for the bot. It maps Discord channels to their settings, including the working directory where Claude Code operates.

**⚠️ Important:** The bot will **ONLY respond in channels that are configured** in this mapping.

**Configuration:**

Set `CHANNEL_MAPPINGS` to a JSON object mapping channel IDs to settings objects:

```env
CHANNEL_MAPPINGS={"1234567890123456789":{"path":"/path/to/project1"},"9876543210987654321":{"path":"/path/to/project2"}}
```

**To get a channel ID:**

1. Enable Developer Mode in Discord:
   - User Settings → App Settings → Advanced → Enable "Developer Mode"
2. Right-click on a channel
3. Select "Copy ID"

**Settings Object:**

Each channel's settings object supports:
- `path`: (Required) The working directory for this channel where Claude Code will execute commands and access files
- `autoUpdate`: (Optional) Automatically run `git pull` or `svn update` before starting new conversations (default: `false`)

**Example Configuration:**

```env
# Single channel
CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/my-project"}}

# Channel with auto-update enabled
CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/my-project","autoUpdate":true}}

# Multiple channels with different projects and settings
CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/web-app","autoUpdate":true},"9876543210":{"path":"/home/user/api-server","autoUpdate":false},"5555555555":{"path":"/home/user/mobile-app"}}
```

**Behavior:**

- The bot only responds in channels that are configured in the mappings
- Each channel operates independently with its own working directory
- VCS detection (Git/SVN) happens per directory, so different channels can use different version control systems
- When `autoUpdate` is enabled:
  - The repository is updated automatically before **new** conversations (not when continuing existing conversations)
  - For Git: runs `git pull`
  - For SVN: runs `svn update`
  - Shows status updates in Discord ("🔄 Updating repository..." → "✅ Repository updated")
  - If update fails, shows a warning but continues with the conversation
- Additional settings can be added per channel (e.g., allowed tools, permissions, model selection)

**Startup logging:**

The bot will show configured mappings on startup:
```
🗺️  Channel mappings (2 channels):
   1234567890123456789 → /path/to/project1
   9876543210987654321 → /path/to/project2
```

### Permissions

The bot is configured with `permissionMode: "bypassPermissions"`, meaning:

- The agent can execute operations without approval
- Suitable for trusted environments
- If you need more control, modify `src/agent/manager.ts` to use different permission modes

### Allowed Tools

The bot has access to these Claude Code tools:

- **Read**: Read files
- **Write**: Create new files
- **Edit**: Modify existing files
- **Bash**: Run terminal commands
- **Glob**: Find files by pattern
- **Grep**: Search file contents
- **WebSearch**: Search the web
- **WebFetch**: Fetch web page content

To restrict tools, modify the `allowedTools` array in `src/agent/manager.ts`.


## Project Structure

```
claude-discord/
├── src/
│   ├── index.ts              # Main entry point, command registration
│   ├── bot.ts                # Discord client setup
│   ├── commands/
│   │   └── claude.ts         # /claude command handler
│   ├── agent/
│   │   ├── manager.ts        # Agent SDK integration
│   │   └── sessions.ts       # Session management
│   └── utils/
│       └── config.ts         # Environment config loader
├── dist/                     # Compiled JavaScript (after build)
├── .env                      # Environment variables (create this)
├── .env.example              # Environment template
├── package.json              # Dependencies and scripts
├── tsconfig.json             # TypeScript configuration
└── README.md                 # This file
```

## Troubleshooting

### Bot doesn't come online

- Check that your `DISCORD_TOKEN` is correct
- Ensure the token hasn't been regenerated in the Developer Portal
- Check the console for error messages

### "Missing required environment variable" error

- Make sure you've created a `.env` file (not just `.env.example`)
- Verify all three variables are set in `.env`
- Don't use quotes around the values in `.env`

### Commands don't appear in Discord

- Wait a few minutes for Discord to register global commands
- Try restarting the bot
- Ensure the bot has `applications.commands` scope

### Agent SDK errors

If the agent fails with "Claude Code process exited with code 1":

1. **Enable DEBUG mode** for detailed error output:
   - Add `DEBUG=1` to your `.env` file
   - Restart the bot
   - Try the command again and check the console logs

2. **Verify Claude Code is installed**: `claude --version`
3. **Check that your `ANTHROPIC_API_KEY` is valid**
4. **Ensure the configured directories exist and are accessible**

### "Credit balance is too low" or billing errors

If you see errors like "Credit balance is too low" or the bot says there's a billing error:

- Your Anthropic API account has insufficient credits
- Go to [Anthropic Console](https://console.anthropic.com/) and add credits to your account
- You can check your current balance in the Console under "Usage & Billing"
- New accounts may need to add payment information before making API calls

### Permission errors in working directory

- Ensure the bot process has read/write permissions for the `WORKING_DIR` directory
- Try using an absolute path instead of relative

## Development

### Type Checking

Run TypeScript type checking without building:

```bash
npm run type-check
```

### Project Dependencies

- **discord.js**: Discord API library
- **@anthropic-ai/claude-agent-sdk**: Claude Code Agent SDK
- **dotenv**: Environment variable loader

## Security Considerations

- **Never commit your `.env` file** - It contains sensitive tokens
- **Restrict bot permissions** - Only give it necessary Discord permissions
- **Control working directory access** - Limit what files the agent can access
- **Run in trusted environments** - The agent can execute code and commands
- **Monitor API usage** - The Anthropic API key has usage limits

## License

ISC

## Support

For issues with:
- **Discord.js**: [Discord.js Guide](https://discordjs.guide/)
- **Claude Agent SDK**: [Agent SDK Docs](https://platform.claude.com/docs/en/agent-sdk/overview)
- **This bot**: Create an issue in this repository

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
