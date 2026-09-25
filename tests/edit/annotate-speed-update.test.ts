import { describe, expect, it } from "vitest";
import { addBlur, addText, blurAnnotation } from "../../src/edit/annotate";
import { cutRange } from "../../src/edit/cut";
import { speedRegions } from "../../src/edit/regions";
import { setSpeed } from "../../src/edit/speed";
import { updateRegion } from "../../src/edit/update";
import { addZoom } from "../../src/edit/zoom";
import { documentSchema } from "../../src/vendor/openscreen-schema";
import { singleClipDoc, twoClipDoc } from "../helpers/docs";

const noCursor = () => null;
const valid = (doc: unknown) => documentSchema.safeParse(doc).error?.issues ?? [];

describe("addText", () => {
	it("adds a fully specified text annotation at the bottom by default", () => {
		const { doc, ids } = addText(singleClipDoc(), { start: 1, end: 3, text: "One-click setup" });
		expect(doc.annotations[0]).toEqual({
			id: ids[0],
			startMs: 1000,
			endMs: 3000,
			clipId: "clip_a",
			sourceStartSec: 1,
			sourceEndSec: 3,
			type: "text",
			content: "One-click setup",
			textContent: "One-click setup",
			position: { x: 10, y: 83 },
			size: { width: 80, height: 12 },
			style: {
				color: "#ffffff",
				backgroundColor: "transparent",
				fontSize: 32,
				fontFamily: "Inter",
				fontWeight: "bold",
				fontStyle: "normal",
				textDecoration: "none",
				textAlign: "center",
			},
			zIndex: 1,
		});
		expect(ids[0]).toMatch(/^annotation_/);
		expect(valid(doc)).toEqual([]);
	});

	it("applies placement, style options and stacking order", () => {
		const first = addText(singleClipDoc(), { start: 1, end: 3, text: "a" });
		const { doc } = addText(first.doc, {
			start: 5,
			end: 6,
			text: "b",
			placement: { x: 50, y: 95 },
			fontSize: 48,
			color: "#ff0000",
			background: "#000000",
			animation: "pop",
		});
		expect(doc.annotations[1]).toMatchObject({
			position: { x: 50, y: 95 },
			size: { width: 50, height: 5 },
			style: { fontSize: 48, color: "#ff0000", backgroundColor: "#000000", textAnimation: "pop" },
			zIndex: 2,
		});
		expect(valid(doc)).toEqual([]);
	});

	it("rejects overlapping text but allows text over a blur", () => {
		const text = addText(singleClipDoc(), { start: 1, end: 3, text: "a" });
		expect(() => addText(text.doc, { start: 2, end: 4, text: "b" })).toThrow(/overlaps text/);
		expect(() => addBlur(text.doc, { start: 2, end: 4, rect: { x: 0, y: 0, width: 10, height: 10 } })).not.toThrow();
	});
});

describe("addBlur", () => {
	it("adds a blur annotation over the given rectangle", () => {
		const { doc } = addBlur(singleClipDoc(), {
			start: 1,
			end: 9,
			rect: { x: 60, y: 5, width: 30, height: 8 },
			style: "mosaic",
			shape: "oval",
		});
		expect(doc.annotations[0]).toMatchObject({
			type: "blur",
			content: "",
			position: { x: 60, y: 5 },
			size: { width: 30, height: 8 },
			blurData: { type: "mosaic", shape: "oval", color: "white", intensity: 12, blockSize: 12 },
		});
		expect(valid(doc)).toEqual([]);
	});

	it("rejects a rectangle that leaves the frame", () => {
		expect(() =>
			addBlur(singleClipDoc(), { start: 1, end: 2, rect: { x: 90, y: 0, width: 20, height: 10 } }),
		).toThrow(/inside the frame/);
	});

	it("allows blurs that overlap in time", () => {
		const first = addBlur(singleClipDoc(), { start: 1, end: 5, rect: { x: 0, y: 0, width: 10, height: 10 } });
		const second = addBlur(first.doc, { start: 2, end: 6, rect: { x: 50, y: 50, width: 10, height: 10 } });
		expect(second.doc.annotations).toHaveLength(2);
		expect(valid(second.doc)).toEqual([]);
	});

	it("lets an update move a blur over another blur", () => {
		const a = addBlur(singleClipDoc(), { start: 1, end: 2, rect: { x: 0, y: 0, width: 10, height: 10 } });
		const b = addBlur(a.doc, { start: 3, end: 4, rect: { x: 0, y: 0, width: 10, height: 10 } });
		expect(() => updateRegion(b.doc, { id: a.ids[0]!, end: 3.5 }, noCursor)).not.toThrow();
	});
});

describe("blurAnnotation", () => {
	it("builds a fully specified blur annotation", () => {
		const f = { clipId: "clip_a", assetId: "x", sourceStartSec: 1, sourceEndSec: 2, startMs: 1000, endMs: 2000 };
		expect(
			blurAnnotation("annotation_1", f, { x: 1, y: 2, width: 3, height: 4 }, { style: "mosaic", shape: "rectangle", intensity: 16 }, 7),
		).toMatchObject({
			id: "annotation_1",
			type: "blur",
			startMs: 1000,
			endMs: 2000,
			clipId: "clip_a",
			position: { x: 1, y: 2 },
			size: { width: 3, height: 4 },
			zIndex: 7,
			blurData: { type: "mosaic", shape: "rectangle", color: "white", intensity: 16, blockSize: 16 },
		});
	});
});

describe("setSpeed", () => {
	it("adds an anchored speed region, creating legacyEditor when absent", () => {
		const input = singleClipDoc();
		input.legacyEditor = null;
		const { doc, ids } = setSpeed(input, { start: 10, end: 20, speed: 2.004 });
		expect(speedRegions(doc)).toEqual([
			{ id: ids[0], startMs: 10000, endMs: 20000, speed: 2, clipId: "clip_a", sourceStartSec: 10, sourceEndSec: 20 },
		]);
		expect(valid(doc)).toEqual([]);
	});

	it("rejects speeds outside 0.1–16", () => {
		expect(() => setSpeed(singleClipDoc(), { start: 1, end: 2, speed: 20 })).toThrow(/between 0.1 and 16/);
	});

	it("rejects overlapping speed regions", () => {
		const first = setSpeed(singleClipDoc(), { start: 10, end: 20, speed: 2 });
		expect(() => setSpeed(first.doc, { start: 15, end: 25, speed: 3 })).toThrow(/overlaps speed/);
	});
});

describe("updateRegion", () => {
	it("moves a zoom and changes its depth, keeping its id", () => {
		const { doc, ids } = addZoom(singleClipDoc(), { start: 2, end: 4, depth: 3 }, noCursor);
		const updated = updateRegion(doc, { id: ids[0]!, start: 5, end: 8, depth: 5 }, noCursor);
		expect(updated.ids).toEqual(ids);
		expect(updated.doc.zoomRanges[0]).toMatchObject({
			id: ids[0],
			startMs: 5000,
			endMs: 8000,
			sourceStartSec: 5,
			sourceEndSec: 8,
			depth: 5,
		});
		expect(valid(updated.doc)).toEqual([]);
	});

	it("re-aims a zoom at the cursor on request", () => {
		const { doc, ids } = addZoom(singleClipDoc(), { start: 2, end: 4, depth: 3, focus: { cx: 0.1, cy: 0.1 } }, noCursor);
		const updated = updateRegion(doc, { id: ids[0]!, focus: "cursor" }, () => ({ cx: 0.7, cy: 0.3 }));
		expect(updated.doc.zoomRanges[0]).toMatchObject({ focus: { cx: 0.7, cy: 0.3 }, focusMode: "auto" });
	});

	it("edits text content and style", () => {
		const { doc, ids } = addText(singleClipDoc(), { start: 1, end: 3, text: "old" });
		const updated = updateRegion(doc, { id: ids[0]!, text: "new", fontSize: 40, color: "#00ff00" }, noCursor);
		expect(updated.doc.annotations[0]).toMatchObject({
			content: "new",
			textContent: "new",
			style: { fontSize: 40, color: "#00ff00" },
		});
	});

	it("changes a speed and a cut", () => {
		const sped = setSpeed(singleClipDoc(), { start: 10, end: 20, speed: 2 });
		const faster = updateRegion(sped.doc, { id: sped.ids[0]!, speed: 4 }, noCursor);
		expect(speedRegions(faster.doc)[0]!.speed).toBe(4);

		const cut = cutRange(singleClipDoc(), { start: 5, end: 7, reason: "idle" });
		const longer = updateRegion(cut.doc, { id: cut.ids[0]!, end: 9, reason: "longer" }, noCursor);
		expect(longer.doc.timeline.trimRanges[0]).toMatchObject({ startSec: 5, endSec: 9, reason: "longer" });
	});

	it("refuses to move a region across a clip boundary", () => {
		const { doc, ids } = addZoom(twoClipDoc(), { start: 2, end: 4, depth: 3 }, noCursor);
		expect(() => updateRegion(doc, { id: ids[0]!, end: 12 }, noCursor)).toThrow(/clip boundary/);
	});

	it("refuses an update that would overlap a neighbour", () => {
		const a = addZoom(singleClipDoc(), { start: 2, end: 4, depth: 3 }, noCursor);
		const b = addZoom(a.doc, { start: 6, end: 8, depth: 3 }, noCursor);
		expect(() => updateRegion(b.doc, { id: a.ids[0]!, end: 7 }, noCursor)).toThrow(/overlaps zoom/);
	});
});
