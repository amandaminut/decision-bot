import "dotenv/config"
import OpenAI from "openai"
import { DecisionExtraction, OpenAIResponse } from "./types"
import { extractTitleFallback, extractSummaryFallback } from "./utils/stringUtils"

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
): Promise<DecisionExtraction> {
  //TODO: Improve system prompt
  const system = [
    "You extract decisions from Slack threads.",
    "Return compact JSON with keys: title (<=80 chars), summary (1–2 sentences), and tag (single descriptive word or short phrase).",
    "The tag should be a concise category or topic that describes the decision (e.g., 'architecture', 'process', 'tooling', 'policy').",
    "Do not include Markdown, quotes, or emojis in fields.",
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

    const { title, summary, tag } = JSON.parse(content) as OpenAIResponse;

    // Basic guardrails
    return {
      title: (title || "Decision").slice(0, 80),
      summary: (summary || "Summary unavailable.")
        .replace(/\s+/g, " ")
        .trim(),
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

