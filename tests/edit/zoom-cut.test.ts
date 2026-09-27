import { describe, expect, it } from "vitest";
import { cutRange } from "../../src/edit/cut";
import { allRegions, removeRegion } from "../../src/edit/regions";
import { addZoom } from "../../src/edit/zoom";
import { ToolError } from "../../src/errors";
import { documentSchema } from "../../src/vendor/openscreen-schema";
import { ASSET_ID, singleClipDoc, twoClipDoc } from "../helpers/docs";

const noCursor = () => null;
const valid = (doc: unknown) => documentSchema.safeParse(doc).error?.issues ?? [];

describe("addZoom", () => {
	it("anchors the zoom and focuses on the cursor", () => {
		const { doc, ids } = addZoom(singleClipDoc(), { start: 2, end: 4, depth: 3 }, () => ({ cx: 0.25, cy: 0.75 }));
		expect(ids).toHaveLength(1);
		expect(ids[0]).toMatch(/^zoom_/);
		expect(doc.zoomRanges[0]).toEqual({
			id: ids[0],
			startMs: 2000,
			endMs: 4000,
			clipId: "clip_a",
			sourceStartSec: 2,
			sourceEndSec: 4,
			depth: 3,
			focus: { cx: 0.25, cy: 0.75 },
			focusMode: "auto",
			source: "manual",
		});
		expect(valid(doc)).toEqual([]);
	});

	it("falls back to the frame centre without cursor data", () => {
		const { doc } = addZoom(singleClipDoc(), { start: 2, end: 4, depth: 2 }, noCursor);
		expect(doc.zoomRanges[0]!.focus).toEqual({ cx: 0.5, cy: 0.5 });
	});

	it("uses a manual focus point as given", () => {
		const { doc } = addZoom(singleClipDoc(), { start: 2, end: 4, depth: 2, focus: { cx: 0.1, cy: 0.9 } }, noCursor);
		expect(doc.zoomRanges[0]).toMatchObject({ focus: { cx: 0.1, cy: 0.9 }, focusMode: "manual" });
	});

	it("stores one fragment per clip", () => {
		const { doc, ids } = addZoom(twoClipDoc(), { start: 8, end: 12, depth: 4 }, noCursor);
		expect(ids).toHaveLength(2);
		expect(doc.zoomRanges.map((z) => z.clipId)).toEqual(["clip_a", "clip_b"]);
		expect(valid(doc)).toEqual([]);
	});

	it("rejects a zoom overlapping another zoom", () => {
		const first = addZoom(singleClipDoc(), { start: 2, end: 4, depth: 3 }, noCursor);
		expect(() => addZoom(first.doc, { start: 3, end: 5, depth: 3 }, noCursor)).toThrow(ToolError);
		expect(() => addZoom(first.doc, { start: 3, end: 5, depth: 3 }, noCursor)).toThrow(
			`overlaps zoom ${first.ids[0]}`,
		);
	});

	it("allows zooms that only touch", () => {
		const first = addZoom(singleClipDoc(), { start: 2, end: 4, depth: 3 }, noCursor);
		expect(() => addZoom(first.doc, { start: 4, end: 6, depth: 3 }, noCursor)).not.toThrow();
	});

	it("does not modify its input", () => {
		const input = singleClipDoc();
		addZoom(input, { start: 2, end: 4, depth: 3 }, noCursor);
		expect(input.zoomRanges).toEqual([]);
	});
});

describe("cutRange", () => {
	it("adds a clip-anchored trim in source seconds", () => {
		const { doc, ids } = cutRange(singleClipDoc(), { start: 5, end: 7, reason: "idle" });
		expect(doc.timeline.trimRanges).toEqual([
			{ id: ids[0], assetId: ASSET_ID, clipId: "clip_a", startSec: 5, endSec: 7, reason: "idle", origin: "agent" },
		]);
		expect(valid(doc)).toEqual([]);
	});

	it("converts timeline seconds to each clip's source seconds", () => {
		const { doc } = cutRange(twoClipDoc(), { start: 12, end: 14, reason: "x" });
		expect(doc.timeline.trimRanges[0]).toMatchObject({ clipId: "clip_b", startSec: 22, endSec: 24 });
	});

	it("allows overlapping cuts", () => {
		const first = cutRange(singleClipDoc(), { start: 5, end: 7, reason: "a" });
		expect(() => cutRange(first.doc, { start: 6, end: 8, reason: "b" })).not.toThrow();
	});
});

describe("removeRegion", () => {
	it("removes a region by id and reports its kind", () => {
		const { doc, ids } = cutRange(singleClipDoc(), { start: 5, end: 7, reason: "idle" });
		const removed = removeRegion(doc, ids[0]!);
		expect(removed.doc.timeline.trimRanges).toEqual([]);
		expect(allRegions(removed.doc)).toEqual([]);
	});

	it("rejects an unknown id", () => {
		expect(() => removeRegion(singleClipDoc(), "zoom_nope")).toThrow(/No zoom, cut, text, blur, speed or sound region/);
	});
});
