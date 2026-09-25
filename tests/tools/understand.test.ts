import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze, describe as describeTool, frames, listProjects, transcribe } from "../../src/tools/understand";
import { makeTestContext, PROJECT_ID } from "../helpers/context";

let t: Awaited<ReturnType<typeof makeTestContext>>;
beforeEach(async () => {
	t = await makeTestContext();
});
afterEach(() => t.cleanup());

describe("list and describe", () => {
	it("lists the project", async () => {
		expect((await listProjects(t.ctx)).map((p) => p.id)).toEqual([PROJECT_ID]);
	});

	it("describes the latest project", async () => {
		const d = await describeTool(t.ctx, "latest");
		expect(d.durationSec).toBe(6);
		expect(d.clips).toHaveLength(1);
	});
});

describe("analyze", () => {
	it("turns cursor data into timeline events", async () => {
		const result = await analyze(t.ctx, "latest", ["cursor"]);
		expect(result.events).toEqual([
			{ at: 1, kind: "click", cx: 0.6, cy: 0.4 },
			{ at: 1, end: 4, kind: "dwell", cx: 0.6, cy: 0.4 },
			{ at: 4, end: 6, kind: "idle", cx: 0.2, cy: 0.8 },
		]);
		expect(result.notes).toEqual([]);
	});

	it("asks for transcribe before speech is available", async () => {
		const result = await analyze(t.ctx, "latest", ["transcript"]);
		expect(result.notes.join(" ")).toMatch(/call transcribe first/);
	});

	it("finds the scene change", async () => {
		if (!t.ctx.bins.ffmpeg) return;
		const result = await analyze(t.ctx, "latest", ["scenes"]);
		const scenes = result.events.filter((e) => e.kind === "scene" && e.at > 0.1);
		expect(scenes).toHaveLength(1);
		expect(scenes[0]!.at).toBeCloseTo(3, 1);
	});
});

describe("frames", () => {
	it("returns a captioned JPEG at a timeline time", async () => {
		if (!t.ctx.bins.ffmpeg) return;
		const [frame, ...rest] = await frames(t.ctx, "latest", { times: [1], max: 8 });
		expect(rest).toEqual([]);
		expect(frame!.caption).toBe("t=1.00s: click at (0.6, 0.4); cursor rests at (0.6, 0.4) until 4.00s");
		expect([...frame!.jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
	});

	it("picks frames at every click", async () => {
		if (!t.ctx.bins.ffmpeg) return;
		expect((await frames(t.ctx, "latest", { at: "clicks", max: 8 })).map((f) => f.at)).toEqual([1]);
	});

	it("spreads evenly spaced frames over the timeline", async () => {
		if (!t.ctx.bins.ffmpeg) return;
		expect((await frames(t.ctx, "latest", { at: "evenly", max: 3 })).map((f) => f.at)).toEqual([1, 3, 5]);
	});

	it("rejects a time outside the timeline", async () => {
		if (!t.ctx.bins.ffmpeg) return;
		await expect(frames(t.ctx, "latest", { times: [99], max: 8 })).rejects.toThrow(/outside the timeline/);
	});
});

describe("transcribe", () => {
	it("explains how to install whisper-cli when it is missing", async () => {
		t.ctx.bins = { ...t.ctx.bins, whisper: null };
		await expect(transcribe(t.ctx, "latest")).rejects.toThrow(/brew install whisper-cpp/);
	});

	it("reports a recording without audio", async () => {
		if (!t.ctx.bins.ffmpeg || !t.ctx.bins.ffprobe) return;
		t.ctx.bins = { ...t.ctx.bins, whisper: "/usr/bin/true" };
		await mkdir(dirname(t.ctx.paths.whisperModel), { recursive: true });
		await writeFile(t.ctx.paths.whisperModel, "fake model");
		expect(await transcribe(t.ctx, "latest")).toEqual([{ video: "test.mp4", status: "no audio stream" }]);
	});
});
