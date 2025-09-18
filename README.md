# Decision Bot

A Slack bot that automatically extracts and logs decisions from thread discussions using AI to a Notion database.

## How It Works

1. **Someone tags the bot** in a Slack thread
2. **Bot gets the thread** and reads all messages in the conversation
3. **Bot summarizes using ChatGPT** to extract the key decision with title, summary, and tag
4. **Bot saves the decision to a Notion database** with all relevant information

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Create a `.env` file with:

```env
# OpenAI API Key (via OpenRouter)
OPENROUTER_API_KEY=your-openrouter-api-key
DOMAIN=your-domain

# Slack Bot Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_USER_TOKEN=xoxp-your-user-token  # Optional, for reading threads in channels
SLACK_SIGNING_SECRET=your-signing-secret

# Notion Configuration
NOTION_SECRET=your-notion-integration-token
NOTION_DATABASE_ID=your-notion-database-id

# Server Port (optional)
PORT=3000
```

### 3. Slack App Configuration

In your Slack app settings:

**Event Subscriptions:**

- Request URL: `https://your-domain.com/slack/events`
- Subscribe to bot events: `app_mention`

**OAuth & Permissions:**

- Bot Token Scopes:
  - `app_mentions:read`
  - `channels:history`
  - `channels:read`
  - `chat:write`

**Optional User Token Scopes** (for reading threads in channels):

- `channels:history`
- `groups:history`

### 4. Notion Database Setup

Create a Notion database with the following properties:

- **title** (Title) - The decision title
- **summary** (Rich Text) - The decision summary
- **tag** (Rich Text) - The decision category/tag
- **slack_thread** (Rich Text) - The Slack thread timestamp
- **slack_channel** (Rich Text) - The Slack channel ID
- **date_timestamp** (Date) - When the decision was made

Copy the database ID from the Notion URL and add it to your `.env` file as `NOTION_DATABASE_ID`.

### 5. Run the Bot

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

## Usage

1. Start a discussion in any Slack channel
2. Tag your bot: `@your-bot-name`
3. The bot will:
   - Read the entire thread
   - Use AI to extract the decision with title, summary, and tag
   - Save the decision to your Notion database
   - Confirm in the thread with success/failure status

## Features

- Monitors Slack channels for app mentions
- Extracts decision summaries using OpenAI's GPT-4o-mini
- Generates descriptive tags for decision categorization
- Saves decisions to Notion database with full context
- Handles thread conversations and individual messages

## Project Structure

```
src/
├── types/           # TypeScript type definitions
│   └── index.ts
├── services/        # Business logic services
│   ├── slackService.ts    # Slack API interactions
│   └── notionService.ts   # Notion database operations
├── middleware/      # Express middleware
│   └── slackVerification.ts  # Slack signature verification
├── routes/          # Express route handlers
│   ├── health.ts    # Health check endpoint
│   └── slackEvents.ts  # Slack events processing
├── utils/           # Utility functions
│   └── stringUtils.ts
├── llm.ts          # OpenAI integration
└── server.ts       # Main application entry point
```

## API Endpoints

- `POST /slack/events` - Slack event webhook handler
