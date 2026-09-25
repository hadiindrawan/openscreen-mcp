import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findText, loadFreshScan, scanProject } from "../../src/censor/scan";
import { makeTestContext, PROJECT_ID } from "../helpers/context";
import { censorFixtureFrames, makeTextVideo } from "../helpers/render";

let t: Awaited<ReturnType<typeof makeTestContext>>;
beforeEach(async () => {
	t = await makeTestContext();
});
afterEach(() => t.cleanup());

const ready = () => Boolean(t.ctx.bins.ffmpeg && t.ctx.bins.swiftc);

/** Point the test project at a freshly rendered text video. */
async function useTextVideo(): Promise<string> {
	const video = await makeTextVideo(t.ctx.bins.ffmpeg!, t.ctx.bins.swiftc!, t.dir, censorFixtureFrames());
	const file = join(t.ctx.paths.projectsDir, `${PROJECT_ID}.openscreen`);
	const doc = JSON.parse(await readFile(file, "utf8"));
	doc.assets[0].originalPath = video;
	await writeFile(file, JSON.stringify(doc, null, 2));
	return video;
}

describe("scanProject", () => {
	it("finds the email, the key and the scrolling column", async () => {
		if (!ready()) return;
		await useTextVideo();
		const result = await scanProject(t.ctx, "latest", {});
		const byLabel = Object.fromEntries(result.findings.map((f) => [f.label, f]));
		expect(Object.keys(byLabel).sort()).toEqual(["API keys and tokens", "Balance column", "Email addresses"]);
		expect(byLabel["Email addresses"]).toMatchObject({ category: "emails", examples: ["al•••"], time: "0.00–6.00s", blurs: 1 });
		expect(byLabel["Balance column"]).toMatchObject({ category: "money", blurs: 2 });
		expect(result.findings.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
		expect(result.notes).toEqual([]);
		expect(result.config.path).toBe(t.ctx.paths.censorConfig);
	});

	it("returns no findings for a recording without sensitive text", async () => {
		if (!ready()) return;
		const result = await scanProject(t.ctx, "latest", {}); // the red/blue test video
		expect(result.findings).toEqual([]);
	});

	it("reports a missing video instead of failing", async () => {
		const file = join(t.ctx.paths.projectsDir, `${PROJECT_ID}.openscreen`);
		const doc = JSON.parse(await readFile(file, "utf8"));
		doc.assets[0].originalPath = join(t.dir, "gone.mp4");
		await writeFile(file, JSON.stringify(doc, null, 2));
		const result = await scanProject(t.ctx, "latest", {});
		expect(result.findings).toEqual([]);
		expect(result.notes.join(" ")).toMatch(/Video missing/);
	});

	it("restricts to requested categories", async () => {
		if (!ready()) return;
		await useTextVideo();
		const result = await scanProject(t.ctx, "latest", { categories: ["emails"] });
		expect(result.findings.map((f) => f.label)).toEqual(["Email addresses"]);
	});
});

describe("findText", () => {
	it("adds a finding for any text the rules missed", async () => {
		if (!ready()) return;
		await useTextVideo();
		await scanProject(t.ctx, "latest", {});
		const [added] = await findText(t.ctx, "latest", "token", "Token label");
		expect(added).toMatchObject({ id: "f4", category: "custom", label: "Token label", time: "0.00–6.00s" });
		const { scan } = await loadFreshScan(t.ctx, "latest");
		expect(scan.findings).toHaveLength(4);
	});

	it("says so when the text never appears", async () => {
		if (!ready()) return;
		await useTextVideo();
		await expect(findText(t.ctx, "latest", "nowhere-to-be-seen")).rejects.toThrow(/does not appear/);
	});
});

describe("loadFreshScan", () => {
	it("refuses when there is no scan", async () => {
		await expect(loadFreshScan(t.ctx, "latest")).rejects.toThrow(/Run scan_sensitive again/);
	});
});
