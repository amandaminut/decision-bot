import { Request, Response } from "express"

/**
 * Health check route handler
 * @param req - Express request object
 * @param res - Express response object
 */
export function healthCheck(req: Request, res: Response): void {
	res.json({
		status: "healthy",
		timestamp: new Date().toISOString(),
		uptime: process.uptime(),
		environment: process.env.NODE_ENV || "development",
	})
}
