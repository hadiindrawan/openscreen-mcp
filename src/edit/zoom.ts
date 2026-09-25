import type { Doc } from "../project/types";
import { createId } from "../vendor/shims";
import { assertNoOverlap, type EditResult } from "./regions";
import { anchorSpan, fragmentSpan, round3 } from "./timemap";

export type Depth = 1 | 2 | 3 | 4 | 5 | 6;
export type Focus = { cx: number; cy: number } | "cursor";
export type CursorFocus = (
	assetId: string,
	sourceStartSec: number,
	sourceEndSec: number,
) => { cx: number; cy: number } | null;

export interface ZoomInput {
	start: number;
	end: number;
	depth: Depth;
	focus?: Focus;
}

const CENTRE = { cx: 0.5, cy: 0.5 };

export function addZoom(doc: Doc, input: ZoomInput, cursorFocus: CursorFocus): EditResult {
	const fragments = anchorSpan(doc.timeline.clips, input.start, input.end);
	assertNoOverlap(doc, "zoom", fragments.map(fragmentSpan));
	const next = structuredClone(doc);
	const followCursor = input.focus === undefined || input.focus === "cursor";
	const ids = fragments.map((f) => {
		const id = createId("zoom");
		const focus =
			typeof input.focus === "object"
				? input.focus
				: (cursorFocus(f.assetId, f.sourceStartSec, f.sourceEndSec) ?? CENTRE);
		next.zoomRanges.push({
			id,
			startMs: f.startMs,
			endMs: f.endMs,
			clipId: f.clipId,
			sourceStartSec: f.sourceStartSec,
			sourceEndSec: f.sourceEndSec,
			depth: input.depth,
			focus: { cx: round3(focus.cx), cy: round3(focus.cy) },
			focusMode: followCursor ? "auto" : "manual",
			source: "manual",
		});
		return id;
	});
	return { doc: next, ids };
}
