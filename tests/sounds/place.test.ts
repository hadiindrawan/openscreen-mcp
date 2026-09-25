import { describe, expect, it } from "vitest";
import { cutRange } from "../../src/edit/cut";
import type { AudioTrack } from "../../src/project/types";
import { placeSounds, type SoundEvent } from "../../src/sounds/place";
import { documentSchema } from "../../src/vendor/openscreen-schema";
import { singleClipDoc, twoClipDoc } from "../helpers/docs";
import { separateAudioLanes } from "../helpers/lanes";

const ev = (at: number, durationSec = 0.3, extra: Partial<SoundEvent> = {}): SoundEvent => ({
	at,
	assetId: "asset_click",
	durationSec,
	gainDb: -8,
	label: "SFX click · a.wav",
	...extra,
});
const spans = (tracks: AudioTrack[]) => tracks.map((t) => [t.startMs, t.endMs]);
const valid = (doc: unknown) => documentSchema.safeParse(doc).error?.issues ?? [];

describe("placeSounds", () => {
	it("writes a fully specified voiceover track per event", () => {
		const { doc, ids, skipped } = placeSounds(singleClipDoc(), [ev(2)]);
		expect(skipped).toEqual([]);
		expect(doc.audioTracks[0]).toEqual({
			id: ids[0],
			trackId: ids[0],
			startMs: 2000,
			endMs: 2300,
			clipId: "clip_a",
			sourceStartSec: 2,
			sourceEndSec: 2.3,
			assetId: "asset_click",
			kind: "voiceover",
			durationSec: 0.3,
			offsetMs: 0,
			gainDb: -8,
			loop: false,
			fadeInMs: 0,
			fadeOutMs: 0,
			muted: false,
			label: "SFX click · a.wav",
			origin: "agent",
		});
		expect(ids[0]).toMatch(/^audio_/);
	});

	it("trims a sound to the next event and fades the trimmed tail", () => {
		const { doc } = placeSounds(singleClipDoc(), [ev(2.2), ev(2)]);
		expect(spans(doc.audioTracks)).toEqual([[2000, 2200], [2200, 2500]]);
		expect(doc.audioTracks.map((t) => t.fadeOutMs)).toEqual([20, 0]);
	});

	it("never overlaps an existing voiceover pill, but ignores music", () => {
		const base = singleClipDoc();
		const pill = (id: string, kind: "voiceover" | "music", startMs: number, endMs: number): AudioTrack => ({
			...placeSounds(singleClipDoc(), [ev(0)]).doc.audioTracks[0]!,
			id, trackId: id, kind, startMs, endMs, sourceStartSec: startMs / 1000, sourceEndSec: endMs / 1000, label: `existing ${id}`,
		});
		base.audioTracks = [pill("audio_vo", "voiceover", 5000, 8000), pill("audio_bgm", "music", 0, 30000)];
		const { doc, skipped } = placeSounds(base, [ev(4.9), ev(6), ev(9)]);
		expect(skipped).toEqual([{ at: 6, reason: "inside another sound" }]);
		const mine = doc.audioTracks.filter((t) => t.label.startsWith("SFX"));
		expect(spans(mine)).toEqual([[4900, 5000], [9000, 9300]]);
	});

	it("skips events inside cuts and outside the timeline", () => {
		const cut = cutRange(singleClipDoc(), { start: 10, end: 12, reason: "x" }).doc;
		const { skipped } = placeSounds(cut, [ev(11), ev(40), ev(1)]);
		expect(skipped).toEqual([
			{ at: 11, reason: "inside a cut" },
			{ at: 40, reason: "outside the timeline (0–30s)" },
		]);
	});

	it("drops a sound that would be shorter than 60 ms", () => {
		const { skipped, doc } = placeSounds(singleClipDoc(), [ev(2), ev(2.05)]);
		expect(skipped).toEqual([{ at: 2, reason: "too short to fit before the next sound (50 ms)" }]);
		expect(doc.audioTracks).toHaveLength(1);
	});

	it("clamps to the end of the timeline", () => {
		const { doc } = placeSounds(singleClipDoc(), [ev(29.9)]);
		expect(spans(doc.audioTracks)).toEqual([[29900, 30000]]);
	});

	it("loops a typing sound over a stretch", () => {
		const { doc } = placeSounds(singleClipDoc(), [ev(5, 1, { loopUntil: 9 })]);
		expect(doc.audioTracks[0]).toMatchObject({ startMs: 5000, endMs: 9000, loop: true, offsetMs: 0, fadeOutMs: 0 });
	});

	it("anchors across clips with a continuing offset", () => {
		// twoClipDoc: timeline 0–10 = source 0–10, 10–20 = source 20–30.
		const { doc, ids } = placeSounds(twoClipDoc(), [ev(9.5, 1)]);
		expect(doc.audioTracks.map((t) => [t.clipId, t.startMs, t.endMs, t.offsetMs, t.trackId])).toEqual([
			["clip_a", 9500, 10000, 0, ids[0]],
			["clip_b", 10000, 10500, 500, ids[0]],
		]);
	});

	it("produces a lane OpenScreen has nothing to repair", () => {
		const { doc } = placeSounds(singleClipDoc(), [ev(1, 1), ev(1.4, 1), ev(1.5, 0.3), ev(20, 2, { loopUntil: 25 }), ev(24)]);
		expect(separateAudioLanes(doc.audioTracks)).toEqual(doc.audioTracks);
		expect(valid(doc)).toEqual([]);
	});

	it("has a lane oracle that really moves overlapping pills (self-check)", () => {
		const one = placeSounds(singleClipDoc(), [ev(2, 1)]).doc.audioTracks[0]!;
		const overlapping = [one, { ...one, id: "audio_b", trackId: "audio_b", startMs: 2500, endMs: 3500 }];
		const repaired = separateAudioLanes(overlapping);
		expect(spans(repaired)).toEqual([[2000, 3000], [3000, 4000]]);
	});

	it("refuses when nothing could be placed, saying why", () => {
		expect(() => placeSounds(singleClipDoc(), [ev(40)])).toThrow(/No sound was placed: 40s outside the timeline/);
	});
});
