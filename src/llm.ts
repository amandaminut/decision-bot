import "dotenv/config";
import OpenAI from "openai";
import { DecisionExtraction, OpenAIResponse, RelatedDecisionsResponse } from "./types";
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
      model: "openai/gpt-4o-mini",
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
      console.log("Returning error");
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
      model: "openai/gpt-4o-mini",
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
