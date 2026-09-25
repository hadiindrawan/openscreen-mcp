import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileExists, requireBin } from "../analysis/media";
import { ensureOcrHelper, type OcrLine, runOcr } from "../analysis/ocr";
import { sampleFrames } from "../analysis/sample";
import { sourceSpanToTimeline } from "../edit/timemap";
import { ToolError } from "../errors";
import type { LoadedProject } from "../project/store";
import type { Doc } from "../project/types";
import type { ToolContext } from "../tools/context";
import { type AssetOnTimeline, assetsOnTimeline } from "../tools/understand";
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
