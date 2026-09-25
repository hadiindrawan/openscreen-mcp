import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "../../src/errors";
import { clampDb, expandHome, loadSoundsConfig, volumeFor } from "../../src/sounds/config";

let dir: string;
let file: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "osmcp-sounds-config-"));
	file = join(dir, "sounds.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("sounds config", () => {
	it("defaults to ~/sound-effects and the per-category volumes", async () => {
		const c = await loadSoundsConfig(file, "/Users/x");
		expect(c.folder).toBe("/Users/x/sound-effects");
		expect(volumeFor(c, "click")).toBe(-8);
		expect(volumeFor(c, "typing")).toBe(-12);
		expect(volumeFor(c, "whoosh")).toBe(-4);
		expect(volumeFor(c, "pop")).toBe(-6);
		expect(volumeFor(c, "ding")).toBe(-6);
	});

	it("reads folder and volume overrides, clamped to -60…12", async () => {
		await writeFile(file, JSON.stringify({ folder: "~/sfx", volumeDb: { click: -3, boom: 40, hush: -99 } }));
		const c = await loadSoundsConfig(file, "/Users/x");
		expect(c.folder).toBe("/Users/x/sfx");
		expect(volumeFor(c, "click")).toBe(-3);
		expect(volumeFor(c, "typing")).toBe(-12);
		expect(volumeFor(c, "boom")).toBe(12);
		expect(volumeFor(c, "hush")).toBe(-60);
	});

	it("names the file when it is malformed", async () => {
		await writeFile(file, "{ nope");
		await expect(loadSoundsConfig(file)).rejects.toThrow(file);
		await writeFile(file, JSON.stringify({ folders: "x" }));
		await expect(loadSoundsConfig(file)).rejects.toThrow(ToolError);
	});

	it("expands ~ only at the start and clamps dB", () => {
		expect(expandHome("~/a", "/h")).toBe("/h/a");
		expect(expandHome("/a/~/b", "/h")).toBe("/a/~/b");
		expect(clampDb(20)).toBe(12);
		expect(clampDb(-70)).toBe(-60);
	});
});
