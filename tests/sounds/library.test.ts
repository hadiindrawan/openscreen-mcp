import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBins } from "../../src/analysis/media";
import { ToolError } from "../../src/errors";
import { resolveSound, scanLibrary } from "../../src/sounds/library";
import { makeSoundFolder } from "../helpers/tones";

const bins = await findBins();

describe("scanLibrary without files", () => {
	it("explains how to set up a missing folder", async () => {
		await expect(scanLibrary("/nonexistent/sound-effects", bins.ffprobe)).rejects.toThrow(
			/Create \/nonexistent\/sound-effects\/click\//,
		);
	});

	it("treats a folder with no audio files as not set up", async () => {
		const dir = await mkdtemp(join(tmpdir(), "osmcp-lib-empty-"));
		await mkdir(join(dir, "click"));
		await writeFile(join(dir, "click", "notes.txt"), "x");
		await expect(scanLibrary(dir, bins.ffprobe)).rejects.toThrow(ToolError);
		await rm(dir, { recursive: true, force: true });
	});
});

describe.skipIf(!bins.ffmpeg || !bins.ffprobe)("scanLibrary with files", () => {
	let dir: string;
	let folder: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "osmcp-lib-"));
		folder = await makeSoundFolder(bins.ffmpeg!, dir, {
			click: [["b soft é.wav", 0.2], ["a hard.m4a", 0.3]],
			typing: [["keys.mp3", 1]],
			"(root)": [["pop.wav", 0.25]],
		});
		await writeFile(join(folder, "click", ".DS_Store"), "junk");
		await writeFile(join(folder, "click", "old.ogg"), "junk");
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));

	it("lists categories, sorted files and durations, ignoring junk", async () => {
		const lib = await scanLibrary(folder, bins.ffprobe);
		expect(Object.keys(lib.categories).sort()).toEqual(["(root)", "click", "typing"]);
		expect(lib.categories.click!.map((f) => f.name)).toEqual(["a hard.m4a", "b soft é.wav"]);
		expect(lib.categories.click![1]!.durationSec).toBeCloseTo(0.2, 2);
		expect(lib.categories.typing![0]!.durationSec).toBeCloseTo(1, 1);
	});

	it("resolves a category, a single file and a root file", async () => {
		const lib = await scanLibrary(folder, bins.ffprobe);
		expect(resolveSound(lib, "click")).toHaveLength(2);
		expect(resolveSound(lib, "click/b soft é.wav").map((f) => f.name)).toEqual(["b soft é.wav"]);
		expect(resolveSound(lib, "pop.wav")[0]!.category).toBe("(root)");
	});

	it("names what exists when the sound is unknown", async () => {
		const lib = await scanLibrary(folder, bins.ffprobe);
		expect(() => resolveSound(lib, "whoosh")).toThrow(/click, typing/);
		expect(() => resolveSound(lib, "click/nope.wav")).toThrow(/a hard\.m4a/);
	});
});

describe.skipIf(!bins.ffmpeg || !bins.ffprobe)("symlinked sound folders", () => {
	it("follows symlinked categories and files and ignores broken links", async () => {
		const dir = await mkdtemp(join(tmpdir(), "osmcp-lib-links-"));
		const real = await makeSoundFolder(bins.ffmpeg!, dir, { "real-click": [["a.wav", 0.2]], "real-root": [["pop.wav", 0.25]] });
		const folder = join(dir, "linked");
		await mkdir(folder);
		await symlink(join(real, "real-click"), join(folder, "click"));
		await symlink(join(real, "real-root", "pop.wav"), join(folder, "pop.wav"));
		await symlink(join(dir, "missing.wav"), join(folder, "broken.wav"));
		await mkdir(join(folder, "typing"));
		await symlink(join(dir, "missing.wav"), join(folder, "typing", "dead.wav"));
		const lib = await scanLibrary(folder, bins.ffprobe);
		expect(Object.keys(lib.categories).sort()).toEqual(["(root)", "click"]);
		expect(lib.categories.click!.map((f) => f.name)).toEqual(["a.wav"]);
		expect(lib.categories["(root)"]!.map((f) => f.name)).toEqual(["pop.wav"]);
		await rm(dir, { recursive: true, force: true });
	});
});
