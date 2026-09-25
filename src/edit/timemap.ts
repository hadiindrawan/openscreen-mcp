// Timeline seconds (the RAW ruler in the OpenScreen editor, where cut sections still
// occupy space) ↔ clip-anchored source seconds. Inside one clip the two differ only by
// a shift: raw = clip.timelineStartSec + (source − clip.sourceStartSec).
import { ToolError } from "../errors";
import type { TrimRange } from "../project/types";

export interface ClipLike {
	id: string;
	assetId: string;
	sourceStartSec: number;
	sourceEndSec?: number;
	timelineStartSec: number;
	timelineEndSec: number;
}

export interface Span {
	start: number;
	end: number;
}

export interface Fragment {
	clipId: string;
	assetId: string;
	sourceStartSec: number;
	sourceEndSec: number;
	startMs: number;
	endMs: number;
}

export interface Anchored {
	clipId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
	startMs: number;
	endMs: number;
}

const EPS = 1e-6;

export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function clipSourceEnd(clip: ClipLike): number {
	return clip.sourceEndSec ?? clip.sourceStartSec + (clip.timelineEndSec - clip.timelineStartSec);
}

export function timelineDurationSec(clips: readonly ClipLike[]): number {
	return clips.reduce((max, c) => Math.max(max, c.timelineEndSec), 0);
}

function byTimeline<C extends ClipLike>(clips: readonly C[]): C[] {
	return [...clips].sort((a, b) => a.timelineStartSec - b.timelineStartSec);
}

function toTimeline(clip: ClipLike, sourceSec: number): number {
	return round3(clip.timelineStartSec + sourceSec - clip.sourceStartSec);
}

/** A timeline span → one anchored fragment per clip it covers. */
export function anchorSpan(clips: readonly ClipLike[], start: number, end: number): Fragment[] {
	if (!(end > start)) {
		throw new ToolError(`end (${end}s) must be after start (${start}s).`);
	}
	const fragments: Fragment[] = [];
	for (const clip of byTimeline(clips)) {
		const a = Math.max(start, clip.timelineStartSec);
		const b = Math.min(end, clip.timelineEndSec);
		if (b - a <= EPS) continue;
		fragments.push({
			clipId: clip.id,
			assetId: clip.assetId,
			sourceStartSec: round3(clip.sourceStartSec + a - clip.timelineStartSec),
			sourceEndSec: round3(clip.sourceStartSec + b - clip.timelineStartSec),
			startMs: Math.round(a * 1000),
			endMs: Math.round(b * 1000),
		});
	}
	if (fragments.length === 0) {
		throw new ToolError(
			`Range ${start}–${end}s is outside the timeline (0–${round3(timelineDurationSec(clips))}s).`,
		);
	}
	return fragments;
}

export function fragmentSpan(fragment: Fragment): Span {
	return { start: fragment.startMs / 1000, end: fragment.endMs / 1000 };
}

/** A source time of one asset → its timeline time on every clip that plays it. */
export function sourceToTimeline(
	clips: readonly ClipLike[],
	assetId: string,
	sourceSec: number,
): number[] {
	return byTimeline(clips)
		.filter(
			(c) =>
				c.assetId === assetId &&
				sourceSec >= c.sourceStartSec - EPS &&
				sourceSec <= clipSourceEnd(c) + EPS,
		)
		.map((c) => toTimeline(c, sourceSec));
}

/** A source span of one asset → its timeline span on every clip that plays part of it. */
export function sourceSpanToTimeline(
	clips: readonly ClipLike[],
	assetId: string,
	start: number,
	end: number,
): Span[] {
	const spans: Span[] = [];
	for (const clip of byTimeline(clips)) {
		if (clip.assetId !== assetId) continue;
		const lo = Math.max(start, clip.sourceStartSec);
		const hi = Math.min(end, clipSourceEnd(clip));
		if (hi - lo > EPS) spans.push({ start: toTimeline(clip, lo), end: toTimeline(clip, hi) });
	}
	return spans;
}

/** A timeline time → the clip playing it and the source time within that clip. */
export function timelineToSource<C extends ClipLike>(
	clips: readonly C[],
	t: number,
): { clip: C; sourceSec: number } | null {
	const sorted = byTimeline(clips);
	const last = sorted.at(-1);
	const clip =
		sorted.find((c) => t >= c.timelineStartSec && t < c.timelineEndSec) ??
		(last && Math.abs(t - last.timelineEndSec) < EPS ? last : undefined);
	return clip ? { clip, sourceSec: round3(clip.sourceStartSec + t - clip.timelineStartSec) } : null;
}

/** Where a zoom/annotation/speed fragment sits on the timeline. The anchor wins over the ms cache. */
export function regionSpanSec(clips: readonly ClipLike[], region: Anchored): Span {
	const clip = region.clipId ? clips.find((c) => c.id === region.clipId) : undefined;
	if (clip && region.sourceStartSec !== undefined && region.sourceEndSec !== undefined) {
		return { start: toTimeline(clip, region.sourceStartSec), end: toTimeline(clip, region.sourceEndSec) };
	}
	return { start: region.startMs / 1000, end: region.endMs / 1000 };
}

/** Where a cut sits on the timeline, or null when its clip is gone. */
export function trimSpanSec(
	clips: readonly ClipLike[],
	trim: Pick<TrimRange, "assetId" | "clipId" | "startSec" | "endSec">,
): Span | null {
	const clip = trim.clipId
		? clips.find((c) => c.id === trim.clipId)
		: byTimeline(clips).find(
				(c) =>
					c.assetId === trim.assetId &&
					trim.startSec >= c.sourceStartSec &&
					trim.startSec <= clipSourceEnd(c),
			);
	if (!clip) return null;
	const lo = Math.max(trim.startSec, clip.sourceStartSec);
	const hi = Math.min(trim.endSec, clipSourceEnd(clip));
	if (hi - lo <= EPS) return null;
	return { start: toTimeline(clip, lo), end: toTimeline(clip, hi) };
}
