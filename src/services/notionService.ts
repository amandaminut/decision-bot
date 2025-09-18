import "dotenv/config"
import { Client } from "@notionhq/client"
import { NotionDatabaseEntry, NotionOperationResult } from "../types"

/**
 * Service for interacting with Notion database
 */
export class NotionService {
	private notion: Client
	private databaseId: string

	constructor() {
		const apiKey = process.env.NOTION_API_KEY
		this.databaseId = process.env.NOTION_DATABASE || ""

		if (!apiKey) {
			throw new Error("NOTION_API_KEY environment variable is required")
		}

		if (!this.databaseId) {
			throw new Error("NOTION_DATABASE_ID environment variable is required")
		}

		this.notion = new Client({
			auth: apiKey,
		})

		// Test connection and log schema on startup
		this.testConnection().catch(console.error)
	}

	/**
	 * Add a decision entry to the Notion database
	 * @param entry - The decision data to add
	 * @returns Promise<NotionOperationResult>
	 */
	async addDecision(entry: NotionDatabaseEntry): Promise<NotionOperationResult> {
		try {
			// First, get the database schema to understand the property types
			const database = await this.notion.databases.retrieve({
				database_id: this.databaseId,
			})

			// Build properties dynamically based on what exists in the database
			const properties: any = {}

			// Handle title property - try both title and rich_text types
			if (database.properties.title) {
				if (database.properties.title.type === 'title') {
					properties.title = {
						title: [{ text: { content: entry.title } }]
					}
				} else if (database.properties.title.type === 'rich_text') {
					properties.title = {
						rich_text: [{ text: { content: entry.title } }]
					}
				}
			}

			// Handle summary property
			if (database.properties.summary) {
				properties.summary = {
					rich_text: [{ text: { content: entry.summary } }]
				}
			}

			// Handle tag property (only if it exists)
			if (database.properties.tag) {
				properties.tag = {
					rich_text: [{ text: { content: entry.tag } }]
				}
			}

			// Handle slack_thread property
			if (database.properties.slack_thread) {
				properties.slack_thread = {
					rich_text: [{ text: { content: entry.slack_thread } }]
				}
			}

			// Handle slack_channel property
			if (database.properties.slack_channel) {
				properties.slack_channel = {
					rich_text: [{ text: { content: entry.slack_channel } }]
				}
			}

			// Handle date_timestamp property (only if it exists and is a date type)
			if (database.properties.date_timestamp && database.properties.date_timestamp.type === 'date') {
				properties.date_timestamp = {
					date: { start: entry.date_timestamp }
				}
			}

			const response = await this.notion.pages.create({
				parent: {
					database_id: this.databaseId,
				},
				properties,
			})

			console.log("✅ Decision added successfully to Notion database")
			console.log("🆔 New page ID:", response.id)

			return {
				success: true,
				page_id: response.id,
			}
		} catch (error) {
			console.error("Error adding decision to Notion:", error)
			return {
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			}
		}
	}

	/**
	 * Retrieve and log the content of a specific Notion page
	 * @param pageUrl - The full URL of the Notion page
	 * @returns Promise<void>
	 */
	async logPageContent(pageUrl: string): Promise<void> {
		try {
			// Extract page ID from the URL
			// URL format: https://www.notion.so/workspace/Page-Title-{pageId}
			const pageIdMatch = pageUrl.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i)
			
			if (!pageIdMatch) {
				console.error("❌ Could not extract page ID from URL:", pageUrl)
				return
			}

			const pageId = pageIdMatch[1]
			console.log("📄 Fetching Notion page content...")
			console.log("🔗 Page URL:", pageUrl)
			console.log("🆔 Page ID:", pageId)

			// Retrieve the page
			const page = await this.notion.pages.retrieve({
				page_id: pageId,
			})

			console.log("📋 Page retrieved successfully:")
			console.log("📊 Page Properties:", JSON.stringify('properties' in page ? page.properties : page, null, 2))

			// Retrieve the page content (blocks)
			const blocks = await this.notion.blocks.children.list({
				block_id: pageId,
			})

			console.log("🧱 Page Blocks:")
			console.log(JSON.stringify(blocks.results, null, 2))

			// Format and display readable content
			console.log("\n" + "=".repeat(80))
			console.log("📖 PAGE CONTENT SUMMARY")
			console.log("=".repeat(80))
			
			// Check if page has properties (full page response)
			if ('properties' in page && page.properties && typeof page.properties === 'object') {
				const props = page.properties as any
				
				// Display title
				if (props.title?.title?.[0]?.text?.content) {
					console.log("📌 Title:", props.title.title[0].text.content)
				}
				
				// Display other text properties
				Object.entries(props).forEach(([key, value]: [string, any]) => {
					if (key !== 'title' && value?.rich_text?.[0]?.text?.content) {
						console.log(`📝 ${key}:`, value.rich_text[0].text.content)
					}
				})
			} else {
				console.log("📄 Page type:", page.object)
				if ('title' in page && page.title) {
					console.log("📌 Page title:", page.title)
				}
			}

			// Display block content
			if (blocks.results.length > 0) {
				console.log("\n📄 Content Blocks:")
				blocks.results.forEach((block: any, index: number) => {
					console.log(`\nBlock ${index + 1} (${block.type}):`)
					
					if (block.paragraph?.rich_text?.[0]?.text?.content) {
						console.log("  ", block.paragraph.rich_text[0].text.content)
					} else if (block.heading_1?.rich_text?.[0]?.text?.content) {
						console.log("  #", block.heading_1.rich_text[0].text.content)
					} else if (block.heading_2?.rich_text?.[0]?.text?.content) {
						console.log("  ##", block.heading_2.rich_text[0].text.content)
					} else if (block.heading_3?.rich_text?.[0]?.text?.content) {
						console.log("  ###", block.heading_3.rich_text[0].text.content)
					} else if (block.bulleted_list_item?.rich_text?.[0]?.text?.content) {
						console.log("  •", block.bulleted_list_item.rich_text[0].text.content)
					} else if (block.numbered_list_item?.rich_text?.[0]?.text?.content) {
						console.log("  1.", block.numbered_list_item.rich_text[0].text.content)
					} else {
						console.log("  ", JSON.stringify(block, null, 4))
					}
				})
			}

			console.log("=".repeat(80))
			console.log("✅ Page content logged successfully")

		} catch (error) {
			console.error("❌ Error retrieving Notion page content:", error)
			if (error instanceof Error) {
				console.error("Error details:", error.message)
			}
		}
	}

	/**
	 * Test the connection to Notion and log database schema
	 * @returns Promise<boolean>
	 */
	async testConnection(): Promise<boolean> {
		try {
			const database = await this.notion.databases.retrieve({
				database_id: this.databaseId,
			})
			
			
			return true
		} catch (error) {
			console.error("Notion connection test failed:", error)
			return false
		}
	}
}
