import { Request, Response } from "express";
import { SlackService } from "../services/slackService";
import { NotionService } from "../services/notionService";
import { SlackVerification } from "../middleware/slackVerification";
import { extractDecisionFromThread, compareDecisionWithExisting, findRelatedDecisions, analyzeMessageIntent, analyzeDecisionUpdate, summarizeThreadResult } from "../llm";
import {
  SlackRequestBody,
  ExtendedRequest,
  DecisionExtraction,
  ActionType,
  PendingDeletion,
} from "../types";

/**
 * Slack events route handler
 */
export class SlackEventsHandler {
  private slackService: SlackService;
  private notionService: NotionService;
  private slackVerification: SlackVerification;
  private pendingDeletions: Map<string, PendingDeletion>;

  constructor() {
    this.slackService = new SlackService();
    this.notionService = new NotionService();
    this.slackVerification = new SlackVerification();
    this.pendingDeletions = new Map();
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

    // Analyze message intent using AI
    const begin = threadText.indexOf(">") + 2;
    const messageText = threadText.substring(begin, threadText.length).trim();
    console.log("Message text:", messageText);

    const actionType = await analyzeMessageIntent(messageText);
    console.log("Analyzed action type:", actionType);

    switch (actionType) {
      case ActionType.CREATE:
        await this.createNewDecision({
          channel,
          thread_ts,
          channelName,
          threadUrl,
          threadText,
        });
        break;
      case ActionType.UPDATE:
        await this.updateDecision({
          channel,
          thread_ts,
          channelName,
          threadUrl,
          threadText,
        });
        break;
      case ActionType.READ:
        await this.fetchRelatedDecisions({
          channel,
          thread_ts,
          channelName,
          threadUrl,
          threadText,
        });
        break;
      case ActionType.DELETE:
        await this.deleteDecision({
          channel,
          thread_ts,
          channelName,
          threadUrl,
          threadText,
          eventText: evt.text,
        });
        break;
      case ActionType.SUMMARY:
        await this.summarizeThreadResult({
          channel,
          thread_ts,
          channelName,
          threadUrl,
          threadText,
        });
        break;
      case ActionType.NONE_APPLICABLE:
        // Post a message indicating no action was taken
        const message = `🤖 I analyzed your message but didn't detect any intent to create, update, read, delete, or summarize decisions. If you'd like to log a decision or get a summary, please be more specific about what you'd like me to do.`;
        
        await this.slackService.apiCall(
          "chat.postMessage",
          {
            channel,
            thread_ts,
            text: message,
          },
          this.slackService.getBotToken()!
        );
        break;
      default:
        console.warn(`Unknown action type: ${actionType}`);
        break;
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
      ? `✅ Decision ${action}: *${title}*${comparison.similar
        ? ` (Similarity: ${comparison.similarity_score}%)`
        : ""
      }\n<${databaseUrl}|View here>`
      : `❌ Failed to ${action} decision: *${title}*`;

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
    try {
      // Get all existing decisions from the database
      console.log("Retrieving all decisions from Notion database...");
      const existingDecisions = await this.notionService.getAllDecisions();

      if (existingDecisions.length === 0) {
        const message = `❌ No decisions found in the database to update. Please create a decision first.`;
        
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

      // Find related decisions using AI (reuse the read flow logic)
      console.log("Finding related decisions using AI...");
      const relatedDecisionsResult = await findRelatedDecisions(
        threadText,
        existingDecisions
      );

      if (relatedDecisionsResult.related_decisions.length === 0) {
        const message = `❌ No related decisions found to update. The thread doesn't seem to relate to any existing decisions in the database.`;
        
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

      // Convert the related decisions to the format expected by analyzeDecisionUpdate
      // The decision.id from findRelatedDecisions is a 1-based index, so we need to map it to the actual Notion page ID
      const relatedDecisionsForUpdate = relatedDecisionsResult.related_decisions.map(decision => {
        // decision.id is 1-based index, so we need to get the actual decision from existingDecisions
        const decisionIndex = decision.id - 1; // Convert to 0-based index
        const existingDecision = existingDecisions[decisionIndex];
        
        if (!existingDecision) {
          console.warn(`Decision at index ${decisionIndex} not found in existing decisions`);
          return null;
        }
        
        return {
          id: existingDecision.id, // Use the actual Notion page ID
          title: decision.title,
          summary: decision.summary,
          tag: existingDecision.tag
        };
      }).filter(decision => decision !== null); // Remove any null entries

      if (relatedDecisionsForUpdate.length === 0) {
        const message = `❌ Failed to map related decisions to valid Notion page IDs.`;
        
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

      // Analyze which decision should be updated and what changes to make
      console.log("Analyzing which decision to update...");
      const updateAnalysis = await analyzeDecisionUpdate(threadText, relatedDecisionsForUpdate);

      if ("error" in updateAnalysis) {
        const message = `❌ Failed to analyze decision update: *${updateAnalysis.error}*`;
        
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

      // Prepare the update data
      const updateData: any = {
        slack_thread: threadUrl,
        slack_channel: channelName,
        date_timestamp: new Date().toISOString(),
      };

      // Add only the fields that should be updated
      if (updateAnalysis.updated_title) {
        updateData.title = updateAnalysis.updated_title;
      }
      if (updateAnalysis.updated_summary) {
        updateData.summary = updateAnalysis.updated_summary;
      }
      if (updateAnalysis.updated_tag) {
        updateData.tag = updateAnalysis.updated_tag;
      }

      // Update the decision in Notion
      console.log(`Updating decision ${updateAnalysis.decision_id}...`);
      const updateResult = await this.notionService.updateDecision(
        updateAnalysis.decision_id,
        updateData
      );

      // Post confirmation message
      const databaseUrl = this.notionService.getDatabaseUrl();
      const message = updateResult.success
        ? `✅ Decision updated successfully!\n\n<${databaseUrl}|View in Notion>`
        : `❌ Failed to update decision: *${updateResult.error}*`;

      await this.slackService.apiCall(
        "chat.postMessage",
        {
          channel,
          thread_ts,
          text: message,
        },
        this.slackService.getBotToken()!
      );

      console.log("Successfully updated decision in Notion database");
    } catch (error) {
      console.error("Error updating decision:", error);
      
      // Post error message
      const errorMessage = `❌ Failed to update decision: ${error instanceof Error ? error.message : "Unknown error"}`;
      
      await this.slackService.apiCall(
        "chat.postMessage",
        {
          channel,
          thread_ts,
          text: errorMessage,
        },
        this.slackService.getBotToken()!
      );
    }
  }

  /**
   * Delete a decision from the Notion database with confirmation
   * @param params - Parameters for deleting a decision
   * @param params.channel - Slack channel ID
   * @param params.thread_ts - Slack thread timestamp
   * @param params.channelName - Slack channel name
   * @param params.threadUrl - Slack thread URL
   * @param params.threadText - Thread text content
   * @param params.eventText - Current event text content
   */
  private async deleteDecision({
    channel,
    thread_ts,
    channelName,
    threadUrl,
    threadText,
    eventText,
  }: {
    channel: string;
    thread_ts: string;
    channelName: string;
    threadUrl: string;
    threadText: string;
    eventText: string;
  }): Promise<void> {
    try {
      // Check if there's a pending deletion for this thread
      const pendingDeletionKey = `${channel}-${thread_ts}`;
      const pendingDeletion = this.pendingDeletions.get(pendingDeletionKey);

      if (pendingDeletion) {
        // Check if the message is a confirmation
        // Extract just the latest message text (remove the @bot mention)
        const messageText = eventText.substring(eventText.indexOf(">") + 2).trim().toLowerCase();
        console.log("Confirmation message text:", messageText);
        
        if (messageText.includes("yes") || messageText.includes("confirm") || messageText.includes("delete")) {
          // User confirmed deletion
          console.log(`Deleting decision ${pendingDeletion.decision_id}...`);
          const deleteResult = await this.notionService.deleteDecision(pendingDeletion.decision_id);

          // Remove from pending deletions
          this.pendingDeletions.delete(pendingDeletionKey);

          // Post confirmation message
          const message = deleteResult.success
            ? `✅ Decision deleted successfully!\n\n*Deleted Decision:* ${pendingDeletion.title}\n*Summary:* ${pendingDeletion.summary}`
            : `❌ Failed to delete decision: *${deleteResult.error}*`;

          await this.slackService.apiCall(
            "chat.postMessage",
            {
              channel,
              thread_ts,
              text: message,
            },
            this.slackService.getBotToken()!
          );

          console.log("Successfully deleted decision from Notion database");
          return;
        } else if (messageText.includes("no") || messageText.includes("cancel") || messageText.includes("abort")) {
          // User cancelled deletion
          console.log("User cancelled deletion");
          this.pendingDeletions.delete(pendingDeletionKey);
          
          const message = `❌ Decision deletion cancelled. The decision "${pendingDeletion.title}" was not deleted.`;
          
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
        } else {
          // User sent another message, remind them about the pending deletion
          const message = `⚠️ You have a pending deletion for: *${pendingDeletion.title}*\n\nPlease reply with "yes" to confirm deletion or "no" to cancel.`;
          
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
      }

      // No pending deletion, find the decision to delete
      console.log("Retrieving all decisions from Notion database...");
      const existingDecisions = await this.notionService.getAllDecisions();

      if (existingDecisions.length === 0) {
        const message = `❌ No decisions found in the database to delete.`;
        
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

      // Find related decisions using AI (reuse the read flow logic)
      console.log("Finding related decisions to delete using AI...");
      const relatedDecisionsResult = await findRelatedDecisions(
        threadText,
        existingDecisions
      );

      if (relatedDecisionsResult.related_decisions.length === 0) {
        const message = `❌ No related decisions found to delete. The thread doesn't seem to relate to any existing decisions in the database.`;
        
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

      if (relatedDecisionsResult.related_decisions.length > 1) {
        const message = `❌ Multiple related decisions found. Please be more specific about which decision you want to delete.\n\nRelated decisions:\n${relatedDecisionsResult.related_decisions.map(d => `• ${d.title}`).join('\n')}`;
        
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

      // Get the decision to delete
      const decisionToDelete = relatedDecisionsResult.related_decisions[0];
      const decisionIndex = decisionToDelete.id - 1; // Convert to 0-based index
      const existingDecision = existingDecisions[decisionIndex];

      if (!existingDecision) {
        const message = `❌ Decision not found in database.`;
        
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

      // Store pending deletion
      const pendingDeletionData: PendingDeletion = {
        decision_id: existingDecision.id,
        title: existingDecision.title,
        summary: existingDecision.summary,
        thread_ts,
        channel,
        timestamp: Date.now(),
      };

      this.pendingDeletions.set(pendingDeletionKey, pendingDeletionData);

      // Ask for confirmation
      const message = `⚠️ Are you sure you want to delete this decision?\n\n*Decision:* ${existingDecision.title}\n*Summary:* ${existingDecision.summary}\n*Tag:* ${existingDecision.tag}\n\nReply with "yes" to confirm deletion or "no" to cancel.`;
      
      await this.slackService.apiCall(
        "chat.postMessage",
        {
          channel,
          thread_ts,
          text: message,
        },
        this.slackService.getBotToken()!
      );

      console.log(`Pending deletion created for decision: ${existingDecision.title}`);
    } catch (error) {
      console.error("Error deleting decision:", error);
      
      // Post error message
      const errorMessage = `❌ Failed to delete decision: ${error instanceof Error ? error.message : "Unknown error"}`;
      
      await this.slackService.apiCall(
        "chat.postMessage",
        {
          channel,
          thread_ts,
          text: errorMessage,
        },
        this.slackService.getBotToken()!
      );
    }
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
    try {
      // Get all existing decisions from the database
      console.log("Retrieving all decisions from Notion database...");
      const existingDecisions = await this.notionService.getAllDecisions();

      // Find related decisions using AI
      console.log("Finding related decisions using AI...");
      const relatedDecisionsResult = await findRelatedDecisions(
        threadText,
        existingDecisions
      );

      // Format the message using Slack's native formatting
      let message = "";

      if (relatedDecisionsResult.related_decisions.length > 0) {
        message += `📋 *Related Decisions:*\n`;
        relatedDecisionsResult.related_decisions.forEach((decision) => {
          message += `\n*${decision.id}. ${decision.title}*\n${decision.summary}\n`;
        });
      }

      message += `\n<${threadUrl}|source>`;

      // Post the message
      await this.slackService.apiCall(
        "chat.postMessage",
        {
          channel,
          thread_ts,
          text: message,
        },
        this.slackService.getBotToken()!
      );

      console.log("Successfully posted related decisions to Slack");
    } catch (error) {
      console.error("Error fetching related decisions:", error);
      
      // Post error message
      const errorMessage = `❌ Failed to fetch related decisions: ${error instanceof Error ? error.message : "Unknown error"}`;
      
      await this.slackService.apiCall(
        "chat.postMessage",
        {
          channel,
          thread_ts,
          text: errorMessage,
        },
        this.slackService.getBotToken()!
      );
    }
  }

  /**
   * Summarize the result of a Slack thread conversation
   * @param params - Parameters for summarizing thread results
   * @param params.channel - Slack channel ID
   * @param params.thread_ts - Slack thread timestamp
   * @param params.channelName - Slack channel name
   * @param params.threadUrl - Slack thread URL
   * @param params.threadText - Thread text content
   */
  private async summarizeThreadResult({
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
    try {
      // Generate thread summary using LLM
      console.log("Generating thread summary...");
      const summaryResult = await summarizeThreadResult(threadText);

      if ("error" in summaryResult) {
        const message = `❌ Failed to generate thread summary: *${summaryResult.error}*`;
        
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

      // Format the summary message using Slack's native formatting
      let message = `📋 *Thread Summary*\n\n`;
      message += `*Overview:* ${summaryResult.summary}\n\n`;

      if (summaryResult.open_points.length > 0) {
        message += `*Open Points:*\n`;
        summaryResult.open_points.forEach((point, index) => {
          message += `${index + 1}. ${point}\n`;
        });
        message += `\n`;
      }

      if (summaryResult.decisions_made.length > 0) {
        message += `*Decisions Made:*\n`;
        summaryResult.decisions_made.forEach((decision, index) => {
          message += `${index + 1}. ${decision}\n`;
        });
        message += `\n`;
      }

      if (summaryResult.next_steps.length > 0) {
        message += `*Next Steps:*\n`;
        summaryResult.next_steps.forEach((step, index) => {
          message += `${index + 1}. ${step}\n`;
        });
        message += `\n`;
      }

      // message += `*Confidence:* ${summaryResult.confidence}%\n`;
      message += `\n<${threadUrl}|View original thread>`;

      // Post the summary message
      await this.slackService.apiCall(
        "chat.postMessage",
        {
          channel,
          thread_ts,
          text: message,
        },
        this.slackService.getBotToken()!
      );

      console.log("Successfully posted thread summary to Slack");
    } catch (error) {
      console.error("Error summarizing thread result:", error);
      
      // Post error message
      const errorMessage = `❌ Failed to summarize thread: ${error instanceof Error ? error.message : "Unknown error"}`;
      
      await this.slackService.apiCall(
        "chat.postMessage",
        {
          channel,
          thread_ts,
          text: errorMessage,
        },
        this.slackService.getBotToken()!
      );
    }
  }
}
