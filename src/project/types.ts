import type { z } from "zod";
import type {
	annotationRegionSchema,
	clipSchema,
	documentSchema,
	trimRangeSchema,
	zoomRegionSchema,
} from "../vendor/openscreen-schema";

export type Doc = z.infer<typeof documentSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type ZoomRegion = z.infer<typeof zoomRegionSchema>;
export type AnnotationRegion = z.infer<typeof annotationRegionSchema>;
export type TrimRange = z.infer<typeof trimRangeSchema>;

/** Stored in `legacyEditor.speedRegions`, which the schema leaves untyped (passthrough). */
export interface SpeedRegion {
	id: string;
	startMs: number;
	endMs: number;
	speed: number;
	clipId?: string;
	sourceStartSec?: number;
	sourceEndSec?: number;
}
