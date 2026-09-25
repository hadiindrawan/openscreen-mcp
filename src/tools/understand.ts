import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { type CursorSample, findClicks, findStillStretches, loadCursorSamples } from "../analysis/cursor";
import { extractFrame } from "../analysis/frames";
import { fileExists, hasAudio, requireBin } from "../analysis/media";
import { detectScenes } from "../analysis/scenes";
import { type Transcript, transcribeVideo } from "../analysis/transcript";
import { describeProject } from "../describe";
import {
	round3,
	sourceSpanToTimeline,
	sourceToTimeline,
	timelineDurationSec,
	timelineToSource,
} from "../edit/timemap";
import { ToolError } from "../errors";
import type { Doc } from "../project/types";
import type { ToolContext } from "./context";

export const SIGNALS = ["cursor", "scenes", "transcript"] as const;
export type Signal = (typeof SIGNALS)[number];

export interface TimelineEvent {
	at: number;
	end?: number;
	kind: "click" | "dwell" | "idle" | "scene" | "speech";
	cx?: number;
	cy?: number;
	text?: string;
}

export interface Analysis {
	timeUnit: string;
	durationSec: number;
	events: TimelineEvent[];
	notes: string[];
}

export interface Frame {
	at: number;
	caption: string;
	jpeg: Buffer;
}

const FFMPEG_HINT = "Install it with `brew install ffmpeg`.";

interface AssetOnTimeline {
	assetId: string;
	video: string;
	endMs: number;
}

function assetsOnTimeline(doc: Doc): AssetOnTimeline[] {
	const ids = [...new Set(doc.timeline.clips.map((c) => c.assetId))];
	return ids.flatMap((id) => {
		const asset = doc.assets.find((a) => a.id === id);
		if (!asset || asset.kind === "audio") return [];
		return [{ assetId: id, video: asset.originalPath, endMs: (asset.durationSec ?? 0) * 1000 }];
	});
}

export async function cursorSamplesByAsset(doc: Doc): Promise<Map<string, CursorSample[]>> {
	const byAsset = new Map<string, CursorSample[]>();
	for (const asset of doc.assets) {
		const samples = await loadCursorSamples(asset.originalPath);
		if (samples) byAsset.set(asset.id, samples);
	}
	return byAsset;
}

export async function listProjects(ctx: ToolContext) {
	return ctx.store.list();
}

export async function describe(ctx: ToolContext, ref: string) {
	return describeProject((await ctx.store.load(ref)).doc);
}

async function cachedScenes(ctx: ToolContext, asset: AssetOnTimeline, ffmpeg: string): Promise<number[]> {
	const cached = await ctx.cache.get<number[]>(asset.assetId, "scenes", asset.video);
	if (cached) return cached;
	const scenes = await detectScenes(ffmpeg, asset.video);
	await ctx.cache.set(asset.assetId, "scenes", asset.video, scenes);
	return scenes;
}

export async function analyzeDoc(ctx: ToolContext, doc: Doc, include: readonly Signal[]): Promise<Analysis> {
	const clips = doc.timeline.clips;
	const events: TimelineEvent[] = [];
	const notes: string[] = [];
	for (const asset of assetsOnTimeline(doc)) {
		const name = basename(asset.video);
		const exists = await fileExists(asset.video);
		if (!exists) notes.push(`Video missing: ${asset.video}. Frames, scenes and transcript are unavailable for it.`);

		if (include.includes("cursor")) {
			const samples = await loadCursorSamples(asset.video);
			if (!samples) {
				notes.push(`No cursor data for ${name}.`);
			} else {
				const endMs = Math.max(asset.endMs, samples.at(-1)?.timeMs ?? 0);
				for (const click of findClicks(samples)) {
					for (const at of sourceToTimeline(clips, asset.assetId, click.sec)) {
						events.push({ at, kind: "click", cx: click.cx, cy: click.cy });
					}
				}
				for (const still of findStillStretches(samples, endMs)) {
					for (const span of sourceSpanToTimeline(clips, asset.assetId, still.startSec, still.endSec)) {
						events.push({ at: span.start, end: span.end, kind: still.kind, cx: still.cx, cy: still.cy });
					}
				}
			}
		}

		if (include.includes("scenes") && exists) {
			if (!ctx.bins.ffmpeg) {
				notes.push(`ffmpeg not found, so scene changes were skipped. ${FFMPEG_HINT}`);
			} else {
				for (const sec of await cachedScenes(ctx, asset, ctx.bins.ffmpeg)) {
					for (const at of sourceToTimeline(clips, asset.assetId, sec)) events.push({ at, kind: "scene" });
				}
			}
		}

		if (include.includes("transcript")) {
			const transcript = exists
				? await ctx.cache.get<Transcript>(asset.assetId, "transcript", asset.video)
				: null;
			if (!transcript) {
				notes.push(`No transcript for ${name} yet; call transcribe first.`);
			} else {
				for (const seg of transcript.segments) {
					for (const span of sourceSpanToTimeline(clips, asset.assetId, seg.startSec, seg.endSec)) {
						events.push({ at: span.start, end: span.end, kind: "speech", text: seg.text });
					}
				}
			}
		}
	}
	events.sort((a, b) => a.at - b.at);
	return {
		timeUnit: "timeline seconds",
		durationSec: round3(timelineDurationSec(clips)),
		events,
		notes,
	};
}

export async function analyze(ctx: ToolContext, ref: string, include: readonly Signal[]): Promise<Analysis> {
	return analyzeDoc(ctx, (await ctx.store.load(ref)).doc, include);
}

const pos = (e: TimelineEvent) => `(${e.cx}, ${e.cy})`;

function describeEvent(e: TimelineEvent): string {
	switch (e.kind) {
		case "click":
			return `click at ${pos(e)}`;
		case "dwell":
			return `cursor rests at ${pos(e)} until ${e.end?.toFixed(2)}s`;
		case "idle":
			return `idle until ${e.end?.toFixed(2)}s`;
		case "scene":
			return "scene change";
		case "speech":
			return `says "${e.text}"`;
	}
}

function pickEvenly(values: number[], max: number): number[] {
	if (values.length <= max) return values;
	if (max === 1) return [values[0]!];
	return Array.from({ length: max }, (_, i) => values[Math.round((i * (values.length - 1)) / (max - 1))]!);
}

export async function frames(
	ctx: ToolContext,
	ref: string,
	opts: { times?: number[]; at?: "clicks" | "scenes" | "evenly"; max: number },
): Promise<Frame[]> {
	const ffmpeg = requireBin(ctx.bins.ffmpeg, "ffmpeg", FFMPEG_HINT);
	const { doc } = await ctx.store.load(ref);
	const clips = doc.timeline.clips;
	const duration = timelineDurationSec(clips);
	const at = opts.times?.length ? undefined : (opts.at ?? "evenly");
	const analysis = await analyzeDoc(ctx, doc, at === "scenes" ? ["cursor", "scenes"] : ["cursor"]);

	let times: number[];
	if (opts.times?.length) times = opts.times;
	else if (at === "clicks") times = analysis.events.filter((e) => e.kind === "click").map((e) => e.at);
	else if (at === "scenes") times = [0, ...analysis.events.filter((e) => e.kind === "scene").map((e) => e.at)];
	else times = Array.from({ length: opts.max }, (_, i) => round3(((i + 0.5) * duration) / opts.max));
	times = pickEvenly([...new Set(times.map(round3))].sort((a, b) => a - b), opts.max);
	if (times.length === 0) throw new ToolError(`No ${at} found in this recording.`);

	const out: Frame[] = [];
	for (const t of times) {
		const position = timelineToSource(clips, t);
		if (!position) throw new ToolError(`${t}s is outside the timeline (0–${round3(duration)}s).`);
		const video = doc.assets.find((a) => a.id === position.clip.assetId)?.originalPath;
		if (!video || !(await fileExists(video))) throw new ToolError(`The video for ${t}s is missing.`);
		const nearby = analysis.events.filter(
			(e) => Math.abs(e.at - t) <= 0.5 || (e.end !== undefined && e.at <= t && t <= e.end),
		);
		const caption = `t=${t.toFixed(2)}s${nearby.length ? `: ${nearby.map(describeEvent).join("; ")}` : ""}`;
		out.push({ at: t, caption, jpeg: await extractFrame(ffmpeg, video, position.sourceSec) });
	}
	return out;
}

export async function transcribe(ctx: ToolContext, ref: string) {
	const ffmpeg = requireBin(ctx.bins.ffmpeg, "ffmpeg", FFMPEG_HINT);
	const whisper = requireBin(ctx.bins.whisper, "whisper-cli", "Install it with `brew install whisper-cpp`.");
	if (!(await fileExists(ctx.paths.whisperModel))) {
		throw new ToolError(
			`Whisper model not found at ${ctx.paths.whisperModel}. Turn on captions once in OpenScreen to download it.`,
		);
	}
	const { doc } = await ctx.store.load(ref);
	const results: { video: string; status: string; language?: string; segments?: number }[] = [];
	for (const asset of assetsOnTimeline(doc)) {
		const video = basename(asset.video);
		if (!(await fileExists(asset.video))) {
			results.push({ video, status: "video missing" });
			continue;
		}
		const cached = await ctx.cache.get<Transcript>(asset.assetId, "transcript", asset.video);
		if (cached) {
			results.push({ video, status: "already transcribed", language: cached.language, segments: cached.segments.length });
			continue;
		}
		if (ctx.bins.ffprobe && !(await hasAudio(ctx.bins.ffprobe, asset.video))) {
			results.push({ video, status: "no audio stream" });
			continue;
		}
		const transcript = await transcribeVideo({
			ffmpeg,
			whisper,
			model: ctx.paths.whisperModel,
			video: asset.video,
			workDir: join(ctx.paths.cacheDir, "tmp", randomUUID()),
		});
		await ctx.cache.set(asset.assetId, "transcript", asset.video, transcript);
		results.push({ video, status: "transcribed", language: transcript.language, segments: transcript.segments.length });
	}
	return results;
}
