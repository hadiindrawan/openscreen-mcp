import { describe, expect, it } from "vitest";
import type { OcrLine } from "../../src/analysis/ocr";
import { type OcrFrameLike, typingCandidates } from "../../src/sounds/typing";

const L = (text: string, x = 0.35, y = 0.53, w = 0.1, h = 0.015): OcrLine => ({ text, conf: 1, x, y, w, h });
const F = (t: number, ...lines: OcrLine[]): OcrFrameLike => ({ t, until: t + 0.5, lines });

describe("typingCandidates", () => {
	it("finds text growing in place and merges nearby growth", () => {
		const frames = [F(8, L("m")), F(8.5, L("mut")), F(9, L("mutas")), F(9.5, L("mutasi")), F(12, L("mutasi"))];
		expect(typingCandidates(frames, [])).toEqual([
			{ start: 8, end: 9.5, before: "m", after: "mutasi", nearClick: false },
		]);
	});

	it("ignores caret and marker jitter", () => {
		const frames = [F(1, L("Worker")), F(1.5, L("Worker|")), F(2, L("Worker *"))];
		expect(typingCandidates(frames, [])).toEqual([]);
	});

	it("ignores the browser chrome and truncated labels", () => {
		const frames = [F(1, L("beta.example.io/a", 0.1, 0.05)), F(1.5, L("beta.example.io/abc", 0.1, 0.05)),
			F(2, L("STG New...", 0.3, 0.3)), F(2.5, L("STG New Match...", 0.3, 0.3))];
		expect(typingCandidates(frames, [])).toEqual([]);
	});

	it("splits growth separated by more than 1.5 s", () => {
		const frames = [F(1, L("a")), F(1.5, L("ab")), F(5, L("ab")), F(5.5, L("abc"))];
		expect(typingCandidates(frames, []).map((c) => [c.start, c.end])).toEqual([[1, 1.5], [5, 5.5]]);
	});

	it("flags growth on the line the user last clicked", () => {
		const frames = [F(15.5, L("Q 0", 0.25, 0.44)), F(16, L("Q 00", 0.25, 0.44)), F(16.5, L("Q 007", 0.25, 0.44))];
		const [c] = typingCandidates(frames, [{ sec: 15.2, cx: 0.3, cy: 0.45 }]);
		expect(c).toMatchObject({ before: "Q 0", after: "Q 007", nearClick: true });
		const [far] = typingCandidates(frames, [{ sec: 2, cx: 0.3, cy: 0.45 }]);
		expect(far!.nearClick).toBe(false);
	});
});
