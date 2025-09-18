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
		token: string,
	): Promise<SlackResponse> {
		// Use bot token for chat.postMessage, user token for other methods
		// const token = method === "chat.postMessage" ? this.getBotToken() : this.getUserToken()
		if (!token) {
			throw new Error("No token provided")
		}

		// console.log("Making Slack API call:", method)
		// console.log("Using token type:", method === "chat.postMessage" ? "bot" : "user")
		// console.log("Request body:", JSON.stringify(body))

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
    token= this.getUserToken(),
	): Promise<SlackResponse> {
		const form = new URLSearchParams()
		for (const [k, v] of Object.entries(body)) {
			form.set(k, String(v))
		}
		// Use user token for form calls (like conversations.replies)
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

	/**
	 * Get channel information from Slack API
	 * @param channelId - The channel ID
	 * @returns Promise with channel information
	 */
	async getChannelInfo(channelId: string): Promise<{ name: string; is_private: boolean } | null> {
		try {
			// First try conversations.info
			const response = await this.formCall("conversations.info", {
				channel: channelId
			}, this.getBotToken()!)

			
			if (response.ok && response.channel) {
				return {
					name: response.channel.name || response.channel.id,
					is_private: response.channel.is_private || false
				}
			}
			
			return null
		} catch (error) {
			console.warn("conversations.info failed, trying conversations.list:", error)
			
			// Fallback: try to get channel name from conversations.list
			try {
				const listResponse = await this.apiCall("conversations.list", {
					types: "public_channel,private_channel",
					limit: 1000
				}, this.getBotToken()!)

        // console.log("conversations.list response:", listResponse)
				
				if (listResponse.ok && listResponse.channels) {
					const channel = listResponse.channels.find((ch: any) => ch.id === channelId)
					if (channel) {
						return {
							name: channel.name || channelId,
							is_private: channel.is_private || false
						}
					}
				}
			} catch (listError) {
				console.warn("conversations.list also failed:", listError)
			}
			
			// Final fallback: try to construct channel name from ID
			return this.constructChannelNameFromId(channelId)
		}
	}

	/**
	 * Construct channel name from channel ID as fallback
	 * @param channelId - The channel ID
	 * @returns Channel information with constructed name
	 */
	private constructChannelNameFromId(channelId: string): { name: string; is_private: boolean } {
		// Channel IDs starting with 'C' are public channels
		// Channel IDs starting with 'G' are private channels/DMs
		if (channelId.startsWith('C')) {
			// For public channels, we can't determine the exact name without API access
			// but we can indicate it's a public channel
			return {
				name: `#channel-${channelId.slice(1, 9)}`, // Use part of ID as display name
				is_private: false
			}
		} else if (channelId.startsWith('G')) {
			return {
				name: `Private Channel ${channelId.slice(1, 9)}`,
				is_private: true
			}
		} else if (channelId.startsWith('D')) {
			return {
				name: `DM ${channelId.slice(1, 9)}`,
				is_private: true
			}
		}
		
		// Fallback for unknown channel types
		return {
			name: channelId,
			is_private: false
		}
	}

	/**
	 * Build Slack thread URL from channel and thread timestamp
	 * @param channelId - The channel ID
	 * @param threadTs - The thread timestamp
	 * @param channelName - The channel name (optional, for better URL formatting)
	 * @returns The full Slack thread URL
	 */
	buildThreadUrl(channelId: string, threadTs: string, channelName?: string): string {
		// Convert timestamp to format Slack expects in URLs
		const timestamp = threadTs.replace('.', '')
		const displayName = channelName || channelId
		
		return `https://minut.slack.com/archives/${displayName}/p${timestamp}`
	}
}
