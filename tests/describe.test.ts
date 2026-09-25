import { describe, expect, it } from "vitest";
import { describeProject, unionLength } from "../src/describe";
import { addBlur, addText } from "../src/edit/annotate";
import { cutRange } from "../src/edit/cut";
import { setSpeed } from "../src/edit/speed";
import { addZoom } from "../src/edit/zoom";
import { realDoc, singleClipDoc } from "./helpers/docs";

describe("unionLength", () => {
	it("merges overlapping spans", () => {
		expect(unionLength([{ start: 5, end: 7 }, { start: 6, end: 8 }, { start: 10, end: 11 }])).toBe(4);
	});
});

describe("describeProject", () => {
	it("summarises every region in timeline seconds", () => {
		let doc = singleClipDoc();
		const zoom = addZoom(doc, { start: 2, end: 4, depth: 3, focus: { cx: 0.2, cy: 0.3 } }, () => null);
		doc = zoom.doc;
		const cut = cutRange(doc, { start: 5, end: 7, reason: "idle" });
		doc = cut.doc;
		const text = addText(doc, { start: 1, end: 3, text: "Hello" });
		doc = text.doc;
		const blur = addBlur(doc, { start: 8, end: 9, rect: { x: 1, y: 2, width: 3, height: 4 } });
		doc = blur.doc;
		const speed = setSpeed(doc, { start: 20, end: 25, speed: 2 });
		doc = speed.doc;

		expect(describeProject(doc)).toEqual({
			id: doc.project.id,
			title: doc.project.title,
			timeUnit: "timeline seconds (cut sections still occupy their place)",
			durationSec: 30,
			keptDurationSec: 28,
			clips: [{ id: "clip_a", start: 0, end: 30, sourceStart: 0, sourceEnd: 30, video: expect.stringMatching(/\.mp4$/) }],
			cuts: [{ id: cut.ids[0], start: 5, end: 7, reason: "idle" }],
			zooms: [{ id: zoom.ids[0], start: 2, end: 4, depth: 3, focus: { cx: 0.2, cy: 0.3 }, focusMode: "manual" }],
			texts: [{ id: text.ids[0], start: 1, end: 3, text: "Hello" }],
			blurs: [{ id: blur.ids[0], start: 8, end: 9, rect: { x: 1, y: 2, width: 3, height: 4 }, style: "blur" }],
			speeds: [{ id: speed.ids[0], start: 20, end: 25, speed: 2 }],
		});
	});

	it("describes a real OpenScreen project", () => {
		const summary = describeProject(realDoc());
		expect(summary.durationSec).toBeCloseTo(35.23, 2);
		expect(summary.cuts).toHaveLength(2);
		expect(summary.zooms).toHaveLength(17);
		expect(summary.zooms.filter((z) => z.focusMode === "auto")).toHaveLength(9);
		expect(summary.keptDurationSec).toBeLessThan(summary.durationSec);
	});
});
