import { Request, Response } from "express"
import { SlackService } from "../services/slackService"
import { CanvasService } from "../services/canvasService"
import { SlackVerification } from "../middleware/slackVerification"
import { extractDecisionFromThread } from "../llm"
import { SlackRequestBody, ExtendedRequest } from "../types"

/**
 * Slack events route handler
 */
export class SlackEventsHandler {
	private slackService: SlackService
	private canvasService: CanvasService
	private slackVerification: SlackVerification

	constructor() {
		this.slackService = new SlackService()
		this.canvasService = new CanvasService(this.slackService)
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
		const { title, summary } = await extractDecisionFromThread(threadText)
		const decidedAt = new Date().toISOString().slice(0, 16).replace("T", " ")

		// Update canvas
		let canvasSuccess = false
		try {
			const result = await this.canvasService.upsertChannelCanvas({
				channel,
				title,
				summary,
				decidedAt,
				thread_ts,
			})
			console.log(
				`Canvas ${result.created ? "created" : "updated"} successfully`
			)
			canvasSuccess = true
		} catch (canvasError) {
			console.error("Canvas operation failed:", canvasError)
			canvasSuccess = false
		}

		// Post confirmation message
		await this.slackService.apiCall("chat.postMessage", {
			channel,
			thread_ts,
			text: `✅ Logged decision to the channel canvas: *${title}*`,
		})
	}
}
