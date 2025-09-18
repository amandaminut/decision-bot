import crypto from "crypto"
import { ExtendedRequest } from "../types"

/**
 * Middleware for verifying Slack request signatures
 */
export class SlackVerification {
	private signingSecret: string | undefined

	constructor() {
		this.signingSecret = process.env.SLACK_SIGNING_SECRET
	}

	/**
	 * Verify Slack request signature
	 * @param req - Express request object
	 * @returns True if signature is valid
	 */
	verify(req: ExtendedRequest): boolean {
		if (!this.signingSecret) {
			console.warn("SLACK_SIGNING_SECRET not configured")
			return false
		}

		const ts = req.headers["x-slack-request-timestamp"] as string
		const sig = req.headers["x-slack-signature"] as string

		if (!ts || !sig) {
			return false
		}

		// Prevent replay attacks (5 minute window)
		if (Math.abs(Date.now() / 1000 - Number(ts)) > 60 * 5) {
			return false
		}

		// Verify signature
		const basestring = `v0:${ts}:${JSON.stringify(req.body)}`
		const hmac = crypto
			.createHmac("sha256", this.signingSecret)
			.update(basestring)
			.digest("hex")
		const expected = `v0=${hmac}`

		return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
	}
}
