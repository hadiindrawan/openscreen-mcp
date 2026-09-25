import { ToolError } from "../errors";
import type { AnnotationRegion, Doc } from "../project/types";
import { createId } from "../vendor/shims";
import { assertNoOverlap, type EditResult } from "./regions";
import { anchorSpan, fragmentSpan } from "./timemap";

export const TEXT_ANIMATIONS = ["none", "fade", "rise", "pop", "slide-left", "typewriter", "pulse"] as const;
export type TextAnimation = (typeof TEXT_ANIMATIONS)[number];
export type Placement = "top" | "center" | "bottom" | { x: number; y: number };

export interface TextInput {
	start: number;
	end: number;
	text: string;
	placement?: Placement;
	fontSize?: number;
	color?: string;
	background?: string;
	animation?: TextAnimation;
}

export interface BlurInput {
	start: number;
	end: number;
	rect: { x: number; y: number; width: number; height: number };
	style?: "blur" | "mosaic";
	shape?: "rectangle" | "oval";
}

// position/size are percentages of the frame; position is the top-left corner.
const PRESETS = { top: { x: 10, y: 5 }, center: { x: 10, y: 44 }, bottom: { x: 10, y: 83 } };
const TEXT_SIZE = { width: 80, height: 12 };

function baseStyle(): AnnotationRegion["style"] {
	return {
		color: "#ffffff",
		backgroundColor: "transparent",
		fontSize: 32,
		fontFamily: "Inter",
		fontWeight: "bold",
		fontStyle: "normal",
		textDecoration: "none",
		textAlign: "center",
	};
}

function nextZIndex(doc: Doc): number {
	return doc.annotations.reduce((max, a) => Math.max(max, a.zIndex), 0) + 1;
}

export function addText(doc: Doc, input: TextInput): EditResult {
	const fragments = anchorSpan(doc.timeline.clips, input.start, input.end);
	assertNoOverlap(doc, "text", fragments.map(fragmentSpan));
	const placement = input.placement ?? "bottom";
	const position = typeof placement === "string" ? PRESETS[placement] : placement;
	const size = {
		width: Math.min(TEXT_SIZE.width, 100 - position.x),
		height: Math.min(TEXT_SIZE.height, 100 - position.y),
	};
	if (size.width <= 0 || size.height <= 0) {
		throw new ToolError("placement must leave room inside the frame (x and y below 100).");
	}
	const style = {
		...baseStyle(),
		fontSize: input.fontSize ?? 32,
		color: input.color ?? "#ffffff",
		backgroundColor: input.background ?? "transparent",
		...(input.animation ? { textAnimation: input.animation } : {}),
	};
	const next = structuredClone(doc);
	const ids = fragments.map((f) => {
		const id = createId("annotation");
		next.annotations.push({
			id,
			startMs: f.startMs,
			endMs: f.endMs,
			clipId: f.clipId,
			sourceStartSec: f.sourceStartSec,
			sourceEndSec: f.sourceEndSec,
			type: "text",
			content: input.text,
			textContent: input.text,
			position: { ...position },
			size,
			style: { ...style },
			zIndex: nextZIndex(next),
		});
		return id;
	});
	return { doc: next, ids };
}

export function addBlur(doc: Doc, input: BlurInput): EditResult {
	const { x, y, width, height } = input.rect;
	if (width <= 0 || height <= 0 || x < 0 || y < 0 || x + width > 100 || y + height > 100) {
		throw new ToolError(
			"rect must lie inside the frame: x, y, width and height are percentages with x + width ≤ 100 and y + height ≤ 100.",
		);
	}
	const fragments = anchorSpan(doc.timeline.clips, input.start, input.end);
	assertNoOverlap(doc, "blur", fragments.map(fragmentSpan));
	const next = structuredClone(doc);
	const ids = fragments.map((f) => {
		const id = createId("annotation");
		next.annotations.push({
			id,
			startMs: f.startMs,
			endMs: f.endMs,
			clipId: f.clipId,
			sourceStartSec: f.sourceStartSec,
			sourceEndSec: f.sourceEndSec,
			type: "blur",
			content: "",
			position: { x, y },
			size: { width, height },
			style: baseStyle(),
			zIndex: nextZIndex(next),
			blurData: {
				type: input.style ?? "blur",
				shape: input.shape ?? "rectangle",
				color: "white",
				intensity: 12,
				blockSize: 12,
			},
		});
		return id;
	});
	return { doc: next, ids };
}
