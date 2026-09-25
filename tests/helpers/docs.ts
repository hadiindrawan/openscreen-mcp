import { readFileSync } from "node:fs";
import type { Clip, Doc } from "../../src/project/types";

const FIXTURE = new URL("../fixtures/real-project.openscreen", import.meta.url);

/** A project exactly as OpenScreen 1.12.2 saved it. */
export function realDoc(): Doc {
	return JSON.parse(readFileSync(FIXTURE, "utf8")) as Doc;
}

export const ASSET_ID = realDoc().assets[0]!.id;

export function clip(
	id: string,
	sourceStartSec: number,
	sourceEndSec: number,
	timelineStartSec: number,
): Clip {
	return {
		id,
		assetId: ASSET_ID,
		sourceStartSec,
		sourceEndSec,
		timelineStartSec,
		timelineEndSec: timelineStartSec + (sourceEndSec - sourceStartSec),
		wordRefs: [],
		origin: "user",
		reason: "",
	};
}

function withClips(clips: Clip[]): Doc {
	const doc = realDoc();
	doc.timeline.clips = clips;
	doc.timeline.trimRanges = [];
	doc.zoomRanges = [];
	doc.annotations = [];
	doc.legacyEditor = { ...(doc.legacyEditor ?? {}), speedRegions: [] };
	return doc;
}

/** One clip: timeline 0–30 s = source 0–30 s. */
export const singleClipDoc = (): Doc => withClips([clip("clip_a", 0, 30, 0)]);

/** Two clips of one recording: timeline 0–10 = source 0–10, timeline 10–20 = source 20–30. */
export const twoClipDoc = (): Doc =>
	withClips([clip("clip_a", 0, 10, 0), clip("clip_b", 20, 30, 10)]);
