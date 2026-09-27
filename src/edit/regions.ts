import { ToolError } from "../errors";
import type { Doc, SpeedRegion } from "../project/types";
import { regionSpanSec, type Span, trimSpanSec } from "./timemap";

export type RegionKind = "zoom" | "text" | "blur" | "speed" | "cut" | "sound";

export interface RegionRef {
	kind: RegionKind;
	id: string;
	span: Span | null;
}

export interface EditResult {
	doc: Doc;
	ids: string[];
}

export function speedRegions(doc: Doc): SpeedRegion[] {
	const list = doc.legacyEditor?.speedRegions;
	return Array.isArray(list) ? (list as SpeedRegion[]) : [];
}

/** Audio tracks folded into one entry per track (fragments share trackId). */
export function soundTracks(doc: Doc): { id: string; span: Span; first: Doc["audioTracks"][number] }[] {
	const clips = doc.timeline.clips;
	const byGroup = new Map<string, { id: string; span: Span; first: Doc["audioTracks"][number] }>();
	for (const t of doc.audioTracks) {
		const id = t.trackId ?? t.id;
		const s = regionSpanSec(clips, t);
		const g = byGroup.get(id);
		if (g) g.span = { start: Math.min(g.span.start, s.start), end: Math.max(g.span.end, s.end) };
		else byGroup.set(id, { id, span: s, first: t });
	}
	return [...byGroup.values()].sort((a, b) => a.span.start - b.span.start);
}

export function allRegions(doc: Doc): RegionRef[] {
	const clips = doc.timeline.clips;
	return [
		...doc.zoomRanges.map((z) => ({ kind: "zoom" as const, id: z.id, span: regionSpanSec(clips, z) })),
		...doc.annotations
			.filter((a) => a.type === "text" || a.type === "blur")
			.map((a) => ({ kind: a.type as "text" | "blur", id: a.id, span: regionSpanSec(clips, a) })),
		...speedRegions(doc).map((s) => ({ kind: "speed" as const, id: s.id, span: regionSpanSec(clips, s) })),
		...doc.timeline.trimRanges.map((t) => ({ kind: "cut" as const, id: t.id, span: trimSpanSec(clips, t) })),
		...soundTracks(doc).map((s) => ({ kind: "sound" as const, id: s.id, span: s.span })),
	];
}

export function findRegion(doc: Doc, id: string): RegionRef | null {
	return allRegions(doc).find((r) => r.id === id) ?? null;
}

export function fmtSpan(span: Span): string {
	return `${span.start.toFixed(2)}–${span.end.toFixed(2)}s`;
}

export function regionNotFound(id: string): ToolError {
	return new ToolError(`No zoom, cut, text, blur, speed or sound region has id ${id}. Use describe_project.`);
}

const EPS = 1e-6;

/** Repel rule: two regions of the same kind may not overlap (touching is fine). */
export function assertNoOverlap(
	doc: Doc,
	kind: Exclude<RegionKind, "cut">,
	spans: Span[],
	ignoreId?: string,
): void {
	const others = allRegions(doc).filter((r) => r.kind === kind && r.id !== ignoreId && r.span);
	for (const span of spans) {
		for (const other of others) {
			const o = other.span as Span;
			if (span.start < o.end - EPS && o.start < span.end - EPS) {
				throw new ToolError(
					`That ${kind} (${fmtSpan(span)}) overlaps ${kind} ${other.id} (${fmtSpan(o)}). Update or remove ${other.id} first.`,
				);
			}
		}
	}
}

export function removeRegion(doc: Doc, id: string): EditResult {
	const ref = findRegion(doc, id);
	if (!ref) throw regionNotFound(id);
	const next = structuredClone(doc);
	switch (ref.kind) {
		case "zoom":
			next.zoomRanges = next.zoomRanges.filter((z) => z.id !== id);
			break;
		case "text":
		case "blur":
			next.annotations = next.annotations.filter((a) => a.id !== id);
			break;
		case "speed":
			(next.legacyEditor as Record<string, unknown>).speedRegions = speedRegions(next).filter((s) => s.id !== id);
			break;
		case "cut":
			next.timeline.trimRanges = next.timeline.trimRanges.filter((t) => t.id !== id);
			break;
		case "sound":
			next.audioTracks = next.audioTracks.filter((t) => (t.trackId ?? t.id) !== id);
			break;
	}
	return { doc: next, ids: [id] };
}
