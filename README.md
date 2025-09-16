# Decision Bot

A Slack bot that automatically extracts and logs decisions from thread discussions using AI.

## How It Works

1. **Someone tags the bot** in a Slack thread
2. **Bot gets the thread** and reads all messages in the conversation
3. **Bot summarizes using ChatGPT** to extract the key decision
4. **Bot posts results to a canvas** in the same Slack channel

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Environment Variables

Create a `.env` file with:

```env
# OpenAI API Key
OPENAI_API_KEY=sk-your-openai-api-key

# Slack Bot Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_USER_TOKEN=xoxp-your-user-token  # Optional, for reading threads in channels
SLACK_SIGNING_SECRET=your-signing-secret

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
  - `canvases:write`
  - `canvases:read`

**Optional User Token Scopes** (for reading threads in channels):

- `channels:history`
- `groups:history`

### 4. Run the Bot

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
   - Use AI to extract the decision
   - Create/update a "Channel Decisions" canvas
   - Add the decision to a table with title, summary, timestamp, and thread link
   - Confirm in the thread

## Features

- **AI-Powered**: Uses GPT-4o-mini to intelligently extract decisions
- **Thread Reading**: Captures full conversation context
- **Canvas Integration**: Creates organized decision logs in Slack canvases
- **Fallback Handling**: Works even if AI service is unavailable
- **TypeScript**: Fully typed for better development experience

## API Endpoints

- `POST /slack/events` - Slack event webhook handler
