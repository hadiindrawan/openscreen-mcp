// OpenScreen writes `<video>.cursor.json` next to every recording:
// { version: 2, samples: [{ timeMs, cx, cy, visible, interactionType: "move" | "click" | "mouseup" }] }
// timeMs is the recording's source time; cx/cy are 0–1 fractions of the frame.
// Samples arrive only when something happens, so a gap between samples means the cursor held still.
import { readFile } from "node:fs/promises";
import { round3 } from "../edit/timemap";

export interface CursorSample {
	timeMs: number;
	cx: number;
	cy: number;
	interactionType: string;
}

export interface Click {
	sec: number;
	cx: number;
	cy: number;
}

export interface Stillness {
	startSec: number;
	endSec: number;
	cx: number;
	cy: number;
	kind: "dwell" | "idle";
}

/** "Still" = moved less than 0.5 % of the frame. */
export const STILL_TOLERANCE = 0.005;
export const MIN_DWELL_SEC = 1.5;
export const MIN_IDLE_SEC = 2;

export async function loadCursorSamples(videoPath: string): Promise<CursorSample[] | null> {
	try {
		const raw = JSON.parse(await readFile(`${videoPath}.cursor.json`, "utf8")) as {
			samples?: CursorSample[];
		};
		return (raw.samples ?? [])
			.filter((s) => Number.isFinite(s.timeMs) && Number.isFinite(s.cx) && Number.isFinite(s.cy))
			.sort((a, b) => a.timeMs - b.timeMs);
	} catch {
		return null;
	}
}

export function findClicks(samples: readonly CursorSample[]): Click[] {
	return samples
		.filter((s) => s.interactionType === "click")
		.map((s) => ({ sec: round3(s.timeMs / 1000), cx: round3(s.cx), cy: round3(s.cy) }));
}

/** Stretches of ≥ 1.5 s where the cursor stays put. Click-free stretches of ≥ 2 s are "idle". */
export function findStillStretches(samples: readonly CursorSample[], endMs: number): Stillness[] {
	const out: Stillness[] = [];
	const first = samples[0];
	if (!first) return out;
	const clicks = findClicks(samples).map((c) => c.sec);
	let anchor = first;
	const close = (stretchEndMs: number) => {
		const startSec = anchor.timeMs / 1000;
		const endSec = stretchEndMs / 1000;
		const length = endSec - startSec;
		if (length < MIN_DWELL_SEC) return;
		const hasClick = clicks.some((c) => c >= startSec - 1e-6 && c <= endSec + 1e-6);
		out.push({
			startSec: round3(startSec),
			endSec: round3(endSec),
			cx: round3(anchor.cx),
			cy: round3(anchor.cy),
			kind: !hasClick && length >= MIN_IDLE_SEC ? "idle" : "dwell",
		});
	};
	for (const sample of samples.slice(1)) {
		const moved = Math.max(Math.abs(sample.cx - anchor.cx), Math.abs(sample.cy - anchor.cy));
		if (moved >= STILL_TOLERANCE) {
			close(sample.timeMs);
			anchor = sample;
		}
	}
	close(Math.max(endMs, anchor.timeMs));
	return out;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function medianPosition(
	samples: readonly CursorSample[],
	startSec: number,
	endSec: number,
): { cx: number; cy: number } | null {
	const inside = samples.filter((s) => s.timeMs >= startSec * 1000 && s.timeMs <= endSec * 1000);
	if (inside.length === 0) return null;
	return { cx: round3(median(inside.map((s) => s.cx))), cy: round3(median(inside.map((s) => s.cy))) };
}
