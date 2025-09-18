import { Request, Response } from "express"
import { SlackService } from "../services/slackService"
import { NotionService } from "../services/notionService"
import { SlackVerification } from "../middleware/slackVerification"
import { extractDecisionFromThread } from "../llm"
import { SlackRequestBody, ExtendedRequest } from "../types"

/**
 * Slack events route handler
 */
export class SlackEventsHandler {
	private slackService: SlackService
	private notionService: NotionService
	private slackVerification: SlackVerification

	constructor() {
		this.slackService = new SlackService()
		this.notionService = new NotionService()
		this.slackVerification = new SlackVerification()
	}

	/**
	 * Handle Slack events endpoint
	 * @param req - Express request object
	 * @param res - Express response object
	 */
	async handleEvents(req: ExtendedRequest, res: Response): Promise<void> {
		console.log("Received request to /slack/events")

		// Handle URL verification
		if (req.body?.type === "url_verification") {
			console.log("URL verification request:", req.body.challenge)
			res.send(req.body.challenge)
			return
		}

		// Verify signature for other requests
		if (!this.slackVerification.verify(req)) {
			console.log("Signature verification failed")
			res.status(401).send("bad sig")
			return
		}

		console.log("Signature verified, processing event")
		res.status(200).send() // Acknowledge immediately

		// Process the event
		await this.processEvent(req.body as SlackRequestBody)
	}

	/**
	 * Process Slack event
	 * @param body - Slack request body
	 */
	private async processEvent(body: SlackRequestBody): Promise<void> {
		const evt = body?.event
		if (!evt || evt.type !== "app_mention") {
			return
		}

		console.log("Processing app mention event:", evt)

		const channel = evt.channel
		const thread_ts = evt.thread_ts ?? evt.ts

		// Test user token
		try {
			const resp = await this.slackService.apiCall(
				"auth.test",
				{},
			)
			console.log("User token test:", resp)
		} catch (error) {
			console.error("User token test failed:", error)
		}

		// Get thread messages
		let threadText = evt.text
		try {
			const replies = await this.slackService.formCall(
				"conversations.replies",
				{ channel, ts: thread_ts },
			)
			threadText = replies.messages?.map((m) => m.text).join("\n") || evt.text
			console.log("Successfully fetched thread messages")
		} catch (error) {
			console.warn(
				"Failed to fetch thread messages, using mention text only:",
				error
			)
			threadText = evt.text
		}

		// Extract decision using LLM
		const { title, summary, tag } = await extractDecisionFromThread(threadText)
		const dateTimestamp = new Date().toISOString()

		// Add decision to Notion database
		let notionSuccess = false
		try {
			const result = await this.notionService.addDecision({
				title,
				summary,
				tag,
				slack_thread: thread_ts,
				slack_channel: channel,
				date_timestamp: dateTimestamp,
			})
			
			if (result.success) {
				console.log(`Decision added to Notion successfully with page ID: ${result.page_id}`)
				notionSuccess = true
			} else {
				console.error("Notion operation failed:", result.error)
				notionSuccess = false
			}
		} catch (notionError) {
			console.error("Notion operation failed:", notionError)
			notionSuccess = false
		}

		// Post confirmation message
		const message = notionSuccess 
			? `✅ Decision logged to Notion database: *${title}* (Tag: ${tag})`
			: `❌ Failed to log decision to Notion database: *${title}*`
			
		await this.slackService.apiCall("chat.postMessage", {
			channel,
			thread_ts,
			text: message,
		})
	}
}
