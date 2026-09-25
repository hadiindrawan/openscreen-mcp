import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCensor, previewCensor, scanProject } from "../../src/censor/scan";
import { documentSchema } from "../../src/vendor/openscreen-schema";
import { makeTestContext, PROJECT_ID } from "../helpers/context";
import { censorFixtureFrames, makeTextVideo } from "../helpers/render";

let t: Awaited<ReturnType<typeof makeTestContext>>;
beforeEach(async () => {
	t = await makeTestContext();
	if (!t.ctx.bins.ffmpeg || !t.ctx.bins.swiftc) return;
	const video = await makeTextVideo(t.ctx.bins.ffmpeg, t.ctx.bins.swiftc, t.dir, censorFixtureFrames());
	const file = join(t.ctx.paths.projectsDir, `${PROJECT_ID}.openscreen`);
	const doc = JSON.parse(await readFile(file, "utf8"));
	doc.assets[0].originalPath = video;
	await writeFile(file, JSON.stringify(doc, null, 2));
});
afterEach(() => t.cleanup());

const ready = () => Boolean(t.ctx.bins.ffmpeg && t.ctx.bins.swiftc);
const idOf = (findings: { id: string; label: string }[], label: string) => findings.find((f) => f.label === label)!.id;

describe("previewCensor", () => {
	it("draws the boxes and names the findings in the caption", async () => {
		if (!ready()) return;
		const { findings } = await scanProject(t.ctx, "latest", {});
		const email = idOf(findings, "Email addresses");
		const [frame] = await previewCensor(t.ctx, "latest", { findings: [email], times: [1], max: 8 });
		expect(frame!.caption).toBe(`t=1.00s: ${email} Email addresses`);
		expect([...frame!.jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
	});

	it("picks one frame per finding by default", async () => {
		if (!ready()) return;
		const { findings } = await scanProject(t.ctx, "latest", {});
		const frames = await previewCensor(t.ctx, "latest", { max: 8 });
		expect(frames.length).toBeGreaterThanOrEqual(1);
		expect(frames.length).toBeLessThanOrEqual(findings.length);
	});
});

describe("applyCensor", () => {
	it("writes every chosen blur in one save and one undo", async () => {
		if (!ready()) return;
		const { findings } = await scanProject(t.ctx, "latest", {});
		const ids = findings.map((f) => f.id);
		const result = await applyCensor(t.ctx, "latest", ids, { style: "mosaic", intensity: 16 });
		expect(result.changedIds).toHaveLength(4); // email 1 + key 1 + column 2
		expect(result.project.blurs).toHaveLength(4);
		const onDisk = JSON.parse(await readFile(join(t.ctx.paths.projectsDir, `${PROJECT_ID}.openscreen`), "utf8"));
		expect(documentSchema.safeParse(onDisk).success).toBe(true);
		await t.ctx.store.undo("latest");
		expect((await t.ctx.store.load("latest")).doc.annotations).toEqual([]);
	});

	it("refuses to apply a stale scan", async () => {
		if (!ready()) return;
		const { findings } = await scanProject(t.ctx, "latest", {});
		await applyCensor(t.ctx, "latest", [findings[0]!.id], { style: "mosaic", intensity: 16 });
		await expect(
			applyCensor(t.ctx, "latest", [findings[0]!.id], { style: "mosaic", intensity: 16 }),
		).rejects.toThrow(/Run scan_sensitive again/);
	});

	it("rejects unknown finding ids", async () => {
		if (!ready()) return;
		await scanProject(t.ctx, "latest", {});
		await expect(applyCensor(t.ctx, "latest", ["f99"], { style: "mosaic", intensity: 16 })).rejects.toThrow(/f99/);
	});
});
