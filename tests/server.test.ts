import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server";
import type { ToolContext } from "../src/tools/context";
import { makeTestContext, PROJECT_ID } from "./helpers/context";

type Content = { type: string; text?: string; data?: string; mimeType?: string }[];
let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(cleanups.map((c) => c()));
	cleanups = [];
});

async function setup(opts: { appRunning?: boolean } = {}) {
	const t = await makeTestContext(opts);
	cleanups.push(t.cleanup);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await createServer(t.ctx).connect(serverTransport);
	const client = new Client({ name: "test", version: "0.0.0" });
	await client.connect(clientTransport);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args });
		return { isError: Boolean(result.isError), content: result.content as Content };
	};
	const json = async (name: string, args: Record<string, unknown> = {}) => {
		const r = await call(name, args);
		if (r.isError) throw new Error(r.content[0]?.text);
		return JSON.parse(r.content[0]!.text!);
	};
	return { ...t, client, call, json };
}

const projectFile = (ctx: ToolContext) => join(ctx.paths.projectsDir, `${PROJECT_ID}.openscreen`);

describe("MCP server", () => {
	it("exposes the 17 tools", async () => {
		const { client } = await setup();
		const names = (await client.listTools()).tools.map((t) => t.name).sort();
		expect(names).toEqual([
			"add_blur", "add_text", "add_zoom", "analyze_recording", "apply_censor", "cut_range",
			"describe_project", "find_text", "get_frames", "list_projects", "preview_censor",
			"remove_region", "scan_sensitive", "set_speed", "transcribe", "undo_last_edit", "update_region",
		]);
	});

	it("lists and describes projects", async () => {
		const { json } = await setup();
		expect((await json("list_projects")).map((p: { id: string }) => p.id)).toEqual([PROJECT_ID]);
		expect((await json("describe_project", { project: "latest" })).durationSec).toBe(6);
	});

	it("adds a cursor-following zoom and writes it to disk", async () => {
		const { json, ctx } = await setup();
		const result = await json("add_zoom", { start: 1, end: 3, depth: 3 });
		expect(result.changedIds).toHaveLength(1);
		expect(result.project.zooms[0]).toMatchObject({ start: 1, end: 3, depth: 3, focus: { cx: 0.6, cy: 0.4 }, focusMode: "auto" });
		expect(result.reminder).toMatch(/Reopen/);
		const onDisk = JSON.parse(await readFile(projectFile(ctx), "utf8"));
		expect(onDisk.zoomRanges[0].id).toBe(result.changedIds[0]);
	});

	it("cuts, annotates, speeds up, updates, removes and undoes", async () => {
		const { json } = await setup();
		const cut = await json("cut_range", { start: 4, end: 6, reason: "idle" });
		await json("add_text", { start: 0, end: 2, text: "Welcome", placement: "top" });
		await json("add_blur", { start: 0, end: 6, rect: { x: 60, y: 5, width: 30, height: 8 } });
		const speed = await json("set_speed", { start: 2, end: 4, speed: 2 });
		const updated = await json("update_region", { id: speed.changedIds[0], speed: 3 });
		expect(updated.project.speeds[0].speed).toBe(3);
		const removed = await json("remove_region", { id: cut.changedIds[0] });
		expect(removed.project.cuts).toEqual([]);
		const undone = await json("undo_last_edit", {});
		expect(undone.project.cuts).toHaveLength(1);
		expect(undone.project.texts[0].text).toBe("Welcome");
	});

	it("refuses edits while OpenScreen is running but still reads", async () => {
		const { call, json } = await setup({ appRunning: true });
		expect((await json("describe_project")).durationSec).toBe(6);
		const r = await call("add_zoom", { start: 1, end: 3, depth: 3 });
		expect(r.isError).toBe(true);
		expect(r.content[0]!.text).toMatch(/Quit OpenScreen/);
	});

	it("returns readable errors", async () => {
		const { call } = await setup();
		const r = await call("add_zoom", { start: 10, end: 12, depth: 3 });
		expect(r.isError).toBe(true);
		expect(r.content[0]!.text).toMatch(/outside the timeline \(0–6s\)/);
	});

	it("returns frames as images with captions", async () => {
		const { call, ctx } = await setup();
		if (!ctx.bins.ffmpeg) return;
		const r = await call("get_frames", { times: [1] });
		expect(r.isError).toBe(false);
		expect(r.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/^t=1\.00s: click/) });
		expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
	});
	it("scans a project with no sensitive text over MCP", async () => {
		const { json, ctx } = await setup();
		if (!ctx.bins.ffmpeg || !ctx.bins.swiftc) return;
		const result = await json("scan_sensitive", {});
		expect(result.findings).toEqual([]);
		expect(result.config.path).toBe(ctx.paths.censorConfig);
	});
});
