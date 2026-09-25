/** A failure the user or Claude can act on. The message is shown verbatim as the tool result. */
export class ToolError extends Error {
	override name = "ToolError";
}
