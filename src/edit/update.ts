import { ToolError } from "../errors";
import type { Doc } from "../project/types";
import { assertNoOverlap, type EditResult, findRegion, regionNotFound, speedRegions } from "./regions";
import { checkSpeed } from "./speed";
import { anchorSpan, fragmentSpan, round3 } from "./timemap";
import type { CursorFocus, Depth, Focus } from "./zoom";

export interface UpdateInput {
	id: string;
	start?: number;
	end?: number;
	depth?: Depth;
	focus?: Focus;
	text?: string;
	fontSize?: number;
	color?: string;
	speed?: number;
	reason?: string;
}

/** Patches one region fragment in place, so fields this server does not know survive. */
export function updateRegion(doc: Doc, input: UpdateInput, cursorFocus: CursorFocus): EditResult {
	const ref = findRegion(doc, input.id);
	if (!ref) throw regionNotFound(input.id);
	if (!ref.span) {
		throw new ToolError(`Region ${input.id} is no longer on the timeline (its clip was removed). Remove it instead.`);
	}
	const fragments = anchorSpan(doc.timeline.clips, input.start ?? ref.span.start, input.end ?? ref.span.end);
	if (fragments.length !== 1) {
		throw new ToolError("An update cannot make a region cross a clip boundary. Remove it and add it again instead.");
	}
	const f = fragments[0]!;
	if (ref.kind !== "cut") assertNoOverlap(doc, ref.kind, [fragmentSpan(f)], input.id);
	const anchor = {
		startMs: f.startMs,
		endMs: f.endMs,
		clipId: f.clipId,
		sourceStartSec: f.sourceStartSec,
		sourceEndSec: f.sourceEndSec,
	};
	const next = structuredClone(doc);
	switch (ref.kind) {
		case "zoom": {
			const zoom = next.zoomRanges.find((z) => z.id === input.id)!;
			Object.assign(zoom, anchor);
			if (input.depth) zoom.depth = input.depth;
			if (input.focus === "cursor") {
				const focus = cursorFocus(f.assetId, f.sourceStartSec, f.sourceEndSec) ?? zoom.focus;
				zoom.focus = { cx: round3(focus.cx), cy: round3(focus.cy) };
				zoom.focusMode = "auto";
			} else if (input.focus) {
				zoom.focus = { cx: round3(input.focus.cx), cy: round3(input.focus.cy) };
				zoom.focusMode = "manual";
			}
			break;
		}
		case "text":
		case "blur": {
			const annotation = next.annotations.find((a) => a.id === input.id)!;
			Object.assign(annotation, anchor);
			if (input.text !== undefined && ref.kind === "text") {
				annotation.content = input.text;
				annotation.textContent = input.text;
			}
			if (input.fontSize !== undefined) annotation.style.fontSize = input.fontSize;
			if (input.color !== undefined) annotation.style.color = input.color;
			break;
		}
		case "speed": {
			const region = speedRegions(next).find((s) => s.id === input.id)!;
			Object.assign(region, anchor);
			if (input.speed !== undefined) region.speed = checkSpeed(input.speed);
			break;
		}
		case "cut": {
			const trim = next.timeline.trimRanges.find((t) => t.id === input.id)!;
			Object.assign(trim, {
				assetId: f.assetId,
				clipId: f.clipId,
				startSec: f.sourceStartSec,
				endSec: f.sourceEndSec,
			});
			if (input.reason !== undefined) trim.reason = input.reason;
			break;
		}
	}
	return { doc: next, ids: [input.id] };
}
