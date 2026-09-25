import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolError } from "../../src/errors";
import { type Paths, resolvePaths } from "../../src/paths";
import { APP_OPEN_MESSAGE, createStore } from "../../src/project/store";
import type { Doc } from "../../src/project/types";
import { singleClipDoc } from "../helpers/docs";

const ID = "proj_test";
const notRunning = async () => false;
let dir: string;
let paths: Paths;
let file: string;
let original: string;

async function writeProject(id: string, doc: Doc): Promise<string> {
	const text = JSON.stringify(doc, null, 2);
	await writeFile(join(paths.projectsDir, `${id}.openscreen`), text);
	return text;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "osmcp-store-"));
	paths = resolvePaths({ OPENSCREEN_DATA_DIR: dir });
	await mkdir(paths.projectsDir, { recursive: true });
	file = join(paths.projectsDir, `${ID}.openscreen`);
	original = await writeProject(ID, singleClipDoc());
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("resolvePaths", () => {
	it("derives every directory from the data dir", () => {
		expect(paths).toEqual({
			dataDir: dir,
			projectsDir: join(dir, "projects"),
			backupsDir: join(dir, "mcp-backups"),
			cacheDir: join(dir, "mcp-cache"),
			whisperModel: join(dir, "stt-models", "whisper-ggml", "ggml-small-q8_0.bin"),
		});
	});
});

describe("store.list / load", () => {
	it("lists projects newest first with counts", async () => {
		const newer = singleClipDoc();
		newer.project.updatedAt = "2099-01-01T00:00:00.000Z";
		await writeProject("proj_newer", newer);
		const list = await createStore(paths, notRunning).list();
		expect(list.map((p) => p.id)).toEqual(["proj_newer", ID]);
		expect(list[1]).toMatchObject({
			durationSec: 30,
			counts: { zooms: 0, cuts: 0, texts: 0, blurs: 0, speeds: 0 },
		});
	});

	it("resolves latest", async () => {
		const loaded = await createStore(paths, notRunning).load("latest");
		expect(loaded.id).toBe(ID);
		expect(loaded.path).toBe(file);
	});

	it("rejects an id that could escape the projects folder", async () => {
		await expect(createStore(paths, notRunning).load("../secrets")).rejects.toThrow(ToolError);
	});

	it("rejects a non-v7 project", async () => {
		await writeProject(ID, { ...singleClipDoc(), schemaVersion: 6 } as unknown as Doc);
		await expect(createStore(paths, notRunning).load(ID)).rejects.toThrow(/supports only 7/);
	});

	it("reports a missing project", async () => {
		await expect(createStore(paths, notRunning).load("proj_nope")).rejects.toThrow(/not found/);
	});
});

describe("store.save", () => {
	it("writes atomically, backs up the previous bytes and journals the write", async () => {
		const store = createStore(paths, notRunning);
		const loaded = await store.load(ID);
		const next = structuredClone(loaded.doc);
		next.project.title = "Edited";
		const saved = await store.save(loaded, next);

		const onDisk = JSON.parse(await readFile(file, "utf8")) as Doc;
		expect(onDisk.project.title).toBe("Edited");
		expect(saved.doc.project.title).toBe("Edited");

		const backupDir = join(paths.backupsDir, ID);
		const backups = (await readdir(backupDir)).filter((f) => f.endsWith(".openscreen"));
		expect(backups).toHaveLength(1);
		expect(await readFile(join(backupDir, backups[0]!), "utf8")).toBe(original);
		const journal = JSON.parse(await readFile(join(backupDir, "journal.json"), "utf8"));
		expect(journal).toHaveLength(1);
		expect(journal[0].writtenSha256).toBe(saved.sha256);
		expect((await readdir(paths.projectsDir)).filter((f) => f.includes(".tmp"))).toEqual([]);
	});

	it("keeps only the newest 20 backups", async () => {
		const store = createStore(paths, notRunning);
		for (let i = 0; i < 22; i++) {
			const loaded = await store.load(ID);
			const next = structuredClone(loaded.doc);
			next.project.title = `Edit ${i}`;
			await store.save(loaded, next);
		}
		const backupDir = join(paths.backupsDir, ID);
		const backups = (await readdir(backupDir)).filter((f) => f.endsWith(".openscreen"));
		expect(backups).toHaveLength(20);
		expect(JSON.parse(await readFile(join(backupDir, "journal.json"), "utf8"))).toHaveLength(20);
	});

	it("refuses to save while OpenScreen is running", async () => {
		const store = createStore(paths, async () => true);
		const loaded = await store.load(ID);
		await expect(store.save(loaded, loaded.doc)).rejects.toThrow(APP_OPEN_MESSAGE);
		expect(await readFile(file, "utf8")).toBe(original);
	});

	it("refuses a stale write", async () => {
		const store = createStore(paths, notRunning);
		const loaded = await store.load(ID);
		await writeFile(file, `${original}\n`);
		await expect(store.save(loaded, loaded.doc)).rejects.toThrow(/changed on disk/);
	});

	it("refuses an invalid document and writes nothing", async () => {
		const store = createStore(paths, notRunning);
		const loaded = await store.load(ID);
		const next = structuredClone(loaded.doc);
		(next.zoomRanges as unknown[]).push({ id: "zoom_bad" });
		await expect(store.save(loaded, next)).rejects.toThrow(/Nothing was written/);
		expect(await readFile(file, "utf8")).toBe(original);
	});

	it("preserves fields the schema does not know", async () => {
		await writeProject(ID, { ...singleClipDoc(), futureField: { kept: true } } as Doc);
		const store = createStore(paths, notRunning);
		const loaded = await store.load(ID);
		await store.save(loaded, loaded.doc);
		expect(JSON.parse(await readFile(file, "utf8")).futureField).toEqual({ kept: true });
	});
});

describe("store.undo", () => {
	it("restores the exact previous bytes", async () => {
		const store = createStore(paths, notRunning);
		const loaded = await store.load(ID);
		const next = structuredClone(loaded.doc);
		next.project.title = "Edited";
		await store.save(loaded, next);
		const restored = await store.undo(ID);
		expect(await readFile(file, "utf8")).toBe(original);
		expect(restored.doc.project.title).toBe(singleClipDoc().project.title);
	});

	it("refuses after the project was changed outside the server", async () => {
		const store = createStore(paths, notRunning);
		const loaded = await store.load(ID);
		await store.save(loaded, loaded.doc);
		await writeFile(file, original);
		await expect(store.undo(ID)).rejects.toThrow(/changed after the last edit/);
	});

	it("says when there is nothing to undo", async () => {
		await expect(createStore(paths, notRunning).undo(ID)).rejects.toThrow(/no edit/i);
	});

	it("refuses while OpenScreen is running", async () => {
		await expect(createStore(paths, async () => true).undo(ID)).rejects.toThrow(APP_OPEN_MESSAGE);
	});
});
