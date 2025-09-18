#!/usr/bin/env ts-node

import "dotenv/config"
import { NotionService } from "./src/services/notionService"

/**
 * Test script to log Notion page content
 */
async function testNotionLogging() {
	console.log("🚀 Starting Notion page content logging test...")
	
	try {
		const notionService = new NotionService()
		
		// Test the connection first
		console.log("🔌 Testing Notion connection...")
		const connectionTest = await notionService.testConnection()
		
		if (!connectionTest) {
			console.error("❌ Failed to connect to Notion database")
			return
		}
		
		console.log("✅ Notion connection successful")
		
		// Log the Executive Team page content
		console.log("\n" + "=".repeat(80))
		console.log("📄 LOGGING EXECUTIVE TEAM PAGE CONTENT")
		console.log("=".repeat(80))
		
		await notionService.logPageContent("https://www.notion.so/minuthq/Executive-Team-1ff06c34379c80c090cad20b95da5541")
		
		console.log("\n🎉 Test completed successfully!")
		
	} catch (error) {
		console.error("❌ Test failed:", error)
	}
}

// Run the test
testNotionLogging().catch(console.error)
