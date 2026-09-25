import { round3 } from "../edit/timemap";
import { type Detection, type DetectionCategory, mask, type Rect } from "./classify";

export interface FrameDetections {
	t: number;
	until: number;
	detections: Detection[];
}

export interface Segment {
	start: number;
	end: number;
	rect: Rect;
}

export interface TrackedGroup {
	category: DetectionCategory;
	group: string;
	label: string;
	examples: string[];
	segments: Segment[];
}

export const PAD = 0.004;
export const LEAD = 0.25;
export const MIN_SEGMENT = 0.3;
export const MIN_IOU = 0.6;

function iou(a: Rect, b: Rect): number {
	const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
	const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
	const inter = ix * iy;
	return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

function union(rects: Rect[]): Rect {
	const x0 = Math.min(...rects.map((r) => r.x));
	const y0 = Math.min(...rects.map((r) => r.y));
	const x1 = Math.max(...rects.map((r) => r.x + r.w));
	const y1 = Math.max(...rects.map((r) => r.y + r.h));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function pad(r: Rect): Rect {
	const x0 = Math.max(0, r.x - PAD);
	const y0 = Math.max(0, r.y - PAD);
	const x1 = Math.min(1, r.x + r.w + PAD);
	const y1 = Math.min(1, r.y + r.h + PAD);
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

interface Open {
	group: string;
	first: Rect;
	rects: Rect[];
	firstT: number;
	lastUntil: number;
}

function close(open: Open, assetEnd: number): Segment {
	let start = Math.max(0, open.firstT - LEAD);
	let end = Math.min(assetEnd, open.lastUntil + LEAD);
	if (end - start < MIN_SEGMENT) {
		end = Math.min(assetEnd, start + MIN_SEGMENT);
		start = Math.max(0, end - MIN_SEGMENT);
	}
	return { start: round3(start), end: round3(end), rect: pad(union(open.rects)) };
}

/** Per key, consecutive frames whose rect overlaps the segment's first rect (IoU ≥ 0.6) extend it. */
export function trackDetections(frames: FrameDetections[], assetEndSec: number): TrackedGroup[] {
	const groups = new Map<string, TrackedGroup>();
	const open = new Map<string, Open[]>();

	for (const frame of frames) {
		const seen = new Map<string, Open[]>();
		for (const d of frame.detections) {
			let g = groups.get(d.group);
			if (!g) {
				g = { category: d.category, group: d.group, label: d.groupLabel, examples: [], segments: [] };
				groups.set(d.group, g);
			}
			const example = mask(d.sample);
			if (g.examples.length < 3 && !g.examples.includes(example)) g.examples.push(example);

			const id = `${d.group}|${d.key}`;
			const candidates = open.get(id) ?? [];
			const taken = seen.get(id) ?? [];
			const match = candidates
				.filter((o) => !taken.includes(o))
				.map((o) => ({ o, score: iou(o.first, d.rect) }))
				.filter((c) => c.score >= MIN_IOU)
				.sort((a, b) => b.score - a.score)[0]?.o;
			const segment = match ?? { group: d.group, first: d.rect, rects: [], firstT: frame.t, lastUntil: frame.until };
			segment.rects.push(d.rect);
			segment.lastUntil = frame.until;
			seen.set(id, [...taken, segment]);
		}
		for (const [id, list] of open) {
			const kept = seen.get(id) ?? [];
			for (const o of list) {
				if (!kept.includes(o)) groups.get(o.group)!.segments.push(close(o, assetEndSec));
			}
		}
		open.clear();
		for (const [id, list] of seen) open.set(id, list);
	}
	for (const list of open.values()) {
		for (const o of list) groups.get(o.group)!.segments.push(close(o, assetEndSec));
	}
	for (const g of groups.values()) g.segments.sort((a, b) => a.start - b.start || a.rect.y - b.rect.y);
	return [...groups.values()];
}
