import { describe, expect, it } from "vitest";
import { describeProject } from "../../src/describe";
import { allRegions, removeRegion } from "../../src/edit/regions";
import { updateRegion } from "../../src/edit/update";
import { placeSounds, type SoundEvent } from "../../src/sounds/place";
import { twoClipDoc } from "../helpers/docs";

const ev = (at: number, durationSec: number): SoundEvent => ({ at, assetId: "asset_x", durationSec, gainDb: -8, label: "SFX click · a.wav" });
const noCursor = () => null;

describe("sounds as regions", () => {
	// One sound spanning the clip boundary (two fragments) and one inside clip_b.
	const placed = placeSounds(twoClipDoc(), [ev(9.5, 1), ev(15, 0.3)]);

	it("describes each sound once, spanning its fragments", () => {
		expect(describeProject(placed.doc).sounds).toEqual([
			{ id: placed.ids[0], start: 9.5, end: 10.5, label: "SFX click · a.wav", volumeDb: -8, loop: false, lane: "voiceover" },
			{ id: placed.ids[1], start: 15, end: 15.3, label: "SFX click · a.wav", volumeDb: -8, loop: false, lane: "voiceover" },
		]);
		expect(allRegions(placed.doc).filter((r) => r.kind === "sound")).toHaveLength(2);
	});

	it("removes every fragment of a sound", () => {
		const { doc } = removeRegion(placed.doc, placed.ids[0]!);
		expect(doc.audioTracks.map((t) => t.trackId)).toEqual([placed.ids[1]]);
	});

	it("changes a sound's volume on all fragments, clamped", () => {
		const { doc } = updateRegion(placed.doc, { id: placed.ids[0]!, volume: 30 }, noCursor);
		expect(doc.audioTracks.filter((t) => t.trackId === placed.ids[0]).map((t) => t.gainDb)).toEqual([12, 12]);
	});

	it("refuses to move a sound", () => {
		expect(() => updateRegion(placed.doc, { id: placed.ids[0]!, start: 3 }, noCursor)).toThrow(/removing it and adding it again/);
		expect(() => updateRegion(placed.doc, { id: placed.ids[0]! }, noCursor)).toThrow(/only change volume/);
	});
});
