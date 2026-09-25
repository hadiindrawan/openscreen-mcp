import type { z } from "zod";
import type {
	annotationRegionSchema,
	assetSchema,
	audioTrackSchema,
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
export type AudioTrack = z.infer<typeof audioTrackSchema>;
export type Asset = z.infer<typeof assetSchema>;

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
