import { SlackResponse } from "../types"

/**
 * Service for interacting with Slack API
 */
export class SlackService {
	private botToken: string | undefined
	private userToken: string | undefined

	constructor() {
		this.botToken = process.env.SLACK_BOT_TOKEN
		this.userToken = process.env.SLACK_USER_TOKEN
	}

	/**
	 * Make a request to Slack API with JSON body
	 * @param method - Slack API method name
	 * @param body - Request body
	 * @returns Promise with Slack response
	 */
	async apiCall(
		method: string,
		body: Record<string, any>,
	): Promise<SlackResponse> {
		// Use bot token for chat.postMessage, user token for other methods
		const token = method === "chat.postMessage" ? this.getBotToken() : this.getUserToken()
		if (!token) {
			throw new Error("No token provided")
		}

		console.log("Making Slack API call:", method)
		console.log("Using token type:", method === "chat.postMessage" ? "bot" : "user")
		console.log("Request body:", JSON.stringify(body))

		const res = await fetch(`https://slack.com/api/${method}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify(body),
		})

		const response = (await res.json()) as SlackResponse
		if (!response.ok) {
			throw new Error(`${method} failed: ${response.error}`)
		}

		return response
	}

	/**
	 * Make a request to Slack API with form data
	 * @param method - Slack API method name
	 * @param body - Request body
	 * @returns Promise with Slack response
	 */
	async formCall(
		method: string,
		body: Record<string, any>,
	): Promise<SlackResponse> {
		const form = new URLSearchParams()
		for (const [k, v] of Object.entries(body)) {
			form.set(k, String(v))
		}
		// Use user token for form calls (like conversations.replies)
		const token = this.getUserToken()
		if (!token) {
			throw new Error("No token provided")
		}

		const res = await fetch(`https://slack.com/api/${method}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
			body: form,
		})

		return res.json() as Promise<SlackResponse>
	}

	/**
	 * Get bot token
	 */
	getBotToken(): string | undefined {
		return this.botToken
	}

	/**
	 * Get user token
	 */
	getUserToken(): string | undefined {
		return this.userToken
	}
}
