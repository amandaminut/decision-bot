import "dotenv/config";
import OpenAI from "openai";

// Type definitions
interface DecisionExtraction {
  title: string;
  summary: string;
}

interface OpenAIResponse {
  title?: string;
  summary?: string;
}

const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    "HTTP-Referer": "https://amanda.minut.dev", // Your site URL
    "X-Title": "Decision Bot", // Your site name
  },
});

// Returns { title, summary } — both short, safe to render.
export async function extractDecisionFromThread(
  threadText: string
): Promise<DecisionExtraction> {
  const system = [
    "You extract decisions from Slack threads.",
    "Return compact JSON with keys: title (<=80 chars) and summary (1–2 sentences).",
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

    const json = JSON.parse(content) as OpenAIResponse;

    // Basic guardrails
    return {
      title: (json.title || "Decision").slice(0, 80),
      summary: (json.summary || "Summary unavailable.")
        .replace(/\s+/g, " ")
        .trim(),
    };
  } catch (error) {
    console.error("Error extracting decision from thread:", error);
    // Fallback to basic extraction
    return {
      title: extractTitleFallback(threadText),
      summary: extractSummaryFallback(threadText),
    };
  }
}

// Fallback functions for when OpenAI fails
function extractTitleFallback(text: string): string {
  const first =
    text
      .split(/\n|\./)
      .map((s) => s.trim())
      .find(Boolean) || "Decision";
  return first.slice(0, 80);
}

function extractSummaryFallback(text: string): string {
  let s = text.replace(/\s+/g, " ").trim();
  if (s.length > 180) s = s.slice(0, 177) + "...";
  return s || "Summary TBD";
}
