import { Request, Response } from "express";
import { SlackService } from "../services/slackService";
import { NotionService } from "../services/notionService";
import { SlackVerification } from "../middleware/slackVerification";
import { extractDecisionFromThread, compareDecisionWithExisting } from "../llm";
import {
  SlackRequestBody,
  ExtendedRequest,
  DecisionExtraction,
} from "../types";

/**
 * Slack events route handler
 */
export class SlackEventsHandler {
  private slackService: SlackService;
  private notionService: NotionService;
  private slackVerification: SlackVerification;

  constructor() {
    this.slackService = new SlackService();
    this.notionService = new NotionService();
    this.slackVerification = new SlackVerification();
  }

  /**
   * Handle Slack events endpoint
   * @param req - Express request object
   * @param res - Express response object
   */
  async handleEvents(req: ExtendedRequest, res: Response): Promise<void> {
    console.log("Received request to /slack/events");

    // Handle URL verification
    if (req.body?.type === "url_verification") {
      console.log("URL verification request:", req.body.challenge);
      res.send(req.body.challenge);
      return;
    }

    // Verify signature for other requests
    if (!this.slackVerification.verify(req)) {
      console.log("Signature verification failed");
      res.status(401).send("bad sig");
      return;
    }

    console.log("Signature verified, processing event");
    res.status(200).send(); // Acknowledge immediately

    // Process the event
    await this.processEvent(req.body as SlackRequestBody);
  }

  /**
   * Process Slack event
   * @param body - Slack request body
   */
  private async processEvent(body: SlackRequestBody): Promise<void> {
    const evt = body?.event;
    if (!evt || evt.type !== "app_mention") {
      return;
    }

    console.log("Processing app mention event:", evt);

    const channel = evt.channel;
    const thread_ts = evt.thread_ts ?? evt.ts;

    // Get channel information
    let channelName = channel;
    try {
      const channelInfo = await this.slackService.getChannelInfo(channel);
      if (channelInfo) {
        channelName = channelInfo.name;
        console.log("Channel info:", channelInfo);
      }
    } catch (error) {
      console.warn("Failed to get channel info, using channel ID:", error);
    }

    // Build thread URL
    const threadUrl = this.slackService.buildThreadUrl(
      channel,
      thread_ts,
      channelName
    );
    console.log("Thread URL:", threadUrl);

    // Test user token
    try {
      const resp = await this.slackService.apiCall(
        "auth.test",
        {},
        this.slackService.getUserToken()!
      );
      console.log("User token test:", resp);
    } catch (error) {
      console.error("User token test failed:", error);
    }

    // Get thread messages
    let threadText = evt.text;
    try {
      const replies = await this.slackService.formCall(
        "conversations.replies",
        { channel, ts: thread_ts }
      );
      threadText = replies.messages?.map((m) => m.text).join("\n") || evt.text;
      console.log("Successfully fetched thread messages");
    } catch (error) {
      console.warn(
        "Failed to fetch thread messages, using mention text only:",
        error
      );
      threadText = evt.text;
    }

    // Route based on message content
    const begin = threadText.indexOf(">") + 2;
    const messageText = threadText.toLowerCase().substring(begin, threadText.length).trim();
    console.log("Message text:", messageText);

    if (messageText.startsWith("create")) {
      await this.createNewDecision({
        channel,
        thread_ts,
        channelName,
        threadUrl,
        threadText,
      });
    } else if (messageText.startsWith("update")) {
      await this.updateDecision({
        channel,
        thread_ts,
        channelName,
        threadUrl,
        threadText,
      });
    } else if (messageText.startsWith("read")) {
      await this.fetchRelatedDecisions({
        channel,
        thread_ts,
        channelName,
        threadUrl,
        threadText,
      });
    } else {
      // Default to create behavior for backward compatibility
      await this.createNewDecision({
        channel,
        thread_ts,
        channelName,
        threadUrl,
        threadText,
      });
    }
  }

  /**
   * Create a new decision in the Notion database
   * @param params - Parameters for creating a new decision
   * @param params.channel - Slack channel ID
   * @param params.thread_ts - Slack thread timestamp
   * @param params.channelName - Slack channel name
   * @param params.threadUrl - Slack thread URL
   * @param params.threadText - Thread text content
   */
  private async createNewDecision({
    channel,
    thread_ts,
    channelName,
    threadUrl,
    threadText,
  }: {
    channel: string;
    thread_ts: string;
    channelName: string;
    threadUrl: string;
    threadText: string;
  }): Promise<void> {
    // Extract decision using LLM
    const result = await extractDecisionFromThread(threadText);

    if ("error" in result) {
      // Post confirmation message
      const message = `❌ Failed to log decision to Notion database: *${result.error}*`;

      await this.slackService.apiCall(
        "chat.postMessage",
        {
          channel,
          thread_ts,
          text: message,
        },
        this.slackService.getBotToken()!
      );
      return;
    }

    const { title, summary, tag } = result as DecisionExtraction;

    // Get all existing decisions from the database
    console.log("Retrieving existing decisions from Notion database...");
    const existingDecisions = await this.notionService.getAllDecisions();

    // Compare with existing decisions to see if this is a similar decision
    console.log("Comparing new decision with existing decisions...");
    const comparison = await compareDecisionWithExisting(
      result as DecisionExtraction,
      existingDecisions
    );

    let notionSuccess = false;
    let action = "";

    if (comparison.similar && comparison.existing_decision_id) {
      // Update existing decision
      console.log(
        `Similar decision found (similarity: ${comparison.similarity_score}%). Updating existing decision.`
      );
      action = "updated";

      const updateResult = await this.notionService.updateDecision(
        comparison.existing_decision_id,
        {
          title,
          summary,
          tag,
          slack_thread: threadUrl,
          slack_channel: channelName,
          date_timestamp: new Date().toISOString(),
        }
      );

      notionSuccess = updateResult.success;
    } else {
      // Add new decision
      console.log(
        "No similar decision found. Adding new decision to database."
      );
      action = "added";

      const addResult = await this.notionService.addDecision({
        title,
        summary,
        tag,
        slack_thread: threadUrl,
        slack_channel: channelName,
        date_timestamp: new Date().toISOString(),
      });

      notionSuccess = addResult.success;
    }

    // Post confirmation message
    const databaseUrl = this.notionService.getDatabaseUrl();
    const message = notionSuccess
      ? `✅ Decision ${action} in Notion database: *${title}* (Tag: ${tag})${comparison.similar
        ? ` (Similarity: ${comparison.similarity_score}%)`
        : ""
      }\n<${databaseUrl}|View here>`
      : `❌ Failed to ${action} decision in Notion database: *${title}*`;

    await this.slackService.apiCall(
      "chat.postMessage",
      {
        channel,
        thread_ts,
        text: message,
      },
      this.slackService.getBotToken()!
    );
  }

  /**
   * Update an existing decision in the Notion database
   * @param params - Parameters for updating a decision
   * @param params.channel - Slack channel ID
   * @param params.thread_ts - Slack thread timestamp
   * @param params.channelName - Slack channel name
   * @param params.threadUrl - Slack thread URL
   * @param params.threadText - Thread text content
   */
  private async updateDecision({
    channel,
    thread_ts,
    channelName,
    threadUrl,
    threadText,
  }: {
    channel: string;
    thread_ts: string;
    channelName: string;
    threadUrl: string;
    threadText: string;
  }): Promise<void> {
    // For now, return a simple static message
    const message = `🔄 Update decision functionality is coming soon! This will allow you to modify existing decisions in the Notion database.`;

    await this.slackService.apiCall(
      "chat.postMessage",
      {
        channel,
        thread_ts,
        text: message,
      },
      this.slackService.getBotToken()!
    );
  }

  /**
   * Fetch related decisions from the Notion database
   * @param params - Parameters for fetching related decisions
   * @param params.channel - Slack channel ID
   * @param params.thread_ts - Slack thread timestamp
   * @param params.channelName - Slack channel name
   * @param params.threadUrl - Slack thread URL
   * @param params.threadText - Thread text content
   */
  private async fetchRelatedDecisions({
    channel,
    thread_ts,
    channelName,
    threadUrl,
    threadText,
  }: {
    channel: string;
    thread_ts: string;
    channelName: string;
    threadUrl: string;
    threadText: string;
  }): Promise<void> {
    // For now, return a simple static message
    const message = `📖 Fetch related decisions functionality is coming soon! This will allow you to search and retrieve related decisions from the Notion database.`;

    await this.slackService.apiCall(
      "chat.postMessage",
      {
        channel,
        thread_ts,
        text: message,
      },
      this.slackService.getBotToken()!
    );
  }
}
