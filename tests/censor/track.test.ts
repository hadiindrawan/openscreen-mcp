import { describe, expect, it } from "vitest";
import type { Detection, Rect } from "../../src/censor/classify";
import { type FrameDetections, trackDetections } from "../../src/censor/track";

const det = (key: string, rect: Rect, group = "emails", sample = "alice@example.com"): Detection => ({
	category: "emails",
	group,
	groupLabel: "Email addresses",
	key,
	sample,
	rect,
});
const R = (x: number, y: number, w = 0.2, h = 0.05): Rect => ({ x, y, w, h });
const frames = (...list: [number, number, Detection[]][]): FrameDetections[] =>
	list.map(([t, until, detections]) => ({ t, until, detections }));

describe("trackDetections", () => {
	it("merges a static item into one padded, over-covering segment", () => {
		const [g] = trackDetections(frames([0, 3, [det("a", R(0.1, 0.1))]], [3, 6, [det("a", R(0.1, 0.1))]]), 6);
		expect(g).toMatchObject({ group: "emails", label: "Email addresses", examples: ["al•••"] });
		expect(g!.segments).toHaveLength(1);
		expect(g!.segments[0]!.start).toBe(0);
		expect(g!.segments[0]!.end).toBe(6);
		expect(g!.segments[0]!.rect.x).toBeCloseTo(0.096, 6);
		expect(g!.segments[0]!.rect.w).toBeCloseTo(0.208, 6);
	});

	it("chains a scrolling item into consecutive segments", () => {
		const [g] = trackDetections(frames([0, 3, [det("a", R(0.1, 0.5))]], [3, 6, [det("a", R(0.1, 0.3))]]), 6);
		expect(g!.segments.map((s) => [s.start, s.end])).toEqual([[0, 3.25], [2.75, 6]]);
	});

	it("keeps an item that moves a little as one segment", () => {
		const [g] = trackDetections(frames([0, 1, [det("a", R(0.1, 0.5))]], [1, 2, [det("a", R(0.1, 0.505))]]), 2);
		expect(g!.segments).toHaveLength(1);
		expect(g!.segments[0]!.rect.h).toBeCloseTo(0.055 + 0.008, 6);
	});

	it("splits an item that disappears and returns", () => {
		const [g] = trackDetections(
			frames([0, 1, [det("a", R(0.1, 0.1))]], [1, 2, []], [2, 3, [det("a", R(0.1, 0.1))]]),
			3,
		);
		expect(g!.segments.map((s) => [s.start, s.end])).toEqual([[0, 1.25], [1.75, 3]]);
	});

	it("tracks two copies of the same text at different places separately", () => {
		const both = [det("a", R(0.1, 0.1)), det("a", R(0.1, 0.6))];
		const [g] = trackDetections(frames([0, 2, both], [2, 4, both]), 4);
		expect(g!.segments).toHaveLength(2);
	});

	it("groups many keys of one rule into one finding with up to 3 examples", () => {
		const uuids = ["u1aaaa", "u2bbbb", "u3cccc", "u4dddd"].map((k, i) =>
			det(k, R(0.1, 0.1 * (i + 1)), "secrets:uuid", k),
		);
		const groups = trackDetections(frames([0, 2, uuids]), 2);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.segments).toHaveLength(4);
		expect(groups[0]!.examples).toEqual(["u1•••", "u2•••", "u3•••"]);
	});

	it("stretches a blink to the minimum length and clamps to the asset", () => {
		const [g] = trackDetections(frames([5.9, 5.95, [det("a", R(0, 0, 1, 1))]]), 6);
		const s = g!.segments[0]!;
		expect(s.end).toBe(6);
		expect(s.end - s.start).toBeCloseTo(0.35, 6);
		expect(s.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
	});

	it("returns nothing for no detections", () => {
		expect(trackDetections(frames([0, 6, []]), 6)).toEqual([]);
	});

	it("keeps a custom pattern containing a pipe intact", () => {
		const [g] = trackDetections(frames([0, 2, [det("x", R(0.1, 0.1), "custom:/a|b/")]]), 2);
		expect(g!.group).toBe("custom:/a|b/");
		expect(g!.segments).toHaveLength(1);
	});
});
