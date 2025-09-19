# Decision Bot

A Slack bot that automatically manages decisions from thread discussions using AI and integrates with a Notion database. The bot can create, update, delete, and summarize decisions based on natural language commands.

## How It Works

1. **Someone tags the bot** in a Slack thread with their intent
2. **Bot analyzes the message** to determine what action to take (create, update, delete, or summarize)
3. **Bot processes the thread** and reads all messages in the conversation
4. **Bot uses AI** to extract information, make comparisons, or generate summaries
5. **Bot performs the requested action** (saves to Notion, updates existing decisions, deletes decisions, or provides summaries)

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

The bot supports four main actions based on natural language commands:

### 1. Create Decision
Tag the bot and mention a decision that was made:
```
@your-bot-name We decided to use React for the frontend
@your-bot-name Decision: We're going with microservices architecture
```

### 2. Update Decision
Tag the bot to update an existing decision:
```
@your-bot-name Update the React decision - we're now using Next.js instead
@your-bot-name The microservices decision needs updating
```

### 3. Delete Decision
Tag the bot to remove a decision from the database:
```
@your-bot-name Delete the React decision
@your-bot-name Remove the microservices architecture decision
```

**Note**: Delete operations require confirmation. The bot will:
1. Find the decision you want to delete
2. Show you the decision details
3. Ask for confirmation (reply with "yes" to confirm or "no" to cancel)

### 4. Summarize Thread
Tag the bot to get a summary of the discussion:
```
@your-bot-name Can you summarize this thread?
@your-bot-name What was decided in this discussion?
@your-bot-name Give me a recap of this conversation
```

The bot will:
- Analyze your message to determine the intended action
- Read the entire thread conversation
- Use AI to process the request appropriately
- Provide feedback and confirmation in the thread

### Example Summary Output

When you request a thread summary, the bot will provide a structured response like this:

```
📋 Thread Summary

Overview: The team discussed the new authentication system architecture and made some key decisions while leaving several technical details open for future discussion.

Open Points:
1. Whether to use OAuth 2.0 or SAML for enterprise customers
2. How to handle session management across microservices
3. Database sharding strategy for user data

Decisions Made:
1. Use JWT tokens for API authentication
2. Implement multi-factor authentication by Q2
3. Migrate to new system by end of year

Next Steps:
1. Research OAuth vs SAML implementation costs
2. Schedule architecture review meeting
3. Create migration timeline

View original thread
```

## Features

### Core Functionality
- **Natural Language Processing**: Understands user intent from natural language commands
- **Decision Management**: Full CRUD operations for decisions (Create, Read, Update, Delete)
- **Thread Summarization**: Comprehensive analysis of discussion threads
- **AI-Powered Analysis**: Uses OpenAI's GPT-5-mini for intelligent processing

### Decision Operations
- **Create**: Automatically extracts and logs new decisions with title, summary, and tags
- **Update**: Finds and updates existing decisions based on thread context
- **Delete**: Safely removes decisions with confirmation prompts
- **Read**: Finds and displays related decisions from the database

### Thread Analysis
- **Comprehensive Summaries**: Generates structured summaries with:
  - Overview of the discussion
  - Open points (topics discussed but not decided)
  - Decisions made (concrete conclusions reached)
  - Next steps (action items and follow-ups)
- **Confidence Scoring**: Provides confidence levels for summary accuracy
- **Smart Categorization**: Automatically generates relevant tags for decisions

### Integration Features
- **Slack Integration**: Seamless interaction through Slack mentions and threads
- **Notion Database**: Automatic synchronization with Notion for decision storage
- **Thread Context**: Reads entire conversation threads for complete context
- **Error Handling**: Robust error handling with user-friendly feedback

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
