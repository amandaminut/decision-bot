import "dotenv/config"
import express from "express"
import { healthCheck } from "./routes/health"
import { SlackEventsHandler } from "./routes/slackEvents"

const app = express()

// Middleware
app.use(express.json())

// Routes
app.get("/health", healthCheck)

// Slack events handler
const slackEventsHandler = new SlackEventsHandler()
app.post("/slack/events", (req, res) => {
	slackEventsHandler.handleEvents(req as any, res)
})

// Start server
const port = process.env.PORT || 3000
app.listen(port, () => {
	console.log(`Server listening on port ${port}`)
})

export default app