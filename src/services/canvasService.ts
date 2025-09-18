import { SlackService } from "./slackService"
import { UpsertCanvasParams, CanvasOperationResult } from "../types"

/**
 * Service for managing Slack canvas operations
 */
export class CanvasService {
	private slackService: SlackService

	constructor(slackService: SlackService) {
		this.slackService = slackService
	}

	/**
	 * Escape pipe characters for markdown table formatting
	 * @param text - Text to escape
	 * @returns Escaped text
	 */
	private escapePipes(text: string): string {
		return String(text).replace(/\|/g, "\\|")
	}

	/**
	 * Upsert a decision to a channel canvas
	 * @param params - Canvas operation parameters
	 * @returns Result of the operation
	 */
	async upsertChannelCanvas({
		channel,
		title,
		summary,
		decidedAt,
		thread_ts,
	}: UpsertCanvasParams): Promise<CanvasOperationResult> {
		// Check if the channel already has a canvas
		const conv = await this.slackService.formCall(
			"conversations.info",
			{ channel },
		)
		const channelCanvas = (conv as any)?.channel?.properties?.canvas

		const row = `| ${this.escapePipes(title)} | ${this.escapePipes(
			summary
		)} | ${decidedAt} | [Open Thread](https://slack.com/app_redirect?channel=${channel}&message_ts=${thread_ts}) |\n`

		if (channelCanvas?.id) {
			console.log("Channel canvas already exists, updating...")
			// Edit existing channel canvas
			await this.slackService.apiCall("canvases.edit", {
				canvas_id: channelCanvas.id,
				changes: [
					{
						operation: "insert_at_end",
						document_content: {
							type: "markdown",
							markdown: row,
						},
					},
				],
			})
			return { created: false, canvas_id: channelCanvas.id }
		}

		// Create new channel canvas
		console.log("Creating new channel canvas...")
		const created = await this.slackService.apiCall(
			"conversations.canvases.create",
			{
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
			}
		)

		return { created: true, canvas_id: (created as any).canvas?.id }
	}
}
