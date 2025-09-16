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
}

interface ExtendedRequest extends Request {
  rawBody?: string;
}

const app = express();
app.use(express.json({ type: "*/*" }));

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

  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as SlackResponse;
  if (!j.ok) throw new Error(`${method} failed: ${j.error}`);
  return j;
};

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

  const basestring = `v0:${ts}:${req.rawBody || JSON.stringify(req.body)}`;
  const hmac = crypto
    .createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(basestring)
    .digest("hex");
  const expected = `v0=${hmac}`;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// Raw body capture for signature
app.use((req: ExtendedRequest, res: Response, next: NextFunction) => {
  let data = "";
  req.setEncoding("utf8");
  req.on("data", (chunk: string) => (data += chunk));
  req.on("end", () => {
    req.rawBody = data || "{}";
    try {
      req.body = JSON.parse(req.rawBody);
    } catch {
      // Ignore parsing errors
    }
    next();
  });
});

// Slack Events endpoint
app.post("/slack/events", async (req: ExtendedRequest, res: Response) => {
  const body = req.body as SlackRequestBody;

  // URL verification
  if (body?.type === "url_verification") {
    return res.send(body.challenge);
  }

  if (!verifySlack(req)) return res.status(401).send("bad sig");
  res.status(200).send(); // ack immediately

  const evt = body?.event;
  if (!evt || evt.type !== "app_mention") return;

  const channel = evt.channel;
  const thread_ts = evt.thread_ts || evt.ts;

  // Grab thread messages (needs user token for channels per Slack docs)
  // Fallback: just use the mention text if you don't want thread reads yet.
  let threadText = evt.text;
  try {
    const replies = await slack(
      "conversations.replies",
      { channel, ts: thread_ts, limit: 15 },
      SLACK_USER_TOKEN || SLACK_BOT_TOKEN
    );
    threadText = replies.messages?.map((m) => m.text).join("\n") || evt.text;
  } catch (e) {
    // proceed with evt.text only
    console.warn("Failed to fetch thread messages:", e);
  }

  // === Extract decision using LLM ===
  const { title, summary } = await extractDecisionFromThread(threadText);
  const decidedAt = new Date().toISOString().slice(0, 16).replace("T", " ");

  // Ensure a channel canvas exists; create one if not
  // Tip: canvases.create with channel_id auto-tabs it to the channel.
  // We'll also seed a header + table if this is first time.
  let canvasId: string | undefined;
  try {
    // Try to create once; if already exists, Slack returns an error — handle by looking up via sections or just continue to edit.
    const created = await slack("canvases.create", {
      channel_id: channel,
      title: "Channel Decisions",
      document_content: {
        type: "markdown",
        markdown: [
          "# Decisions",
          "",
          "| Decision | Summary | Timestamp | Thread |",
          "|---|---|---|---|",
        ].join("\n"),
      },
    });
    canvasId = created.canvas_id;
  } catch (error) {
    // If creation fails (likely already exists), we'll just edit below.
    console.log("Canvas creation failed (likely already exists):", error);
  }

  // Build a markdown table row. (Tables are supported in canvases.)
  // Link back to the thread using slack:// URL or https://workspace.slack.com/archives/CID/p12345678
  const threadLink = `<${`https://slack.com/app_redirect?channel=${channel}&message_ts=${thread_ts}`}|Open>`;
  const row = `| ${escapePipes(title)} | ${escapePipes(
    summary
  )} | ${decidedAt} | ${threadLink} |`;

  // Append the row at the end of the canvas
  await slack("canvases.edit", {
    // If you have the canvas_id from creation, you can pass it with "canvas_id".
    // If not, you can still target the channel canvas directly via the Deno function,
    // but with Web API we edit by canvas_id. Here we rely on Slack routing the channel canvas:
    // use canvases.sections.lookup first to get canvas_id; simple path below tries a replace/insert.
    channel_id: channel, // Supported by canvases.edit for channel canvas edits
    changes: [
      {
        operation: "insert_at_end",
        document_content: { type: "markdown", markdown: row + "\n" },
      },
    ],
  });

  // Optionally, confirm in thread
  await slack("chat.postMessage", {
    channel,
    thread_ts,
    text: `Logged decision to the channel canvas: *${title}*`,
  });
});

// --- helpers ---
function escapePipes(s: string): string {
  return String(s).replace(/\|/g, "\\|");
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`listening on ${port}`));

export default app;
