import { describe, expect, it } from "vitest";
import { axcutSchemaVersion, documentSchema } from "../../src/vendor/openscreen-schema";
import { realDoc, singleClipDoc, twoClipDoc } from "../helpers/docs";

describe("vendored OpenScreen schema", () => {
	it("is the v7 schema", () => {
		expect(axcutSchemaVersion).toBe(7);
	});

	it("accepts a real project saved by OpenScreen 1.12.2", () => {
		const result = documentSchema.safeParse(realDoc());
		expect(result.error?.issues ?? []).toEqual([]);
	});

	it("accepts the test documents", () => {
		expect(documentSchema.safeParse(singleClipDoc()).success).toBe(true);
		expect(documentSchema.safeParse(twoClipDoc()).success).toBe(true);
	});

	it("rejects a zoom with an invalid depth", () => {
		const doc = singleClipDoc();
		(doc.zoomRanges as unknown[]).push({
			id: "zoom_x",
			startMs: 0,
			endMs: 1000,
			depth: 9,
			focus: { cx: 0.5, cy: 0.5 },
		});
		expect(documentSchema.safeParse(doc).success).toBe(false);
	});
});
