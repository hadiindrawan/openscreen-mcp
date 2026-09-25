import { basename } from "node:path";
import { speedRegions } from "./edit/regions";
import {
	clipSourceEnd,
	regionSpanSec,
	round3,
	type Span,
	timelineDurationSec,
	trimSpanSec,
} from "./edit/timemap";
import type { Doc } from "./project/types";

export function unionLength(spans: Span[]): number {
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	let total = 0;
	let current: Span | null = null;
	for (const span of sorted) {
		if (current && span.start <= current.end) {
			current.end = Math.max(current.end, span.end);
		} else {
			if (current) total += current.end - current.start;
			current = { ...span };
		}
	}
	if (current) total += current.end - current.start;
	return round3(total);
}

export function describeProject(doc: Doc) {
	const clips = doc.timeline.clips;
	const durationSec = round3(timelineDurationSec(clips));
	const cuts = doc.timeline.trimRanges.map((t) => {
		const span = trimSpanSec(clips, t);
		return { id: t.id, start: span?.start ?? null, end: span?.end ?? null, reason: t.reason };
	});
	const cutSpans = doc.timeline.trimRanges
		.map((t) => trimSpanSec(clips, t))
		.filter((s): s is Span => s !== null);
	return {
		id: doc.project.id,
		title: doc.project.title,
		timeUnit: "timeline seconds (cut sections still occupy their place)",
		durationSec,
		keptDurationSec: round3(durationSec - unionLength(cutSpans)),
		clips: clips.map((c) => ({
			id: c.id,
			start: c.timelineStartSec,
			end: c.timelineEndSec,
			sourceStart: c.sourceStartSec,
			sourceEnd: clipSourceEnd(c),
			video: basename(doc.assets.find((a) => a.id === c.assetId)?.originalPath ?? "?"),
		})),
		cuts,
		zooms: doc.zoomRanges.map((z) => ({
			id: z.id,
			...regionSpanSec(clips, z),
			depth: z.depth,
			focus: z.focus,
			focusMode: z.focusMode ?? "manual",
		})),
		texts: doc.annotations
			.filter((a) => a.type === "text")
			.map((a) => ({ id: a.id, ...regionSpanSec(clips, a), text: a.textContent ?? a.content })),
		blurs: doc.annotations
			.filter((a) => a.type === "blur")
			.map((a) => ({
				id: a.id,
				...regionSpanSec(clips, a),
				rect: { ...a.position, ...a.size },
				style: a.blurData?.type ?? "mosaic",
			})),
		speeds: speedRegions(doc).map((s) => ({ id: s.id, ...regionSpanSec(clips, s), speed: s.speed })),
	};
}

export type ProjectDescription = ReturnType<typeof describeProject>;
