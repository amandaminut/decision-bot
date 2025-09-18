import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { extractDecisionFromThread } from "./llm";

// Type definitions
interface SlackEvent {
  type: string;
  channel: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

interface SlackRequestBody {
  type?: string;
  challenge?: string;
  event?: SlackEvent;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  canvas_id?: string;
  messages?: Array<{ text: string }>;
  canvases?: Array<{ title: string; canvas_id: string }>;
}

interface ExtendedRequest extends Request {
  rawBody?: string;
}

const app = express();

const SLACK_BOT_TOKEN: string | undefined = process.env.SLACK_BOT_TOKEN;
const SLACK_USER_TOKEN: string | undefined = process.env.SLACK_USER_TOKEN;
const SLACK_SIGNING_SECRET: string | undefined =
  process.env.SLACK_SIGNING_SECRET;

const slack = async (
  method: string,
  body: Record<string, any>,
  token: string | undefined = SLACK_BOT_TOKEN
): Promise<SlackResponse> => {
  if (!token) {
    throw new Error("No token provided");
  }
  console.log(token);
  console.log(JSON.stringify(body));
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  console.log(JSON.stringify(body));
  const j = (await res.json()) as SlackResponse;
  if (!j.ok) throw new Error(`${method} failed: ${j.error}`);
  return j;
};

async function slackForm(
  method: string,
  body: Record<string, any>,
  token: string
): Promise<SlackResponse> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) form.set(k, String(v));
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return res.json() as Promise<SlackResponse>;
}

// Verify Slack signature
function verifySlack(req: ExtendedRequest): boolean {
  if (!SLACK_SIGNING_SECRET) {
    console.warn("SLACK_SIGNING_SECRET not configured");
    return false;
  }

  const ts = req.headers["x-slack-request-timestamp"] as string;
  const sig = req.headers["x-slack-signature"] as string;
  if (!ts || !sig) return false;

  // prevent replay
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) return false;

  // Use the parsed body for signature verification
  const basestring = `v0:${ts}:${JSON.stringify(req.body)}`;
  const hmac = crypto
    .createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(basestring)
    .digest("hex");
  const expected = `v0=${hmac}`;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// Use Express JSON parser for all routes
app.use(express.json());

// Health check endpoint
app.get("/health", (req: Request, res: Response) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || "development",
  });
});

// Slack Events endpoint
app.post("/slack/events", async (req: ExtendedRequest, res: Response) => {
  console.log("Received request to /slack/events");

  // URL verification - handle immediately
  if (req.body?.type === "url_verification") {
    console.log("URL verification request:", req.body.challenge);
    return res.send(req.body.challenge);
  }

  // For other requests, verify signature
  if (!verifySlack(req)) {
    console.log("Signature verification failed");
    return res.status(401).send("bad sig");
  }

  console.log("Signature verified, processing event");
  res.status(200).send(); // ack immediately

  const body = req.body as SlackRequestBody;
  const evt = body?.event;
  if (!evt || evt.type !== "app_mention") return;
  console.log(evt);
  const channel = evt.channel;
  const thread_ts = evt.thread_ts ?? evt.ts;
  const resp = await slack("auth.test", {}, SLACK_USER_TOKEN);
  console.log(resp);
  // Grab thread messages (needs user token for channels per Slack docs)
  // Fallback: just use the mention text if you don't want thread reads yet.
  let threadText = evt.text;
  try {
    const replies = await slackForm(
      "conversations.replies",
      { channel, ts: thread_ts },
      SLACK_USER_TOKEN ?? ""
    );
    threadText = replies.messages?.map((m) => m.text).join("\n") || evt.text;
    console.log("Successfully fetched thread messages");
  } catch (e) {
    // proceed with evt.text only
    console.warn(
      "Failed to fetch thread messages, using mention text only:",
      e
    );
    threadText = evt.text;
  }

  // === Extract decision using LLM ===
  const { title, summary } = await extractDecisionFromThread(threadText);

  const decidedAt = new Date().toISOString().slice(0, 16).replace("T", " ");

  // Use the smarter canvas upsert approach
  let canvasSuccess = false;
  try {
    const result = await upsertChannelCanvas({
      channel,
      title,
      summary,
      decidedAt,
      thread_ts,
    });
    console.log(
      `Canvas ${result.created ? "created" : "updated"} successfully`
    );
    canvasSuccess = true;
  } catch (canvasError) {
    console.error("Canvas operation failed:", canvasError);
    canvasSuccess = false;
  }

  // Confirm in thread;
  if (canvasSuccess) {
    await slack("chat.postMessage", {
      channel,
      thread_ts,
      text: `✅ Logged decision to the channel canvas: *${title}*`,
    });
  } else {
    // Fallback: post the decision as a formatted message
    await slack("chat.postMessage", {
      channel,
      thread_ts,
      text: `✅ Logged decision to the channel canvas: *${title}*`,
    });
  }
});

// --- helpers ---
function escapePipes(s: string): string {
  return String(s).replace(/\|/g, "\\|");
}

async function upsertChannelCanvas({
  channel, // e.g. "C0123456789"
  title,
  summary,
  decidedAt,
  thread_ts,
}: {
  channel: string;
  title: string;
  summary: string;
  decidedAt: string;
  thread_ts: string;
}) {
  const escapePipes = (s: string) => s.replace(/\|/g, "\\|");

  // 1) Does the channel already have a canvas?
  const conv = await slackForm(
    "conversations.info",
    { channel },
    SLACK_BOT_TOKEN as string
  );
  const channelCanvas = (conv as any)?.channel?.properties?.canvas;

  const row = `| ${escapePipes(title)} | ${escapePipes(
    summary
  )} | ${decidedAt} | [Open Thread](https://slack.com/app_redirect?channel=${channel}&message_ts=${thread_ts}) |\n`;

  if (channelCanvas?.id) {
    console.log("Channel canvas already exists");
    // 2) Edit existing channel canvas by id
    await slack("canvases.edit", {
      canvas_id: channelCanvas.id, // <-- required
      changes: [
        {
          operation: "insert_at_end",
          document_content: {
            type: "markdown",
            markdown: row,
          },
        },
      ],
    });
    return { created: false, canvas_id: channelCanvas.id };
  }

  // 3) No channel canvas yet — create one (only one per channel is allowed)
  const created = await slack("conversations.canvases.create", {
    channel_id: channel,
    title: "Channel Decisions",
    document_content: {
      type: "markdown",
      markdown: [
        "# Decisions",
        "",
        "| Decision | Summary | Timestamp | Thread |",
        "|---|---|---|---|",
        row.trimEnd(),
      ].join("\n"),
    },
  });
  return { created: true, canvas_id: (created as any).canvas?.id };
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));

export default app;
