import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { addBlur, addText, TEXT_ANIMATIONS } from "./edit/annotate";
import { cutRange } from "./edit/cut";
import { removeRegion } from "./edit/regions";
import { MAX_SPEED, MIN_SPEED, setSpeed } from "./edit/speed";
import { updateRegion } from "./edit/update";
import { addZoom, type Depth } from "./edit/zoom";
import { ToolError } from "./errors";
import type { ToolContext } from "./tools/context";
import { applyEdit, undoEdit } from "./tools/edit";
import { analyze, describe, frames, listProjects, SIGNALS, transcribe } from "./tools/understand";

const INSTRUCTIONS = `Edits OpenScreen screen-recording projects on this Mac.
Workflow: list_projects (or use "latest") → describe_project → analyze_recording (clicks, cursor dwells, idle stretches, scene changes, speech) → get_frames to look at the moments that matter → edit.
All times are timeline seconds as shown in the OpenScreen editor; cut sections keep their place on that timeline, so times from analyze_recording can be passed straight to edit tools.
Edits fail while the OpenScreen app is running: ask the user to quit it (⌘Q). After editing, tell the user to reopen the project in OpenScreen to preview and export.
undo_last_edit reverts the most recent edit made through this server.`;

const project = z.string().default("latest").describe('Project id from list_projects, or "latest".');
const sec = z.number().nonnegative();
const span = {
	project,
	start: sec.describe("Start, in timeline seconds."),
	end: sec.describe("End, in timeline seconds."),
};
const point = z.object({ cx: z.number().min(0).max(1), cy: z.number().min(0).max(1) });
const focus = z
	.union([point, z.literal("cursor")])
	.describe('{cx, cy} as 0–1 fractions of the frame, or "cursor" to aim at where the cursor is.');
const depth = z.number().int().min(1).max(6).describe("Zoom depth 1–6 (1.25× to 5×).");

function json(value: unknown): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function guarded<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
	return async (args) => {
		try {
			return await fn(args);
		} catch (error) {
			if (error instanceof ToolError) {
				return { content: [{ type: "text", text: error.message }], isError: true };
			}
			console.error(error);
			return {
				content: [{ type: "text", text: `Unexpected error: ${(error as Error).message}` }],
				isError: true,
			};
		}
	};
}

export function createServer(ctx: ToolContext): McpServer {
	const server = new McpServer({ name: "openscreen", version: "0.1.0" }, { instructions: INSTRUCTIONS });

	server.registerTool(
		"list_projects",
		{ description: "List OpenScreen projects on this Mac, newest first, with duration and edit counts.", inputSchema: {} },
		guarded(async () => json(await listProjects(ctx))),
	);

	server.registerTool(
		"describe_project",
		{
			description: "Summarize a project: clips, cuts, zooms, text, blur and speed regions with their ids and timeline times.",
			inputSchema: { project },
		},
		guarded(async (a) => json(await describe(ctx, a.project))),
	);

	server.registerTool(
		"analyze_recording",
		{
			description:
				"Timeline of what happens in the recording: clicks (screen position as 0–1 fractions), dwells (cursor resting ≥ 1.5 s), idle stretches (no movement or clicks for ≥ 2 s — good cut candidates), scene changes, and speech (after transcribe). Call before editing.",
			inputSchema: {
				project,
				include: z.array(z.enum(SIGNALS)).optional().describe("Signals to include; default all."),
			},
		},
		guarded(async (a) => json(await analyze(ctx, a.project, a.include ?? SIGNALS))),
	);

	server.registerTool(
		"get_frames",
		{
			description:
				"Screenshots of the recording at given timeline seconds, or at every click / scene change / evenly spaced. Each image comes with a caption of nearby events. At most 12 per call.",
			inputSchema: {
				project,
				times: z.array(sec).optional().describe("Timeline seconds to capture."),
				at: z.enum(["clicks", "scenes", "evenly"]).optional().describe("Pick times automatically (used when times is empty)."),
				max: z.number().int().min(1).max(12).default(8),
			},
		},
		guarded(async (a) => {
			const list = await frames(ctx, a.project, { times: a.times, at: a.at, max: a.max });
			return {
				content: list.flatMap((f) => [
					{ type: "text" as const, text: f.caption },
					{ type: "image" as const, data: f.jpeg.toString("base64"), mimeType: "image/jpeg" },
				]),
			};
		}),
	);

	server.registerTool(
		"transcribe",
		{
			description:
				"Transcribe the recording's voice on-device with Whisper (slow the first time, then cached). Needed before analyze_recording can include speech.",
			inputSchema: { project },
		},
		guarded(async (a) => json(await transcribe(ctx, a.project))),
	);

	server.registerTool(
		"add_zoom",
		{
			description: "Zoom in between start and end. Focus defaults to following the cursor.",
			inputSchema: { ...span, depth, focus: focus.optional() },
		},
		guarded(async (a) =>
			json(await applyEdit(ctx, a.project, (doc, cursorFocus) =>
				addZoom(doc, { start: a.start, end: a.end, depth: a.depth as Depth, focus: a.focus }, cursorFocus),
			)),
		),
	);

	server.registerTool(
		"cut_range",
		{
			description: "Remove the footage between start and end. Reversible with remove_region on the returned id.",
			inputSchema: { ...span, reason: z.string().default("").describe("Why it was cut (shown in OpenScreen).") },
		},
		guarded(async (a) =>
			json(await applyEdit(ctx, a.project, (doc) => cutRange(doc, { start: a.start, end: a.end, reason: a.reason }))),
		),
	);

	server.registerTool(
		"add_text",
		{
			description: "Show a text caption/title between start and end.",
			inputSchema: {
				...span,
				text: z.string().min(1),
				placement: z
					.union([
						z.enum(["top", "center", "bottom"]),
						z.object({ x: z.number().min(0).max(99), y: z.number().min(0).max(99) }),
					])
					.optional()
					.describe('"top" | "center" | "bottom" (default) or {x, y} top-left corner in percent of the frame.'),
				fontSize: z.number().positive().optional(),
				color: z.string().optional().describe("CSS colour, default #ffffff."),
				background: z.string().optional().describe('CSS colour behind the text, default "transparent".'),
				animation: z.enum(TEXT_ANIMATIONS).optional(),
			},
		},
		guarded(async (a) =>
			json(await applyEdit(ctx, a.project, (doc) =>
				addText(doc, {
					start: a.start,
					end: a.end,
					text: a.text,
					placement: a.placement,
					fontSize: a.fontSize,
					color: a.color,
					background: a.background,
					animation: a.animation,
				}),
			)),
		),
	);

	server.registerTool(
		"add_blur",
		{
			description:
				"Blur or pixelate a rectangle between start and end, e.g. to hide an email address or API key. rect is in percent of the frame (x, y = top-left corner).",
			inputSchema: {
				...span,
				rect: z.object({
					x: z.number().min(0).max(100),
					y: z.number().min(0).max(100),
					width: z.number().positive().max(100),
					height: z.number().positive().max(100),
				}),
				style: z.enum(["blur", "mosaic"]).optional(),
				shape: z.enum(["rectangle", "oval"]).optional(),
			},
		},
		guarded(async (a) =>
			json(await applyEdit(ctx, a.project, (doc) =>
				addBlur(doc, { start: a.start, end: a.end, rect: a.rect, style: a.style, shape: a.shape }),
			)),
		),
	);

	server.registerTool(
		"set_speed",
		{
			description: `Play start–end at a different speed (${MIN_SPEED}–${MAX_SPEED}; 2 = twice as fast, 0.5 = slow motion).`,
			inputSchema: { ...span, speed: z.number().min(MIN_SPEED).max(MAX_SPEED) },
		},
		guarded(async (a) =>
			json(await applyEdit(ctx, a.project, (doc) => setSpeed(doc, { start: a.start, end: a.end, speed: a.speed }))),
		),
	);

	server.registerTool(
		"update_region",
		{
			description:
				"Change a zoom, cut, text, blur or speed region by id: new start/end plus fields for its kind (depth/focus for zooms, text/fontSize/color for text, speed for speed, reason for cuts). Fields that don't apply are ignored.",
			inputSchema: {
				project,
				id: z.string().min(1),
				start: sec.optional(),
				end: sec.optional(),
				depth: depth.optional(),
				focus: focus.optional(),
				text: z.string().optional(),
				fontSize: z.number().positive().optional(),
				color: z.string().optional(),
				speed: z.number().min(MIN_SPEED).max(MAX_SPEED).optional(),
				reason: z.string().optional(),
			},
		},
		guarded(async (a) =>
			json(await applyEdit(ctx, a.project, (doc, cursorFocus) =>
				updateRegion(doc, { ...a, depth: a.depth as Depth | undefined }, cursorFocus),
			)),
		),
	);

	server.registerTool(
		"remove_region",
		{
			description: "Delete a zoom, cut, text, blur or speed region by id. Removing a cut restores that footage.",
			inputSchema: { project, id: z.string().min(1) },
		},
		guarded(async (a) => json(await applyEdit(ctx, a.project, (doc) => removeRegion(doc, a.id)))),
	);

	server.registerTool(
		"undo_last_edit",
		{
			description: "Revert the most recent edit this server made to the project (repeat to go further back, up to 20).",
			inputSchema: { project },
		},
		guarded(async (a) => json(await undoEdit(ctx, a.project))),
	);

	return server;
}
