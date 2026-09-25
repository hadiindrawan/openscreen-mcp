import type { AudioTrack } from "../../src/project/types";

const groupOf = (t: AudioTrack) => t.trackId ?? t.id;

function pills(tracks: AudioTrack[], kind: AudioTrack["kind"]) {
	const byGroup = new Map<string, { id: string; startMs: number; endMs: number }>();
	for (const t of tracks.filter((x) => x.kind === kind)) {
		const g = groupOf(t);
		const p = byGroup.get(g);
		byGroup.set(g, p ? { id: g, startMs: Math.min(p.startMs, t.startMs), endMs: Math.max(p.endMs, t.endMs) } : { id: g, startMs: t.startMs, endMs: t.endMs });
	}
	return [...byGroup.values()].sort((a, b) => a.startMs - b.startMs);
}

/** OpenScreen's repair (v1.12.2 separateAudioLanes): push any same-kind pill that overlaps its predecessor later. */
export function separateAudioLanes(tracks: AudioTrack[]): AudioTrack[] {
	const shift = new Map<string, number>();
	for (const kind of ["voiceover", "music"] as const) {
		let cursor = Number.NEGATIVE_INFINITY;
		for (const pill of pills(tracks, kind)) {
			const span = Math.max(0, pill.endMs - pill.startMs);
			const start = Math.max(pill.startMs, cursor);
			if (start !== pill.startMs) shift.set(pill.id, start - pill.startMs);
			cursor = start + span;
		}
	}
	if (shift.size === 0) return tracks;
	return tracks.map((t) => {
		const by = shift.get(groupOf(t));
		return by === undefined ? t : { ...t, startMs: t.startMs + by, endMs: t.endMs + by };
	});
}
