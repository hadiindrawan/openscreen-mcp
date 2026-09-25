import { anchorSpan, regionSpanSec, type Span, timelineDurationSec, trimSpanSec } from "../edit/timemap";
import { ToolError } from "../errors";
import type { AudioTrack, Doc } from "../project/types";
import { createId } from "../vendor/shims";

export const MIN_SOUND_SEC = 0.06;
export const TRIM_FADE_MS = 20;
const EPS = 1e-6;

export interface SoundEvent {
	at: number;
	assetId: string;
	durationSec: number;
	gainDb: number;
	label: string;
	loopUntil?: number;
}

export interface Skipped {
	at: number;
	reason: string;
}

export interface PlaceResult {
	doc: Doc;
	ids: string[];
	skipped: Skipped[];
}

export const trackGroupId = (t: AudioTrack): string => t.trackId ?? t.id;

/** Existing voiceover-lane pills on the timeline, one span per track. */
export function voiceoverPills(doc: Doc): Span[] {
	const clips = doc.timeline.clips;
	const byGroup = new Map<string, Span>();
	for (const t of doc.audioTracks.filter((x) => x.kind === "voiceover")) {
		const s = regionSpanSec(clips, t);
		const g = trackGroupId(t);
		const p = byGroup.get(g);
		byGroup.set(g, p ? { start: Math.min(p.start, s.start), end: Math.max(p.end, s.end) } : s);
	}
	return [...byGroup.values()].sort((a, b) => a.start - b.start);
}

const inside = (spans: Span[], at: number) => spans.some((s) => at >= s.start - EPS && at < s.end - EPS);

export function placeSounds(doc: Doc, events: SoundEvent[]): PlaceResult {
	const clips = doc.timeline.clips;
	const duration = timelineDurationSec(clips);
	const cuts = doc.timeline.trimRanges.map((t) => trimSpanSec(clips, t)).filter((s): s is Span => s !== null);
	const pills = voiceoverPills(doc);
	const skipped: Skipped[] = [];

	const kept = [...events]
		.sort((a, b) => a.at - b.at)
		.filter((e) => {
			if (e.at < 0 || e.at >= duration) skipped.push({ at: e.at, reason: `outside the timeline (0–${Math.round(duration * 1000) / 1000}s)` });
			else if (inside(cuts, e.at)) skipped.push({ at: e.at, reason: "inside a cut" });
			else if (inside(pills, e.at)) skipped.push({ at: e.at, reason: "inside another sound" });
			else return true;
			return false;
		});

	const next = structuredClone(doc);
	const ids: string[] = [];
	kept.forEach((e, i) => {
		const natural = e.loopUntil ?? e.at + e.durationSec;
		const nextPill = pills.find((p) => p.start > e.at + EPS)?.start ?? Number.POSITIVE_INFINITY;
		const end = Math.min(natural, kept[i + 1]?.at ?? Number.POSITIVE_INFINITY, nextPill, duration);
		if (end - e.at < MIN_SOUND_SEC - EPS) {
			skipped.push({ at: e.at, reason: `too short to fit before the next sound (${Math.round((end - e.at) * 1000)} ms)` });
			return;
		}
		const fade = end < natural - EPS ? TRIM_FADE_MS : 0;
		const loop = e.loopUntil !== undefined;
		const fragments = anchorSpan(clips, e.at, end);
		const trackId = createId("audio");
		let elapsed = 0;
		fragments.forEach((f, k) => {
			next.audioTracks.push({
				id: k === 0 ? trackId : createId("audio"),
				trackId,
				startMs: f.startMs,
				endMs: f.endMs,
				clipId: f.clipId,
				sourceStartSec: f.sourceStartSec,
				sourceEndSec: f.sourceEndSec,
				assetId: e.assetId,
				kind: "voiceover",
				durationSec: e.durationSec,
				offsetMs: loop ? 0 : elapsed,
				gainDb: e.gainDb,
				loop,
				fadeInMs: 0,
				fadeOutMs: k === fragments.length - 1 ? fade : 0,
				muted: false,
				label: e.label,
				origin: "agent",
			});
			elapsed += f.endMs - f.startMs;
		});
		ids.push(trackId);
	});

	skipped.sort((a, b) => a.at - b.at);
	if (ids.length === 0) {
		throw new ToolError(`No sound was placed: ${skipped.map((s) => `${s.at}s ${s.reason}`).join("; ")}.`);
	}
	return { doc: next, ids, skipped };
}
