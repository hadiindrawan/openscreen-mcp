import type { Click } from "../analysis/cursor";
import type { OcrLine } from "../analysis/ocr";

export interface OcrFrameLike {
	t: number;
	until: number;
	lines: OcrLine[];
}

export interface TypingCandidate {
	start: number;
	end: number;
	before: string;
	after: string;
	nearClick: boolean;
}

const SAME_PLACE = 0.01;
const MERGE_GAP_SEC = 1.5;
const CLICK_WINDOW_SEC = 8;
const CLICK_LINE_TOLERANCE = 0.06;
const CHROME_TOP = 0.12;

const clean = (s: string) => s.replace(/[\s|*•·]+$/u, "");
const alnum = (s: string) => (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
const truncated = (s: string) => s.includes("…") || s.includes("...");

interface Growth {
	start: number;
	end: number;
	line: OcrLine;
	before: string;
	after: string;
}

/** Text that grows in place between OCR frames. A hint for typing, not proof: verify with frames. */
export function typingCandidates(frames: OcrFrameLike[], clicks: Click[]): TypingCandidate[] {
	const growths: Growth[] = [];
	for (let i = 1; i < frames.length; i++) {
		const prevFrame = frames[i - 1]!;
		const frame = frames[i]!;
		for (const cur of frame.lines) {
			if (cur.y < CHROME_TOP) continue;
			const prev = prevFrame.lines.find((p) => Math.abs(p.x - cur.x) < SAME_PLACE && Math.abs(p.y - cur.y) < SAME_PLACE);
			if (!prev || truncated(prev.text) || truncated(cur.text)) continue;
			const before = clean(prev.text);
			const after = clean(cur.text);
			if (alnum(before) >= 1 && after.startsWith(before) && alnum(after) > alnum(before)) {
				growths.push({ start: prevFrame.t, end: frame.t, line: cur, before, after });
			}
		}
	}

	const merged: Growth[] = [];
	for (const g of growths.sort((a, b) => a.start - b.start)) {
		const open = merged.find(
			(m) =>
				Math.abs(m.line.x - g.line.x) < SAME_PLACE &&
				Math.abs(m.line.y - g.line.y) < SAME_PLACE &&
				g.start - m.end <= MERGE_GAP_SEC,
		);
		if (open) {
			open.end = Math.max(open.end, g.end);
			open.after = g.after;
			open.line = g.line;
		} else {
			merged.push({ ...g });
		}
	}

	return merged
		.map((m) => {
			const lastClick = clicks.filter((c) => c.sec <= m.end && m.end - c.sec <= CLICK_WINDOW_SEC).at(-1);
			const nearClick = lastClick
				? Math.abs(lastClick.cy - (m.line.y + m.line.h / 2)) <= CLICK_LINE_TOLERANCE
				: false;
			return { start: m.start, end: m.end, before: m.before, after: m.after, nearClick };
		})
		.sort((a, b) => a.start - b.start);
}
