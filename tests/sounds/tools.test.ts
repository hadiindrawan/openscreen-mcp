import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSound, addSoundsOnClicks, addTyping, findTyping, listSounds } from "../../src/tools/sounds";
import { makeTestContext } from "../helpers/context";
import { separateAudioLanes } from "../helpers/lanes";
import { makeSoundFolder } from "../helpers/tones";

let t: Awaited<ReturnType<typeof makeTestContext>>;
beforeEach(async () => {
	t = await makeTestContext(); // 6 s project; cursor clicks at 1 s only (CURSOR_SAMPLES)
});
afterEach(() => t.cleanup());

const ready = () => Boolean(t.ctx.bins.ffmpeg && t.ctx.bins.ffprobe);

async function useFolder(spec: Record<string, [string, number][]>) {
	const folder = await makeSoundFolder(t.ctx.bins.ffmpeg!, t.dir, spec);
	await mkdir(dirname(t.ctx.paths.soundsConfig), { recursive: true });
	await writeFile(t.ctx.paths.soundsConfig, JSON.stringify({ folder }));
	return folder;
}

describe("sound tools", () => {
	it("tells the user how to set up a missing folder", async () => {
		await mkdir(dirname(t.ctx.paths.soundsConfig), { recursive: true });
		await writeFile(t.ctx.paths.soundsConfig, JSON.stringify({ folder: join(t.dir, "none") }));
		await expect(listSounds(t.ctx)).rejects.toThrow(/Create .*none\/click\//);
	});

	it("lists categories with default volumes", async () => {
		if (!ready()) return;
		await useFolder({ click: [["a.wav", 0.2]], whoosh: [["w.wav", 0.5]] });
		const list = await listSounds(t.ctx);
		expect(list.categories).toEqual([
			{ name: "click", volumeDb: -8, files: [{ name: "a.wav", durationSec: expect.closeTo(0.2, 2) }] },
			{ name: "whoosh", volumeDb: -4, files: [{ name: "w.wav", durationSec: expect.closeTo(0.5, 2) }] },
		]);
	});

	it("puts a click sound on every click, in one undoable save", async () => {
		if (!ready()) return;
		await useFolder({ click: [["a.wav", 0.2], ["b.wav", 0.2]] });
		const result = await addSoundsOnClicks(t.ctx, "latest");
		expect(result.skipped).toEqual([]);
		expect(result.project.sounds).toEqual([
			{ id: result.changedIds[0], start: 1, end: 1.2, label: "SFX click · a.wav", volumeDb: -8, loop: false, lane: "voiceover" },
		]);
		const loaded = await t.ctx.store.load("latest");
		expect(loaded.doc.assets.filter((a) => a.kind === "audio")).toHaveLength(1);
		expect(await readdir(t.ctx.paths.mediaDir)).toHaveLength(1);
		expect(separateAudioLanes(loaded.doc.audioTracks)).toEqual(loaded.doc.audioTracks);
		await t.ctx.store.undo("latest");
		expect((await t.ctx.store.load("latest")).doc.audioTracks).toEqual([]);
	});

	it("does not stack duplicates when run twice", async () => {
		if (!ready()) return;
		await useFolder({ click: [["a.wav", 0.2]] });
		await addSoundsOnClicks(t.ctx, "latest");
		await expect(addSoundsOnClicks(t.ctx, "latest")).rejects.toThrow(/No sound was placed: 1s inside another sound/);
	});

	it("adds one sound, a looped typing stretch, and reuses the asset", async () => {
		if (!ready()) return;
		await useFolder({ whoosh: [["w.wav", 0.5]], typing: [["k.wav", 1]] });
		await addSound(t.ctx, "latest", "whoosh", 0.2, -10);
		const typed = await addTyping(t.ctx, "latest", 3, 5.5);
		expect(typed.project.sounds.map((s: { start: number; end: number; loop: boolean; volumeDb: number }) => [s.start, s.end, s.loop, s.volumeDb])).toEqual([
			[0.2, 0.7, false, -10],
			[3, 5.5, true, -12],
		]);
		await addSound(t.ctx, "latest", "whoosh/w.wav", 2);
		const doc = (await t.ctx.store.load("latest")).doc;
		expect(doc.assets.filter((a) => a.kind === "audio")).toHaveLength(2);
	});

	it("rejects a typing stretch that ends before it starts", async () => {
		if (!ready()) return;
		await useFolder({ typing: [["k.wav", 1]] });
		await expect(addTyping(t.ctx, "latest", 4, 3)).rejects.toThrow(/after start/);
	});

	it("returns typing candidates as hints", async () => {
		if (!ready() || !t.ctx.bins.swiftc) return;
		const result = await findTyping(t.ctx, "latest"); // red/blue video: no text
		expect(result.candidates).toEqual([]);
		expect(result.note).toMatch(/get_frames/);
	});
});
