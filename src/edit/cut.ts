import type { Doc } from "../project/types";
import { createId } from "../vendor/shims";
import type { EditResult } from "./regions";
import { anchorSpan } from "./timemap";

export interface CutInput {
	start: number;
	end: number;
	reason: string;
}

/** Cuts may overlap existing cuts: OpenScreen merges them. */
export function cutRange(doc: Doc, input: CutInput): EditResult {
	const fragments = anchorSpan(doc.timeline.clips, input.start, input.end);
	const next = structuredClone(doc);
	const ids = fragments.map((f) => {
		const id = createId("trim");
		next.timeline.trimRanges.push({
			id,
			assetId: f.assetId,
			clipId: f.clipId,
			startSec: f.sourceStartSec,
			endSec: f.sourceEndSec,
			reason: input.reason,
			origin: "agent",
		});
		return id;
	});
	return { doc: next, ids };
}
