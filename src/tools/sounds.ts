import { findClicks, loadCursorSamples } from "../analysis/cursor";
import { ocrAsset } from "../censor/scan";
import { sourceSpanToTimeline, sourceToTimeline, type Span, trimSpanSec } from "../edit/timemap";
import { ToolError } from "../errors";
import type { Doc } from "../project/types";
import { loadSoundsConfig, volumeFor } from "../sounds/config";
import { resolveSound, ROOT_CATEGORY, scanLibrary, type SoundFile } from "../sounds/library";
import { ensureAudioAsset, type ImportedSound, importSound } from "../sounds/media";
import { placeSounds, type Skipped, type SoundEvent, voiceoverPills } from "../sounds/place";
import { typingCandidates } from "../sounds/typing";
import type { ToolContext } from "./context";
import { applyEdit } from "./edit";
import { assetsOnTimeline } from "./understand";

async function library(ctx: ToolContext) {
	const config = await loadSoundsConfig(ctx.paths.soundsConfig);
	return { config, lib: await scanLibrary(config.folder, ctx.bins.ffprobe) };
}

export async function listSounds(ctx: ToolContext) {
	const { config, lib } = await library(ctx);
	return {
		folder: lib.folder,
		config: config.path,
		categories: Object.entries(lib.categories)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([name, files]) => ({
				name,
				volumeDb: volumeFor(config, name),
				files: files.map((f) => ({ name: f.name, durationSec: Math.round(f.durationSec * 1000) / 1000 })),
			})),
	};
}

const label = (f: SoundFile) => `SFX ${f.category === ROOT_CATEGORY ? "sound" : f.category} · ${f.name}`;

/** Import every file first (copies, outside the project), then add assets and place in one save. */
async function place(
	ctx: ToolContext,
	ref: string,
	picks: { at: number; file: SoundFile; gainDb: number; loopUntil?: number }[],
) {
	const imported = new Map<string, ImportedSound>();
	for (const p of picks) {
		if (!imported.has(p.file.path)) imported.set(p.file.path, await importSound(ctx.paths.mediaDir, p.file));
	}
	let skipped: Skipped[] = [];
	const result = await applyEdit(ctx, ref, (doc) => {
		let next = doc;
		const assetIds = new Map<string, string>();
		for (const [path, sound] of imported) {
			const r = ensureAudioAsset(next, sound);
			next = r.doc;
			assetIds.set(path, r.assetId);
		}
		const events: SoundEvent[] = picks.map((p) => ({
			at: p.at,
			assetId: assetIds.get(p.file.path)!,
			durationSec: p.file.durationSec,
			gainDb: p.gainDb,
			label: label(p.file),
			...(p.loopUntil !== undefined ? { loopUntil: p.loopUntil } : {}),
		}));
		const placed = placeSounds(next, events);
		skipped = placed.skipped;
		return { doc: placed.doc, ids: placed.ids };
	});
	return { ...result, skipped };
}

/** A category rotates through its files. */
function rotate(files: SoundFile[], k: number): SoundFile {
	return files[k % files.length]!;
}

export async function addSound(ctx: ToolContext, ref: string, sound: string, at: number, volume?: number) {
	const { config, lib } = await library(ctx);
	const files = resolveSound(lib, sound);
	const { doc } = await ctx.store.load(ref);
	const file = rotate(files, voiceoverPills(doc).length);
	return place(ctx, ref, [{ at, file, gainDb: volume ?? volumeFor(config, file.category) }]);
}

async function clickTimes(doc: Doc): Promise<number[]> {
	const times: number[] = [];
	for (const asset of assetsOnTimeline(doc)) {
		const samples = await loadCursorSamples(asset.video);
		for (const click of findClicks(samples ?? [])) times.push(...sourceToTimeline(doc.timeline.clips, asset.assetId, click.sec));
	}
	return times.sort((a, b) => a - b);
}

export async function addSoundsOnClicks(ctx: ToolContext, ref: string, category = "click", volume?: number) {
	const { config, lib } = await library(ctx);
	const files = resolveSound(lib, category);
	const { doc } = await ctx.store.load(ref);
	const times = await clickTimes(doc);
	if (times.length === 0) throw new ToolError("This recording has no recorded clicks.");
	return place(
		ctx,
		ref,
		times.map((at, k) => {
			const file = rotate(files, k);
			return { at, file, gainDb: volume ?? volumeFor(config, file.category) };
		}),
	);
}

export async function addTyping(ctx: ToolContext, ref: string, start: number, end: number, sound = "typing", volume?: number) {
	if (!(end > start)) throw new ToolError(`end (${end}s) must be after start (${start}s).`);
	const { config, lib } = await library(ctx);
	const files = resolveSound(lib, sound);
	const { doc } = await ctx.store.load(ref);
	const file = rotate(files, voiceoverPills(doc).length);
	return place(ctx, ref, [{ at: start, file, gainDb: volume ?? volumeFor(config, file.category), loopUntil: end }]);
}

export async function findTyping(ctx: ToolContext, ref: string) {
	const { doc } = await ctx.store.load(ref);
	const clips = doc.timeline.clips;
	const cuts = doc.timeline.trimRanges.map((t) => trimSpanSec(clips, t)).filter((s): s is Span => s !== null);
	const candidates: { start: number; end: number; before: string; after: string; nearClick: boolean }[] = [];
	for (const asset of assetsOnTimeline(doc)) {
		const frames = await ocrAsset(ctx, asset);
		const clicks = findClicks((await loadCursorSamples(asset.video)) ?? []);
		for (const c of typingCandidates(frames, clicks)) {
			for (const span of sourceSpanToTimeline(clips, asset.assetId, c.start, c.end)) {
				if (cuts.some((cut) => span.start >= cut.start && span.start < cut.end)) continue;
				candidates.push({ start: span.start, end: span.end, before: c.before, after: c.after, nearClick: c.nearClick });
			}
		}
	}
	return {
		note: "Hints only: OCR text growth also catches carets, avatars and date pickers. Check each with get_frames (or ask the user) before add_typing.",
		candidates: candidates.sort((a, b) => a.start - b.start),
	};
}
