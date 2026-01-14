# Claude Discord Bot

A Discord bot that integrates with Claude Code, allowing you to interact with an autonomous AI agent directly from Discord. The bot supports slash commands with session-based conversation continuity.

## Features

- 🤖 Execute Claude Code prompts via `/claude` slash command
- 💬 **Forum-based sessions** - Each conversation gets its own forum thread for organization
- ✅ **Smart Git commit buttons** - Auto-detects Git repositories and shows commit button
- 🔗 Session-based conversation context - continue conversations by @mentioning the bot in forum threads
- 📊 **Live status embeds** - Watch the agent work in real-time with dynamic status updates and full activity log
- 📥 **Request queue** - Multiple @ mentions are automatically queued and processed sequentially with cancel buttons
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

#### Quick Execution (No Worktree/Thread)

For quick tasks that don't need isolation or conversation continuity, use `/claude-quick`:

```
/claude-quick [prompt]
```

This command:
- ✅ Executes directly in the current channel
- ✅ Uses the main repository (no worktree created)
- ✅ No forum thread created
- ✅ Faster for simple one-off tasks
- ❌ Cannot continue the conversation with @mentions
- ❌ No session isolation

**When to use `/claude-quick`:**
- Quick information queries
- Single-file edits
- Simple read-only operations
- When you don't need conversation history

**When to use `/claude`:**
- Multi-step tasks
- Feature development
- When you need to continue the conversation
- When you want isolated worktrees

**Examples:**

```
/claude-quick what's the structure of this codebase?
/claude-quick read config.ts and tell me what settings are available
/claude-quick fix the typo in README.md line 45
```

#### Continuing a Conversation - @Mention the Bot in the Forum Thread

When forum channels are configured, each conversation gets its own dedicated forum thread. To continue a conversation:

1. Navigate to the forum thread created for your session
2. @mention the bot along with your follow-up prompt
3. The bot will respond in the same thread, maintaining context

**Example:**

```
@ClaudeBot now find all places that call it
```

**Without Forum Channels:**

If no forum channel is configured, the bot works in regular text channels. You can use the `/claude-continue` command:

```
/claude-continue abc123def456 now find all places that call it
```

#### Committing Changes (Git)

Each response includes a commit button **if Git is detected** in your working directory:
- **"✅ Commit to Git"** - If `.git` directory is found
- **No button** - If Git is not detected

Click the button to commit all changes with an auto-generated message:

1. Click the **"✅ Commit to Git"** button on any response
2. The bot automatically commits all changes

The bot will:
- Check for uncommitted changes with `git status`
- Generate a commit message based on the changes (e.g., "Auto-commit: 3 files modified, 1 file added")
- Run `git add -A` to stage all changes
- Commit with the auto-generated message
- Add "Co-Authored-By: Claude Sonnet 4.5" to the commit

### How It Works

**With Forum Channels (Recommended):**

1. **Slash Command**: Run `/claude [prompt]` in a configured channel
2. **Forum Thread Created**: Bot creates a dedicated forum thread for this session
3. **Initial Response**: Bot posts a **blue embed** in the thread with "⏳ Starting Claude Code agent..."
4. **Working Status**: Embed updates in real-time showing:
   - Current tool being used (e.g., "🔄 Working... (using Read tool)")
   - Live execution time counter
   - Your original prompt
5. **Completion**: Embed changes to **green** with final results:
   - ✅ Green color-coded success message
   - Formatted result output (with code blocks for multi-line responses)
   - Execution duration
   - **✅ "Commit to Git" button** (if Git is detected)
   - Timestamp
6. **Continue Conversation**: @mention the bot in the thread with your next prompt
7. **Session Persistence**: The forum thread maintains the full conversation history

**Without Forum Channels:**

1. **Initial Response**: Bot displays embed directly in the channel
2. **Working Status** and **Completion**: Same as above
3. **Continue**: Use `/claude-continue [session-id] [prompt]` command

### Session Management

Each conversation with Claude Code has its own **session**:

- **Fresh Start**: Every `/claude` command starts a new conversation with no memory of previous interactions
- **Forum Threads**: When configured, each session gets its own forum thread for organization
- **Continue via @Mention**: In forum threads, @mention the bot to continue the conversation
- **Session Persistence**: Sessions are automatically saved to `.discord-sessions.json` and restored when the bot restarts
- **Thread Mapping**: Each forum thread is linked to a specific Claude Code session
- **Worktree Info**: Session data includes worktree paths and branches, so conversations continue in the correct worktree after restarts

**Example (with Forum Channel):**

```
User: /claude read the auth.py file
Bot: ✅ Session thread created: #session-abc123
     (In the forum thread)
     ✅ Task Completed
     I've read the authentication module...
     [✅ Commit to Git] (button)

User: (In the thread) @ClaudeBot now find all places that call it
Bot: ✅ Task Completed
     I found 5 places that call the auth module...
     (The agent remembers what "it" refers to from the previous message)
     [✅ Commit to Git] (button)

User: (Clicks Commit to Git)
Bot: ✅ Changes Committed to Git
     [main abc123d] Auto-commit: 5 files modified
     💬 Commit Message: Auto-commit: 5 files modified
     [✅ Commit to Git] (button)
```

### Request Queue

When you @mention the bot while it's already processing another request, your new request is automatically queued:

**How it works:**

1. **First Request**: The bot starts processing immediately
2. **Second Request** (while first is processing): Shows "⏳ Request Queued" with:
   - Queue position (e.g., "1 of 1")
   - Cancel button to remove from queue
3. **Automatic Processing**: When the current request finishes, the next queued request starts automatically
4. **FIFO Order**: Requests are processed in the order they were received

**Example:**

```
User: @ClaudeBot read the database.py file
Bot: 🤖 Claude Code Agent Working...
     • Let me read the file first...
     • 🔄 Working... (using Read tool)

User: @ClaudeBot also check the models.py file  ← (while still processing)
Bot: ⏳ Request Queued
     Your request is in the queue and will be processed when the current request completes.
     📝 Prompt: also check the models.py file
     📊 Queue Position: 1 of 1
     [❌ Cancel Request] (button)

(First request completes)

Bot: ✅ Task Completed
     I've read database.py and found...
     [✅ Commit to Git] (button)

(Automatically starts second request)

Bot: 🤖 Claude Code Agent Working...
     • Let me read the models.py file...
```

**Canceling Queued Requests:**

Click the "❌ Cancel Request" button on a queued request to remove it from the queue. Note: You can only cancel requests that haven't started processing yet.

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
- `autoUpdate`: (Optional) Automatically run `git pull` before starting new conversations (default: `false`)
- `forumChannelId`: (Optional) Forum channel ID where session threads will be created. Get this by right-clicking a forum channel and selecting "Copy ID"
- `workTreeBase`: (Optional) Base directory for creating Git worktrees (see Git Worktrees section below)
- `branchUrl`: (Optional) URL template for branch preview links. Use `[branchId]` as a placeholder that will be replaced with the actual branch ID. Example: `"https://[branchId].preview.mysite.com"`

**Example Configuration:**

```env
# Single channel
CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/my-project"}}

# Channel with auto-update enabled
CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/my-project","autoUpdate":true}}

# Channel with worktrees enabled for parallel conversations
CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/my-project","workTreeBase":"../"}}

# Channel with worktrees and branch preview URLs
CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/my-project","workTreeBase":"../","branchUrl":"https://[branchId].preview.mysite.com"}}

# Full example with all features: forum threads, auto-update, worktrees, and branch URLs
CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/web-app","autoUpdate":true,"forumChannelId":"9999999999","workTreeBase":"../","branchUrl":"https://[branchId].example.com"},"9876543210":{"path":"/home/user/api-server","autoUpdate":false},"5555555555":{"path":"/home/user/mobile-app"}}
```

**Behavior:**

- The bot only responds in channels that are configured in the mappings
- Each channel operates independently with its own working directory
- Git detection happens per directory
- When `forumChannelId` is configured:
  - Each `/claude` command creates a new forum thread in the specified forum channel
  - Sessions are tied to forum threads for better organization
  - Continue conversations by @mentioning the bot in the thread
- When `autoUpdate` is enabled:
  - The repository is updated automatically before **new** conversations (not when continuing existing conversations)
  - Runs `git pull` on the repository
  - Shows status updates in Discord ("🔄 Updating repository..." → "✅ Repository updated")
  - If update fails, shows a warning but continues with the conversation
- When `workTreeBase` is configured:
  - Each **new** conversation creates a separate Git worktree with its own branch
  - Allows multiple parallel conversations without conflicts
  - Set to `"../"` to create worktrees in the parent directory of your project
  - Or specify an absolute path like `"/tmp/worktrees"`
  - Repository folder names are slugified (special characters replaced with hyphens)
  - Each worktree is named `<slugified-repo-name>-<session-id>` (e.g., `outwar.com` → `outwar-com-abc123`)
  - Each worktree gets a unique branch `worktree/<slugified-repo-name>-<session-id>` based on your current branch
  - When continuing a conversation (via @mention), the original worktree is reused
  - Old worktrees (>24 hours) and their branches are automatically cleaned up
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

### Git Worktrees

Git worktrees allow you to have multiple working directories for the same repository, enabling parallel conversations without conflicts.

**Why use worktrees?**

- **Parallel conversations**: Multiple users can work on different features simultaneously
- **No conflicts**: Each conversation has its own isolated working directory
- **Clean history**: Changes in one conversation don't affect others
- **Easy cleanup**: Old worktrees are automatically removed after 24 hours

**How it works:**

1. When you start a new `/claude` conversation with `workTreeBase` configured, the bot:
   - Creates a new Git worktree in the specified base directory
   - Slugifies the repository folder name (replaces special characters with hyphens)
   - Names the worktree `<slugified-repo-name>-<session-id>` (e.g., `outwar.com` → `outwar-com-abc123`)
   - Creates a new branch `worktree/<slugified-repo-name>-<session-id>` based on your current branch
   - Uses that worktree as the working directory for the entire conversation

2. When you continue the conversation (via @mention in a forum thread):
   - The bot reuses the original worktree for that session
   - All changes remain in that worktree and branch

3. After 24 hours of inactivity:
   - Old worktrees are automatically cleaned up
   - Associated branches are also deleted
   - The main repository is unaffected

**Configuration:**

```env
# Create worktrees in the parent directory
CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/my-project","workTreeBase":"../"}}

# Create worktrees in a specific directory
CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/my-project","workTreeBase":"/tmp/claude-worktrees"}}
```

**Note:** The `path` setting still points to your main Git repository. The worktrees are created from this repository.

### Branch Preview URLs

When using worktrees, you can configure branch preview URLs to automatically generate clickable links to preview deployments or environments for each worktree branch.

**How it works:**

1. Set the `branchUrl` parameter in your channel settings with a URL template
2. Use `[branchId]` as a placeholder in the URL
3. The bot will replace `[branchId]` with the actual branch ID from the worktree
4. A clickable "Branch URL" field will appear in all response embeds when working in a worktree

**Branch ID Format:**

The branch ID is the full worktree directory name. Repository folder names are automatically slugified (special characters replaced with hyphens). For example:
- Repository: `/home/user/outwar.com`
- Slugified: `outwar-com`
- Session ID: `1768240643512-q3om9o`
- Worktree directory: `/home/outwar-worktrees/outwar-com-1768240643512-q3om9o`
- Branch ID (used in URL): `outwar-com-1768240643512-q3om9o`

This full directory name is then substituted for `[branchId]` in your URL template.

**Example Configurations:**

```env
# Subdomain-based preview (e.g., Vercel, Netlify)
CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/my-app","workTreeBase":"../","branchUrl":"https://[branchId].preview.myapp.com"}}

# Path-based preview
CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/my-app","workTreeBase":"../","branchUrl":"https://preview.myapp.com/[branchId]"}}

# Custom domain with port
CHANNEL_MAPPINGS={"1234567890":{"path":"/home/user/my-app","workTreeBase":"../","branchUrl":"http://[branchId].dev.internal:3000"}}
```

**Result:**

When a worktree is created for repository `outwar.com` with session ID `1768240643512-q3om9o`, and your `branchUrl` is set to `"https://[branchId].preview.myapp.com"`, the embed will show:

```
🔗 Branch URL: https://outwar-com-1768240643512-q3om9o.preview.myapp.com
```

The full worktree directory name (`outwar-com-1768240643512-q3om9o`) replaces `[branchId]` in the template. This link appears in all task completion and error embeds, making it easy to access preview deployments directly from Discord.

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
│   ├── bot.ts                # Discord client setup and event handlers
│   ├── commands/
│   │   └── claude.ts         # /claude command handler
│   ├── agent/
│   │   ├── manager.ts        # Agent SDK integration
│   │   └── sessions.ts       # Session management (thread → session mapping)
│   └── utils/
│       ├── config.ts         # Environment config loader
│       ├── vcs.ts            # Git detection utilities
│       └── worktree.ts       # Git worktree management
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
