import { describe, expect, it } from "vitest";
import { censorAnnotations } from "../../src/censor/apply";
import { documentSchema } from "../../src/vendor/openscreen-schema";
import { ASSET_ID, clip, singleClipDoc, twoClipDoc } from "../helpers/docs";

const look = { style: "mosaic" as const, intensity: 16 };
const seg = (start: number, end: number, x = 0.5, y = 0.1, w = 0.1, h = 0.2) => ({ start, end, rect: { x, y, w, h } });

describe("censorAnnotations", () => {
	it("adds one mosaic blur per segment in percent of the frame", () => {
		const { doc, ids } = censorAnnotations(singleClipDoc(), [{ assetId: ASSET_ID, segments: [seg(1, 4)] }], look);
		expect(ids).toHaveLength(1);
		expect(doc.annotations[0]).toMatchObject({
			type: "blur",
			startMs: 1000,
			endMs: 4000,
			clipId: "clip_a",
			position: { x: 50, y: 10 },
			size: { width: 10, height: 20 },
			blurData: { type: "mosaic", intensity: 16, blockSize: 16 },
		});
		expect(documentSchema.safeParse(doc).error?.issues ?? []).toEqual([]);
	});

	it("places a segment on every clip that plays it, in timeline seconds", () => {
		// twoClipDoc: timeline 0–10 = source 0–10, timeline 10–20 = source 20–30.
		const { doc } = censorAnnotations(twoClipDoc(), [{ assetId: ASSET_ID, segments: [seg(8, 22)] }], look);
		expect(doc.annotations.map((a) => [a.clipId, a.startMs, a.endMs])).toEqual([
			["clip_a", 8000, 10000],
			["clip_b", 10000, 12000],
		]);
	});

	it("maps rects into a cropped clip and drops what the crop hides", () => {
		const cropped = singleClipDoc();
		cropped.timeline.clips = [{ ...clip("clip_a", 0, 30, 0), cropRegion: { x: 0.5, y: 0, width: 0.5, height: 1 } }];
		const { doc } = censorAnnotations(
			cropped,
			[{ assetId: ASSET_ID, segments: [seg(1, 2, 0.6, 0.1, 0.1, 0.1), seg(3, 4, 0.1, 0.1, 0.1, 0.1)] }],
			look,
		);
		expect(doc.annotations).toHaveLength(1);
		expect(doc.annotations[0]!.position.x).toBeCloseTo(20, 6);
		expect(doc.annotations[0]!.size.width).toBeCloseTo(20, 6);
	});

	it("stacks new blurs above existing annotations", () => {
		const first = censorAnnotations(singleClipDoc(), [{ assetId: ASSET_ID, segments: [seg(1, 2)] }], look);
		const second = censorAnnotations(first.doc, [{ assetId: ASSET_ID, segments: [seg(1, 2), seg(3, 4)] }], look);
		expect(second.doc.annotations.map((a) => a.zIndex)).toEqual([1, 2, 3]);
	});

	it("refuses when nothing lands on the timeline", () => {
		expect(() => censorAnnotations(singleClipDoc(), [{ assetId: "asset_other", segments: [seg(1, 2)] }], look)).toThrow(
			/not on the timeline/,
		);
	});
});
