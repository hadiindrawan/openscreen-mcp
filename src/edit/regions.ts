import { ToolError } from "../errors";
import type { Doc, SpeedRegion } from "../project/types";
import { regionSpanSec, type Span, trimSpanSec } from "./timemap";

export type RegionKind = "zoom" | "text" | "blur" | "speed" | "cut";

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

export function allRegions(doc: Doc): RegionRef[] {
	const clips = doc.timeline.clips;
	return [
		...doc.zoomRanges.map((z) => ({ kind: "zoom" as const, id: z.id, span: regionSpanSec(clips, z) })),
		...doc.annotations
			.filter((a) => a.type === "text" || a.type === "blur")
			.map((a) => ({ kind: a.type as "text" | "blur", id: a.id, span: regionSpanSec(clips, a) })),
		...speedRegions(doc).map((s) => ({ kind: "speed" as const, id: s.id, span: regionSpanSec(clips, s) })),
		...doc.timeline.trimRanges.map((t) => ({ kind: "cut" as const, id: t.id, span: trimSpanSec(clips, t) })),
	];
}

export function findRegion(doc: Doc, id: string): RegionRef | null {
	return allRegions(doc).find((r) => r.id === id) ?? null;
}

export function fmtSpan(span: Span): string {
	return `${span.start.toFixed(2)}–${span.end.toFixed(2)}s`;
}

export function regionNotFound(id: string): ToolError {
	return new ToolError(`No zoom, cut, text, blur or speed region has id ${id}. Use describe_project.`);
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
	}
	return { doc: next, ids: [id] };
}
