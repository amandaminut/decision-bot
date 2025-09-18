/**
 * Type definitions for the decision bot application
 */

export interface SlackEvent {
	type: string
	channel: string
	text: string
	ts: string
	thread_ts?: string
}

export interface SlackRequestBody {
	type?: string
	challenge?: string
	event?: SlackEvent
}

export interface SlackResponse {
	ok: boolean
	error?: string
	canvas_id?: string
	messages?: Array<{ text: string }>
	canvases?: Array<{ title: string; canvas_id: string }>
}

export interface ExtendedRequest {
	body: any
	headers: Record<string, string | string[] | undefined>
	rawBody?: string
}

export interface DecisionExtraction {
	title: string
	summary: string
	tag: string
}

export interface OpenAIResponse {
	title?: string
	summary?: string
	tag?: string
}


export interface NotionDatabaseEntry {
	title: string
	summary: string
	tag: string
	slack_thread: string
	slack_channel: string
	date_timestamp: string
}

export interface NotionOperationResult {
	success: boolean
	page_id?: string
	error?: string
}
