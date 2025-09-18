/**
 * Utility functions for string manipulation
 */

/**
 * Escape pipe characters for markdown table formatting
 * @param text - Text to escape
 * @returns Escaped text
 */
export function escapePipes(text: string): string {
	return String(text).replace(/\|/g, "\\|")
}

/**
 * Extract a title from text (fallback method)
 * @param text - Text to extract title from
 * @returns Extracted title
 */
export function extractTitleFallback(text: string): string {
	const first =
		text
			.split(/\n|\./)
			.map((s) => s.trim())
			.find(Boolean) || "Decision"
	return first.slice(0, 80)
}

/**
 * Extract a summary from text (fallback method)
 * @param text - Text to extract summary from
 * @returns Extracted summary
 */
export function extractSummaryFallback(text: string): string {
	let s = text.replace(/\s+/g, " ").trim()
	if (s.length > 180) s = s.slice(0, 177) + "..."
	return s || "Summary TBD"
}
