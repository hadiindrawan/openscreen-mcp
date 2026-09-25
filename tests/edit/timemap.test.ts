import { describe, expect, it } from "vitest";
import {
	anchorSpan,
	type ClipLike,
	regionSpanSec,
	sourceSpanToTimeline,
	sourceToTimeline,
	timelineDurationSec,
	timelineToSource,
	trimSpanSec,
} from "../../src/edit/timemap";
import { ToolError } from "../../src/errors";

const A = "asset_a";
const single: ClipLike[] = [
	{ id: "c1", assetId: A, sourceStartSec: 0, sourceEndSec: 30, timelineStartSec: 0, timelineEndSec: 30 },
];
const two: ClipLike[] = [
	{ id: "c1", assetId: A, sourceStartSec: 0, sourceEndSec: 10, timelineStartSec: 0, timelineEndSec: 10 },
	{ id: "c2", assetId: A, sourceStartSec: 20, sourceEndSec: 30, timelineStartSec: 10, timelineEndSec: 20 },
];
const duplicated: ClipLike[] = [
	{ id: "c1", assetId: A, sourceStartSec: 0, sourceEndSec: 10, timelineStartSec: 0, timelineEndSec: 10 },
	{ id: "c3", assetId: A, sourceStartSec: 0, sourceEndSec: 10, timelineStartSec: 10, timelineEndSec: 20 },
];

describe("anchorSpan", () => {
	it("anchors a span inside one clip", () => {
		expect(anchorSpan(single, 2, 4)).toEqual([
			{ clipId: "c1", assetId: A, sourceStartSec: 2, sourceEndSec: 4, startMs: 2000, endMs: 4000 },
		]);
	});

	it("splits a span across clips into one fragment per clip", () => {
		expect(anchorSpan(two, 8, 12)).toEqual([
			{ clipId: "c1", assetId: A, sourceStartSec: 8, sourceEndSec: 10, startMs: 8000, endMs: 10000 },
			{ clipId: "c2", assetId: A, sourceStartSec: 20, sourceEndSec: 22, startMs: 10000, endMs: 12000 },
		]);
	});

	it("ignores a clip the span only touches", () => {
		expect(anchorSpan(two, 10, 12).map((f) => f.clipId)).toEqual(["c2"]);
	});

	it("rejects a span outside the timeline", () => {
		expect(() => anchorSpan(single, 40, 45)).toThrow(ToolError);
		expect(() => anchorSpan(single, 40, 45)).toThrow("outside the timeline (0–30s)");
	});

	it("rejects an empty or reversed span", () => {
		expect(() => anchorSpan(single, 4, 4)).toThrow(/must be after start/);
		expect(() => anchorSpan(single, 5, 2)).toThrow(/must be after start/);
	});
});

describe("source ↔ timeline", () => {
	it("maps a source time onto the clip that plays it", () => {
		expect(sourceToTimeline(two, A, 25)).toEqual([15]);
		expect(sourceToTimeline(two, A, 15)).toEqual([]);
	});

	it("maps a source time onto every clip that replays it", () => {
		expect(sourceToTimeline(duplicated, A, 5)).toEqual([5, 15]);
	});

	it("maps a source span per clip, clamped to each clip", () => {
		expect(sourceSpanToTimeline(two, A, 8, 22)).toEqual([
			{ start: 8, end: 10 },
			{ start: 10, end: 12 },
		]);
	});

	it("maps a timeline time back to its clip and source time", () => {
		expect(timelineToSource(two, 15)).toEqual({ clip: two[1], sourceSec: 25 });
		expect(timelineToSource(two, 20)).toEqual({ clip: two[1], sourceSec: 30 });
		expect(timelineToSource(two, 25)).toBeNull();
	});

	it("measures the timeline", () => {
		expect(timelineDurationSec(two)).toBe(20);
	});
});

describe("region spans", () => {
	it("prefers the clip anchor over the stale ms cache", () => {
		expect(
			regionSpanSec(two, { clipId: "c2", sourceStartSec: 21, sourceEndSec: 23, startMs: 0, endMs: 1 }),
		).toEqual({ start: 11, end: 13 });
	});

	it("falls back to startMs/endMs without an anchor", () => {
		expect(regionSpanSec(two, { startMs: 1500, endMs: 2500 })).toEqual({ start: 1.5, end: 2.5 });
	});

	it("places anchored and unanchored trims on the timeline", () => {
		expect(trimSpanSec(two, { assetId: A, clipId: "c2", startSec: 25, endSec: 27 })).toEqual({
			start: 15,
			end: 17,
		});
		expect(trimSpanSec(two, { assetId: A, startSec: 5, endSec: 6 })).toEqual({ start: 5, end: 6 });
		expect(trimSpanSec(two, { assetId: A, clipId: "gone", startSec: 5, endSec: 6 })).toBeNull();
	});
});
