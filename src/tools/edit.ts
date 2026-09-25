import { medianPosition } from "../analysis/cursor";
import { describeProject, type ProjectDescription } from "../describe";
import type { EditResult } from "../edit/regions";
import type { CursorFocus } from "../edit/zoom";
import type { Doc } from "../project/types";
import type { ToolContext } from "./context";
import { cursorSamplesByAsset } from "./understand";

const REMINDER = "Saved. Reopen this project in OpenScreen to preview the change and export.";

export async function applyEdit(
	ctx: ToolContext,
	ref: string,
	edit: (doc: Doc, cursorFocus: CursorFocus) => EditResult,
): Promise<{ changedIds: string[]; project: ProjectDescription; reminder: string }> {
	const loaded = await ctx.store.load(ref);
	const samples = await cursorSamplesByAsset(loaded.doc);
	const cursorFocus: CursorFocus = (assetId, start, end) =>
		medianPosition(samples.get(assetId) ?? [], start, end);
	const { doc, ids } = edit(loaded.doc, cursorFocus);
	const saved = await ctx.store.save(loaded, doc);
	return { changedIds: ids, project: describeProject(saved.doc), reminder: REMINDER };
}

export async function undoEdit(ctx: ToolContext, ref: string) {
	const restored = await ctx.store.undo(ref);
	return { undone: true as const, project: describeProject(restored.doc), reminder: REMINDER };
}
