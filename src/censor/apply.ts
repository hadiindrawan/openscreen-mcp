import { blurAnnotation } from "../edit/annotate";
import type { EditResult } from "../edit/regions";
import { anchorSpan, sourceSpanToTimeline } from "../edit/timemap";
import { ToolError } from "../errors";
import type { Clip, Doc } from "../project/types";
import { createId } from "../vendor/shims";
import type { Rect } from "./classify";
import type { Segment } from "./track";

export interface CensorLook {
	style: "blur" | "mosaic";
	intensity: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** A 0–1 source rect → 0–1 of what the clip shows, or null when its crop hides it all. */
function intoCrop(rect: Rect, crop: Clip["cropRegion"]): Rect | null {
	if (!crop) return rect;
	const x0 = Math.max(0, (rect.x - crop.x) / crop.width);
	const y0 = Math.max(0, (rect.y - crop.y) / crop.height);
	const x1 = Math.min(1, (rect.x + rect.w - crop.x) / crop.width);
	const y1 = Math.min(1, (rect.y + rect.h - crop.y) / crop.height);
	return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function censorAnnotations(
	doc: Doc,
	findings: { assetId: string; segments: Segment[] }[],
	look: CensorLook,
): EditResult {
	const next = structuredClone(doc);
	const clips = next.timeline.clips;
	let zIndex = next.annotations.reduce((max, a) => Math.max(max, a.zIndex), 0);
	const ids: string[] = [];
	for (const finding of findings) {
		for (const segment of finding.segments) {
			for (const span of sourceSpanToTimeline(clips, finding.assetId, segment.start, segment.end)) {
				for (const fragment of anchorSpan(clips, span.start, span.end)) {
					if (fragment.assetId !== finding.assetId) continue;
					const clip = clips.find((c) => c.id === fragment.clipId)!;
					const rect = intoCrop(segment.rect, clip.cropRegion);
					if (!rect) continue;
					const id = createId("annotation");
					zIndex += 1;
					next.annotations.push(
						blurAnnotation(
							id,
							fragment,
							{ x: r2(rect.x * 100), y: r2(rect.y * 100), width: r2(rect.w * 100), height: r2(rect.h * 100) },
							{ style: look.style, shape: "rectangle", intensity: look.intensity },
							zIndex,
						),
					);
					ids.push(id);
				}
			}
		}
	}
	if (ids.length === 0) throw new ToolError("Nothing to blur: the selected findings are not on the timeline.");
	return { doc: next, ids };
}
