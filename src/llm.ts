import "dotenv/config";
import OpenAI from "openai";
import { DecisionExtraction, OpenAIResponse, RelatedDecisionsResponse, ActionType, DecisionUpdateAnalysis, ThreadSummaryResponse } from "./types";
import {
  extractTitleFallback,
  extractSummaryFallback,
} from "./utils/stringUtils";

export interface DecisionComparison {
  similar: boolean;
  similarity_score: number;
  existing_decision_id?: string;
  reason?: string;
}

const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": process.env.DOMAIN, // Your site URL
    "X-Title": "Decision Bot", // Your site name
  },
});

// Returns { title, summary } — both short, safe to render.
export async function extractDecisionFromThread(
  threadText: string
): Promise<DecisionExtraction | { error: string }> {
  //TODO: Improve system prompt
  const system = [
    "You extract decisions from Slack threads.",
    "Return compact JSON with keys: title (<=80 chars), summary (1–2 sentences), tag (single descriptive word or short phrase) and confidence (0-100).",
    "The tag should be a concise category or topic that describes the decision (e.g., 'architecture', 'process', 'tooling', 'policy').",
    "Do not include Markdown, quotes, or emojis in fields.",
    "The confidence should be a number between 0 and 100 that represents the confidence in the decision.",
  ].join(" ");

  try {
    // Chat Completions with JSON output (simple & reliable)
    const resp = await client.chat.completions.create({
      model: "openai/gpt-5-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content:
            "From the following Slack thread text, extract a crisp decision.\n\nThread:\n" +
            threadText,
        },
      ],
    });

    const content = resp.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content received from OpenAI");
    }

    const { title, summary, tag, confidence } = JSON.parse(
      content
    ) as OpenAIResponse;

    if (confidence !== undefined && confidence < 50) {
      return {
        error:
          "Could not confidently extract decision. Please provide more context.",
      };
    }

    // Basic guardrails
    return {
      title: (title || "Decision").slice(0, 80),
      summary: (summary || "Summary unavailable.").replace(/\s+/g, " ").trim(),
      tag: (tag || "general").replace(/\s+/g, " ").trim(),
    };
  } catch (error) {
    console.error("Error extracting decision from thread:", error);
    // Fallback to basic extraction
    return {
      title: extractTitleFallback(threadText),
      summary: extractSummaryFallback(threadText),
      tag: "general",
    };
  }
}

/**
 * Compare a new decision with existing decisions to find similarities
 * @param newDecision - The newly extracted decision
 * @param existingDecisions - Array of existing decisions from the database
 * @returns Promise<DecisionComparison>
 */
export async function compareDecisionWithExisting(
  newDecision: DecisionExtraction,
  existingDecisions: Array<{
    id: string;
    title: string;
    summary: string;
    tag: string;
  }>
): Promise<DecisionComparison> {
  if (existingDecisions.length === 0) {
    return {
      similar: false,
      similarity_score: 0,
      reason: "No existing decisions to compare against",
    };
  }

  const system = [
    "You compare a new decision with existing decisions to determine if they are similar.",
    "Return JSON with keys: similar (boolean), similarity_score (0-100), existing_decision_id (if similar), and reason (explanation).",
    "Consider decisions similar if they:",
    "- Address the same core issue or topic",
    "- Have overlapping scope or impact",
    "- Are about the same technology, process, or policy",
    "- Have similar outcomes or solutions",
    "Only mark as similar if similarity_score >= 70.",
    "If similar, provide the ID of the most similar existing decision.",
  ].join(" ");

  const existingDecisionsText = existingDecisions
    .map(
      (decision, index) =>
        `${index + 1}. ID: ${decision.id}\n   Title: ${
          decision.title
        }\n   Summary: ${decision.summary}\n   Tag: ${decision.tag}`
    )
    .join("\n\n");

  try {
    const resp = await client.chat.completions.create({
      model: "openai/gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `New Decision:
Title: ${newDecision.title}
Summary: ${newDecision.summary}
Tag: ${newDecision.tag}

Existing Decisions:
${existingDecisionsText}

Compare the new decision with the existing ones and determine if any are similar.`,
        },
      ],
    });

    const content = resp.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content received from OpenAI");
    }

    const result = JSON.parse(content) as DecisionComparison;

    // Validate the result
    if (
      typeof result.similar !== "boolean" ||
      typeof result.similarity_score !== "number"
    ) {
      throw new Error("Invalid response format from LLM");
    }

    return result;
  } catch (error) {
    console.error("Error comparing decision with existing ones:", error);
    return {
      similar: false,
      similarity_score: 0,
      reason: "Error occurred during comparison",
    };
  }
}

/**
 * Find related decisions based on thread context and existing decisions
 * @param threadText - The thread text content
 * @param existingDecisions - Array of existing decisions from the database
 * @returns Promise<RelatedDecisionsResponse>
 */
export async function findRelatedDecisions(
  threadText: string,
  existingDecisions: Array<{
    id: string;
    title: string;
    summary: string;
    tag: string;
  }>
): Promise<RelatedDecisionsResponse> {
  if (existingDecisions.length === 0) {
    return {
      summary: "No existing decisions found in the database.",
      related_decisions: [],
    };
  }

  const system = [
    "You analyze a Slack thread conversation and find related decisions from a database of existing decisions.",
    "Return JSON with keys: summary (string describing if related decisions were found and their relevance), and related_decisions (array of objects with id, title, summary).",
    "The id should be the index position (1-based) of the decision in the provided list.",
    "Only include decisions that are genuinely related to the conversation topic, technology, or context.",
    "The summary should explain what related decisions were found and why they are relevant.",
    "If no related decisions are found, return an empty array and explain why in the summary.",
  ].join(" ");

  const existingDecisionsText = existingDecisions
    .map(
      (decision, index) =>
        `${index + 1}. Title: ${decision.title}\n   Summary: ${decision.summary}\n   Tag: ${decision.tag}`
    )
    .join("\n\n");

  try {
    const resp = await client.chat.completions.create({
      model: "openai/gpt-5-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Slack Thread Conversation:
${threadText}

Existing Decisions Database:
${existingDecisionsText}

Analyze the thread conversation and find any related decisions from the database. Consider the topic, technology, context, and any decisions being discussed.`,
        },
      ],
    });

    const content = resp.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content received from OpenAI");
    }

    const result = JSON.parse(content) as RelatedDecisionsResponse;

    // Validate the result
    if (
      typeof result.summary !== "string" ||
      !Array.isArray(result.related_decisions)
    ) {
      throw new Error("Invalid response format from LLM");
    }

    // Validate each related decision
    for (const decision of result.related_decisions) {
      if (
        typeof decision.id !== "number" ||
        typeof decision.title !== "string" ||
        typeof decision.summary !== "string"
      ) {
        throw new Error("Invalid related decision format from LLM");
      }
    }

    return result;
  } catch (error) {
    console.error("Error finding related decisions:", error);
    return {
      summary: "Error occurred while searching for related decisions.",
      related_decisions: [],
    };
  }
}

/**
 * Analyze a message to determine the user's intent for decision management
 * @param messageText - The message text to analyze
 * @returns Promise<ActionType> - The determined action type
 */
export async function analyzeMessageIntent(messageText: string): Promise<ActionType> {
  const system = [
    "You analyze Slack messages to determine the user's intent for decision management.",
    "Return one of these exact enum values: 'create', 'update', 'read', 'delete', 'summary', or 'none_applicable'.",
    "",
    "Use 'create' when the user wants to:",
    "- Log a new decision to the database",
    "- Record a decision that was made",
    "- Save a decision for future reference",
    "- Document a decision from a discussion",
    "",
    "Use 'update' when the user wants to:",
    "- Modify an existing decision",
    "- Change details of a previously recorded decision",
    "- Update information about a decision",
    "",
    "Use 'read' when the user wants to:",
    "- Find related decisions",
    "- Search for existing decisions",
    "- See what decisions are in the database",
    "- Look up previous decisions on a topic",
    "",
    "Use 'delete' when the user wants to:",
    "- Remove a decision from the database",
    "- Delete an existing decision",
    "- Remove a previously recorded decision",
    "- Get rid of a decision entry",
    "",
    "Use 'summary' when the user wants to:",
    "- Get a summary of the thread discussion",
    "- Summarize what was discussed in the thread",
    "- Get an overview of the conversation results",
    "- See a recap of the thread",
    "- Get a summary of decisions and outcomes",
    "",
    "Use 'none_applicable' when:",
    "- The user doesn't want to create, update, read, or delete decisions",
    "- The message is not about decision management",
    "- The user is asking general questions not related to decisions",
    "- The user explicitly says they don't want to log anything",
    "",
    "Consider the context and intent, not just keywords. A user might say 'we decided to use React' which should be 'create', not 'read'."
  ].join("\n");

  try {
    const resp = await client.chat.completions.create({
      model: "openai/gpt-5-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Analyze this message and determine the user's intent:\n\n"${messageText}"\n\nReturn only the action type as a JSON object with key "action".`
        },
      ],
    });

    const content = resp.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content received from OpenAI");
    }

    const result = JSON.parse(content) as { action: string };
    
    // Validate the action is one of our enum values
    const validActions = Object.values(ActionType);
    if (!validActions.includes(result.action as ActionType)) {
      console.warn(`Invalid action received: ${result.action}, defaulting to none_applicable`);
      return ActionType.NONE_APPLICABLE;
    }

    return result.action as ActionType;
  } catch (error) {
    console.error("Error analyzing message intent:", error);
    // Default to none_applicable on error to avoid unwanted actions
    return ActionType.NONE_APPLICABLE;
  }
}

/**
 * Analyze a thread with related decisions to determine which decision should be updated
 * @param threadText - The thread text content
 * @param relatedDecisions - Array of related decisions from the database
 * @returns Promise<DecisionUpdateAnalysis | { error: string }>
 */
export async function analyzeDecisionUpdate(
  threadText: string,
  relatedDecisions: Array<{
    id: string;
    title: string;
    summary: string;
    tag: string;
  }>
): Promise<DecisionUpdateAnalysis | { error: string }> {
  if (relatedDecisions.length === 0) {
    return {
      error: "No related decisions found to update. Please create a new decision instead."
    };
  }

  const system = [
    "You analyze a Slack thread conversation and determine which existing decision should be updated based on the new information.",
    "Return JSON with keys: decision_id (string), updated_title (optional string), updated_summary (optional string), updated_tag (optional string), reason (string explaining why this decision was chosen), and confidence (0-100).",
    "Only provide updated fields if they should be changed based on the new thread content.",
    "The decision_id should be the exact ID from the provided decisions list.",
    "The reason should explain why this specific decision was chosen for update and what changes are being made.",
    "The confidence should reflect how certain you are that this is the correct decision to update.",
    "If no decision should be updated, return an error message.",
    "Consider the context, topic, and scope of the conversation when determining which decision to update."
  ].join(" ");

  const relatedDecisionsText = relatedDecisions
    .map(
      (decision) =>
        `ID: ${decision.id}\nTitle: ${decision.title}\nSummary: ${decision.summary}\nTag: ${decision.tag}`
    )
    .join("\n\n");

  try {
    const resp = await client.chat.completions.create({
      model: "openai/gpt-5-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Slack Thread Conversation:
${threadText}

Related Decisions:
${relatedDecisionsText}

Analyze the thread and determine which decision should be updated with new information. Provide the updated fields and explain your reasoning.`
        },
      ],
    });

    const content = resp.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content received from OpenAI");
    }

    const result = JSON.parse(content) as DecisionUpdateAnalysis;

    // Validate the result
    if (
      typeof result.decision_id !== "string" ||
      typeof result.reason !== "string" ||
      typeof result.confidence !== "number"
    ) {
      throw new Error("Invalid response format from LLM");
    }

    // Validate that the decision_id exists in our related decisions
    const decisionExists = relatedDecisions.some(decision => decision.id === result.decision_id);
    if (!decisionExists) {
      return {
        error: `Decision ID ${result.decision_id} not found in related decisions.`
      };
    }

    // Check confidence threshold
    if (result.confidence < 60) {
      return {
        error: `Low confidence (${result.confidence}%) in decision update. Please provide more specific information.`
      };
    }

    return result;
  } catch (error) {
    console.error("Error analyzing decision update:", error);
    return {
      error: "Error occurred while analyzing which decision to update."
    };
  }
}

/**
 * Summarize the result of a Slack thread conversation
 * @param threadText - The thread text content
 * @returns Promise<ThreadSummaryResponse | { error: string }>
 */
export async function summarizeThreadResult(
  threadText: string
): Promise<ThreadSummaryResponse | { error: string }> {
  const system = [
    "You analyze Slack thread conversations and provide comprehensive summaries of the discussion results.",
    "Return JSON with keys: summary (string - overall summary of the thread), open_points (array of strings - topics discussed but not decided), decisions_made (array of strings - any decisions that were made), next_steps (array of strings - any follow-up actions or next steps mentioned), and confidence (0-100 - confidence in the summary accuracy).",
    "The summary should be a concise but comprehensive overview of what was discussed and concluded.",
    "The summary should be no more than 100 words.",
    "The open points should be no more than 4 items.",
    "Open points should capture topics, issues, or considerations that were discussed but did not result in a clear decision or conclusion.",
    "Decisions made should list any concrete decisions, choices, or conclusions reached.",
    "Next steps should include any action items, follow-ups, or future work mentioned.",
    "Keep all text concise and actionable. Avoid redundancy between sections.",
    "The confidence should reflect how clear and conclusive the thread discussion was."
  ].join(" ");

  try {
    const resp = await client.chat.completions.create({
      model: "openai/gpt-5-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: `Analyze this Slack thread conversation and provide a comprehensive summary of the results:\n\nThread:\n${threadText}`
        },
      ],
    });

    const content = resp.choices[0]?.message?.content;
    if (!content) {
      throw new Error("No content received from OpenAI");
    }

    const result = JSON.parse(content) as ThreadSummaryResponse;

    // Validate the result
    if (
      typeof result.summary !== "string" ||
      !Array.isArray(result.open_points) ||
      !Array.isArray(result.decisions_made) ||
      !Array.isArray(result.next_steps) ||
      typeof result.confidence !== "number"
    ) {
      throw new Error("Invalid response format from LLM");
    }

    // Validate array contents
    for (const point of result.open_points) {
      if (typeof point !== "string") {
        throw new Error("Invalid open_points format from LLM");
      }
    }
    for (const decision of result.decisions_made) {
      if (typeof decision !== "string") {
        throw new Error("Invalid decisions_made format from LLM");
      }
    }
    for (const step of result.next_steps) {
      if (typeof step !== "string") {
        throw new Error("Invalid next_steps format from LLM");
      }
    }

    // Check confidence threshold
    if (result.confidence < 30) {
      return {
        error: "Thread content is too unclear or incomplete to provide a reliable summary."
      };
    }

    return result;
  } catch (error) {
    console.error("Error summarizing thread result:", error);
    return {
      error: "Error occurred while summarizing the thread conversation."
    };
  }
}
