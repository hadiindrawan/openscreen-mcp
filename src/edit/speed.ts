import { ToolError } from "../errors";
import type { Doc, SpeedRegion } from "../project/types";
import { createId } from "../vendor/shims";
import { assertNoOverlap, type EditResult } from "./regions";
import { anchorSpan, fragmentSpan } from "./timemap";

export const MIN_SPEED = 0.1;
// Above 16× Chromium cannot play natively and OpenScreen's preview falls back to frame-stepping.
export const MAX_SPEED = 16;

export function checkSpeed(speed: number): number {
	if (!(speed >= MIN_SPEED && speed <= MAX_SPEED)) {
		throw new ToolError(`speed must be between ${MIN_SPEED} and ${MAX_SPEED} (got ${speed}).`);
	}
	return Math.round(speed * 100) / 100;
}

export interface SpeedInput {
	start: number;
	end: number;
	speed: number;
}

export function setSpeed(doc: Doc, input: SpeedInput): EditResult {
	const speed = checkSpeed(input.speed);
	const fragments = anchorSpan(doc.timeline.clips, input.start, input.end);
	assertNoOverlap(doc, "speed", fragments.map(fragmentSpan));
	const next = structuredClone(doc);
	const legacy = (next.legacyEditor ??= {});
	if (!Array.isArray(legacy.speedRegions)) legacy.speedRegions = [];
	const list = legacy.speedRegions as SpeedRegion[];
	const ids = fragments.map((f) => {
		const id = createId("speed");
		list.push({
			id,
			startMs: f.startMs,
			endMs: f.endMs,
			speed,
			clipId: f.clipId,
			sourceStartSec: f.sourceStartSec,
			sourceEndSec: f.sourceEndSec,
		});
		return id;
	});
	return { doc: next, ids };
}
