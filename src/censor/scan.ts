import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { extractFrameWithBoxes } from "../analysis/frames";
import { fileExists, requireBin } from "../analysis/media";
import { ensureOcrHelper, type OcrLine, runOcr } from "../analysis/ocr";
import { sampleFrames } from "../analysis/sample";
import { round3, sourceSpanToTimeline, timelineToSource } from "../edit/timemap";
import { ToolError } from "../errors";
import type { LoadedProject } from "../project/store";
import type { Doc } from "../project/types";
import type { ToolContext } from "../tools/context";
import { applyEdit } from "../tools/edit";
import { type AssetOnTimeline, assetsOnTimeline, type Frame } from "../tools/understand";
import { type CensorLook, censorAnnotations } from "./apply";
import { classifyFrame, termDetections } from "./classify";
import { type Category, compileMatcher, describeConfig, loadCensorConfig, restrictCategories } from "./config";
import { type TrackedGroup, trackDetections } from "./track";

export const STALE_SCAN =
	"The project changed since the last scan (or was never scanned). Run scan_sensitive again.";

export interface OcrFrame {
	t: number;
	until: number;
	lines: OcrLine[];
	error?: string;
}

export interface ScanFinding extends TrackedGroup {
	id: string;
	assetId: string;
}

export interface FindingSummary {
	id: string;
	category: string;
	label: string;
	examples: string[];
	time: string | null;
	blurs: number;
}

export interface ScanStore {
	projectId: string;
	projectSha256: string;
	config: ReturnType<typeof describeConfig>;
	findings: ScanFinding[];
}

const OCR_CACHE = "ocr-v1";

const assetEnd = (asset: AssetOnTimeline, frames: OcrFrame[]) =>
	asset.endMs > 0 ? asset.endMs / 1000 : (frames.at(-1)?.until ?? 0);

export async function ocrAsset(ctx: ToolContext, asset: AssetOnTimeline): Promise<OcrFrame[]> {
	const cached = await ctx.cache.get<OcrFrame[]>(asset.assetId, OCR_CACHE, asset.video);
	if (cached) return cached;
	const ffmpeg = requireBin(ctx.bins.ffmpeg, "ffmpeg", "Install it with `brew install ffmpeg`.");
	const helper = await ensureOcrHelper(ctx.paths.binDir, ctx.bins.swiftc);
	const work = join(ctx.paths.cacheDir, "tmp", randomUUID());
	try {
		const sampled = await sampleFrames(ffmpeg, asset.video, work);
		const results = await runOcr(helper, sampled.map((s) => s.path));
		const last = sampled.at(-1)?.t ?? 0;
		const end = asset.endMs > 0 ? asset.endMs / 1000 : last + 0.5;
		const frames: OcrFrame[] = sampled.map((s, i) => ({
			t: s.t,
			until: sampled[i + 1]?.t ?? Math.max(end, s.t),
			lines: results[i]?.lines ?? [],
			...(results[i]?.error ? { error: results[i]!.error } : {}),
		}));
		await ctx.cache.set(asset.assetId, OCR_CACHE, asset.video, frames);
		return frames;
	} finally {
		await rm(work, { recursive: true, force: true });
	}
}

const scanFile = (ctx: ToolContext, projectId: string) => join(ctx.paths.cacheDir, "scans", `${projectId}.json`);

async function readScan(ctx: ToolContext, projectId: string): Promise<ScanStore | null> {
	try {
		return JSON.parse(await readFile(scanFile(ctx, projectId), "utf8")) as ScanStore;
	} catch {
		return null;
	}
}

async function writeScan(ctx: ToolContext, scan: ScanStore): Promise<void> {
	const file = scanFile(ctx, scan.projectId);
	await mkdir(join(ctx.paths.cacheDir, "scans"), { recursive: true });
	await writeFile(file, JSON.stringify(scan));
}

export async function loadFreshScan(ctx: ToolContext, ref: string): Promise<{ loaded: LoadedProject; scan: ScanStore }> {
	const loaded = await ctx.store.load(ref);
	const scan = await readScan(ctx, loaded.id);
	if (!scan || scan.projectSha256 !== loaded.sha256) throw new ToolError(STALE_SCAN);
	return { loaded, scan };
}

function summarize(doc: Doc, f: ScanFinding): FindingSummary {
	const spans = f.segments.flatMap((s) => sourceSpanToTimeline(doc.timeline.clips, f.assetId, s.start, s.end));
	const time = spans.length
		? `${Math.min(...spans.map((s) => s.start)).toFixed(2)}–${Math.max(...spans.map((s) => s.end)).toFixed(2)}s`
		: null;
	return { id: f.id, category: f.category, label: f.label, examples: f.examples, time, blurs: spans.length };
}

export async function scanProject(ctx: ToolContext, ref: string, opts: { categories?: Category[]; force?: boolean }) {
	const loaded = await ctx.store.load(ref);
	const config = restrictCategories(await loadCensorConfig(ctx.paths.censorConfig), opts.categories);
	const notes: string[] = [];
	const found: Omit<ScanFinding, "id">[] = [];
	for (const asset of assetsOnTimeline(loaded.doc)) {
		if (!(await fileExists(asset.video))) {
			notes.push(`Video missing: ${asset.video}; not scanned.`);
			continue;
		}
		if (opts.force) await ctx.cache.set(asset.assetId, OCR_CACHE, asset.video, null);
		const frames = await ocrAsset(ctx, asset);
		const unreadable = frames.filter((f) => f.error).length;
		if (unreadable) notes.push(`${unreadable} frame(s) of ${basename(asset.video)} could not be read and were skipped.`);
		const groups = trackDetections(
			frames.map((f) => ({ t: f.t, until: f.until, detections: classifyFrame(f.lines, config) })),
			assetEnd(asset, frames),
		);
		for (const g of groups) found.push({ ...g, assetId: asset.assetId });
	}
	const findings = found.map((f, i) => ({ ...f, id: `f${i + 1}` }));
	await writeScan(ctx, { projectId: loaded.id, projectSha256: loaded.sha256, config: describeConfig(config), findings });
	return { findings: findings.map((f) => summarize(loaded.doc, f)), config: describeConfig(config), notes };
}

export async function findText(ctx: ToolContext, ref: string, query: string, label?: string): Promise<FindingSummary[]> {
	const loaded = await ctx.store.load(ref);
	let scan = await readScan(ctx, loaded.id);
	if (!scan || scan.projectSha256 !== loaded.sha256) {
		await scanProject(ctx, ref, {});
		scan = (await readScan(ctx, loaded.id))!;
	}
	const matcher = compileMatcher(query);
	const meta = { category: "custom" as const, group: `custom:${query}`, groupLabel: label ?? `Matches "${query}"` };
	const added: ScanFinding[] = [];
	for (const asset of assetsOnTimeline(loaded.doc)) {
		if (!(await fileExists(asset.video))) continue;
		const frames = await ocrAsset(ctx, asset);
		const groups = trackDetections(
			frames.map((f) => ({ t: f.t, until: f.until, detections: termDetections(f.lines, matcher, meta) })),
			assetEnd(asset, frames),
		);
		for (const g of groups) added.push({ ...g, assetId: asset.assetId, id: `f${scan.findings.length + added.length + 1}` });
	}
	if (added.length === 0) throw new ToolError(`"${query}" does not appear in any scanned frame.`);
	scan.findings.push(...added);
	await writeScan(ctx, scan);
	return added.map((f) => summarize(loaded.doc, f));
}

function pick(scan: ScanStore, ids: string[] | undefined): ScanFinding[] {
	if (!ids?.length) return scan.findings;
	return ids.map((id) => {
		const f = scan.findings.find((x) => x.id === id);
		if (!f) throw new ToolError(`Unknown finding ${id}. Use the ids from the latest scan_sensitive.`);
		return f;
	});
}

/** Middle of a finding's longest segment, on the timeline. */
function busiestTime(doc: Doc, f: ScanFinding): number | null {
	const longest = [...f.segments].sort((a, b) => b.end - b.start - (a.end - a.start))[0];
	if (!longest) return null;
	const span = sourceSpanToTimeline(doc.timeline.clips, f.assetId, longest.start, longest.end)[0];
	return span ? round3((span.start + span.end) / 2) : null;
}

export async function previewCensor(
	ctx: ToolContext,
	ref: string,
	opts: { findings?: string[]; times?: number[]; max: number },
): Promise<Frame[]> {
	const ffmpeg = requireBin(ctx.bins.ffmpeg, "ffmpeg", "Install it with `brew install ffmpeg`.");
	const { loaded, scan } = await loadFreshScan(ctx, ref);
	const chosen = pick(scan, opts.findings);
	const doc = loaded.doc;
	const wanted = opts.times?.length
		? opts.times
		: chosen.map((f) => busiestTime(doc, f)).filter((t): t is number => t !== null);
	const times = [...new Set(wanted.map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b).slice(0, opts.max);
	const out: Frame[] = [];
	for (const t of times) {
		const position = timelineToSource(doc.timeline.clips, t);
		if (!position) throw new ToolError(`${t}s is outside the timeline.`);
		const video = doc.assets.find((a) => a.id === position.clip.assetId)?.originalPath;
		if (!video || !(await fileExists(video))) throw new ToolError(`The video for ${t}s is missing.`);
		const active = chosen
			.filter((f) => f.assetId === position.clip.assetId)
			.map((f) => ({ f, rects: f.segments.filter((s) => s.start <= position.sourceSec && position.sourceSec <= s.end).map((s) => s.rect) }))
			.filter((a) => a.rects.length > 0);
		const caption = `t=${t.toFixed(2)}s: ${active.length ? active.map((a) => `${a.f.id} ${a.f.label}`).join(", ") : "nothing blurred here"}`;
		const jpeg = await extractFrameWithBoxes(ffmpeg, video, position.sourceSec, active.flatMap((a) => a.rects));
		out.push({ at: t, caption, jpeg });
	}
	return out;
}

export async function applyCensor(ctx: ToolContext, ref: string, ids: string[], look: CensorLook) {
	const { scan } = await loadFreshScan(ctx, ref);
	const chosen = pick(scan, ids);
	return applyEdit(ctx, ref, (doc) => censorAnnotations(doc, chosen, look));
}
