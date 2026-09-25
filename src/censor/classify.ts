import type { OcrLine } from "../analysis/ocr";
import type { Category, CensorConfig, Matcher } from "./config";

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type DetectionCategory = Category | "custom";

export interface Detection {
	category: DetectionCategory;
	group: string;
	groupLabel: string;
	key: string;
	sample: string;
	rect: Rect;
}

const MONEY_HEADERS = ["balance", "saldo", "amount", "mutasi", "total", "price", "debit", "credit", "account", "rekening", "cheque", "no rek"];
const NAME_HEADERS = ["name", "customer", "client", "merchant", "payee", "description", "trans description", "keterangan", "remark"];

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const KEY_PREFIX = /\b(?:sk-[\w-]{8,}|sk_live_\w{8,}|gh[po]_\w{20,}|xox[abp]-[\w-]{10,}|AKIA[0-9A-Z]{12,}|AIza[\w-]{20,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const LONG_TOKEN = /[A-Za-z0-9_-]{24,}/g;
const URL_LIKE = /(?:https?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)+\/\S*)/;
const QUERY_URL = /(?:https?:\/\/|\b[\w-]+(?:\.[\w-]+)+\/)\S*\?\S+/g;
const CURRENCY = /(?:Rp\.?|IDR|USD|\$|€|£|¥)\s?\d[\d.,]*/g;
const LONG_NUMBER = /\b\d{7,}\b/g;

export function mask(text: string): string {
	return text.length <= 2 ? "••" : `${text.slice(0, 2)}•••`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

/** The part of a line's box that holds characters [start, end), assuming even character widths. */
function subRect(line: OcrLine, start: number, end: number): Rect {
	const n = Math.max(1, line.text.length);
	return { x: line.x + (line.w * start) / n, y: line.y, w: (line.w * (end - start)) / n, h: line.h };
}

const lineRect = (l: OcrLine): Rect => ({ x: l.x, y: l.y, w: l.w, h: l.h });

function union(rects: Rect[]): Rect {
	const x0 = Math.min(...rects.map((r) => r.x));
	const y0 = Math.min(...rects.map((r) => r.y));
	const x1 = Math.max(...rects.map((r) => r.x + r.w));
	const y1 = Math.max(...rects.map((r) => r.y + r.h));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

type Meta = { category: DetectionCategory; group: string; groupLabel: string };

function regexDetections(line: OcrLine, re: RegExp, meta: Meta, keyPrefix: string): Detection[] {
	return [...line.text.matchAll(new RegExp(re.source, re.flags))].map((m) => ({
		...meta,
		key: `${keyPrefix}${m[0].toLowerCase()}`,
		sample: m[0],
		rect: subRect(line, m.index!, m.index! + m[0].length),
	}));
}

export function termDetections(lines: OcrLine[], matcher: Matcher, meta: Meta): Detection[] {
	return lines.flatMap((line) => regexDetections(line, matcher.re, meta, `${meta.group}:`));
}

function headerKind(text: string, config: CensorConfig): "money" | "names" | null {
	const n = norm(text);
	const words = n.split(" ");
	const hit = (list: string[]) =>
		list.some((w) => {
			const word = norm(w);
			return n === word || (words.length <= 3 && ` ${n} `.includes(` ${word} `));
		});
	if (config.categories.money && hit([...MONEY_HEADERS, ...config.moneyHeaders])) return "money";
	if (config.categories.names && hit([...NAME_HEADERS, ...config.nameHeaders])) return "names";
	return null;
}

const ALIGN = 0.01;

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Cells under a header, stopping at the first gap taller than 3 row pitches. The pitch is the
 * median spacing between cell tops: OCR box heights vary a lot for the same text, so a gap
 * measured in box heights breaks columns at any oddly short line.
 */
function columnCells(header: OcrLine, lines: OcrLine[]): OcrLine[] {
	const aligned = (c: OcrLine) =>
		Math.abs(c.x - header.x) <= ALIGN ||
		Math.abs(c.x + c.w / 2 - (header.x + header.w / 2)) <= ALIGN ||
		Math.abs(c.x + c.w - (header.x + header.w)) <= ALIGN;
	const below = lines
		.filter((c) => c !== header && c.y > header.y + header.h / 2 && aligned(c))
		.sort((a, b) => a.y - b.y);
	const tops = [header.y, ...below.map((c) => c.y)];
	const spacings = tops.slice(1).map((y, i) => y - tops[i]!).filter((d) => d > 0.008);
	const pitch = spacings.length ? median(spacings) : Math.max(header.h * 2.5, 0.03);
	const cells: OcrLine[] = [];
	let prevTop = header.y;
	for (const c of below) {
		if (c.y - prevTop > 3 * pitch) break;
		cells.push(c);
		prevTop = c.y;
	}
	return cells;
}

function addressBar(lines: OcrLine[]): OcrLine | null {
	return lines.filter((l) => l.y < 0.12 && URL_LIKE.test(l.text)).sort((a, b) => a.y - b.y)[0] ?? null;
}

function chromeBand(bar: OcrLine, lines: OcrLine[]): Rect {
	const barBottom = bar.y + bar.h;
	const next = lines.filter((l) => l.y > barBottom && l.y - barBottom <= 0.035).sort((a, b) => a.y - b.y);
	const row = next.length ? next.filter((l) => Math.abs(l.y - next[0]!.y) <= 0.01) : [];
	const bottom = Math.max(barBottom, ...row.map((l) => l.y + l.h));
	return { x: 0, y: 0, w: 1, h: Math.min(1, bottom + 0.005) };
}

export function classifyFrame(lines: OcrLine[], config: CensorConfig): Detection[] {
	const on = config.categories;
	const out: Detection[] = [];
	const consumed = new Set<OcrLine>();

	const bar = addressBar(lines);
	if (bar) {
		consumed.add(bar);
		if (on.urls) out.push({ category: "urls", group: "urls:addressbar", groupLabel: "Address bar URL", key: "addressbar", sample: bar.text, rect: lineRect(bar) });
		if (on.chrome) out.push({ category: "chrome", group: "chrome", groupLabel: "Browser chrome (tabs, address bar, bookmarks)", key: "chrome", sample: bar.text, rect: chromeBand(bar, lines) });
	}

	for (const header of lines) {
		if (consumed.has(header)) continue;
		const kind = headerKind(header.text, config);
		if (!kind) continue;
		const cells = columnCells(header, lines).filter((c) => !consumed.has(c));
		if (cells.length === 0) continue;
		for (const c of [header, ...cells]) consumed.add(c);
		const name = norm(header.text);
		out.push({
			category: kind,
			group: `column:${name}`,
			groupLabel: `${header.text} column`,
			key: `column:${name}`,
			sample: cells[0]!.text,
			rect: union([header, ...cells].map(lineRect)),
		});
	}

	for (const line of lines) {
		if (on.emails) out.push(...regexDetections(line, EMAIL, { category: "emails", group: "emails", groupLabel: "Email addresses" }, "email:"));
		if (on.secrets) {
			const keys = regexDetections(line, KEY_PREFIX, { category: "secrets", group: "secrets:key", groupLabel: "API keys and tokens" }, "key:");
			const uuids = regexDetections(line, UUID, { category: "secrets", group: "secrets:uuid", groupLabel: "IDs (UUIDs)" }, "uuid:");
			const taken = [...keys, ...uuids].map((d) => d.sample);
			const tokens = regexDetections(line, LONG_TOKEN, { category: "secrets", group: "secrets:key", groupLabel: "API keys and tokens" }, "key:")
				.filter((d) => /[A-Za-z]/.test(d.sample) && /\d/.test(d.sample))
				.filter((d) => !taken.some((t) => t.includes(d.sample) || d.sample.includes(t)));
			out.push(...keys, ...uuids, ...tokens);
		}
		if (consumed.has(line)) continue;
		if (on.urls) out.push(...regexDetections(line, QUERY_URL, { category: "urls", group: "urls:query", groupLabel: "Links with query strings" }, "url:"));
		if (on.money) {
			const amounts = regexDetections(line, CURRENCY, { category: "money", group: "money:amounts", groupLabel: "Currency amounts" }, "amount:");
			out.push(...amounts);
			out.push(
				...regexDetections(line, LONG_NUMBER, { category: "money", group: "money:numbers", groupLabel: "Long numbers (7+ digits)" }, "number:")
					.filter((d) => !amounts.some((a) => a.sample.replace(/\D/g, "").includes(d.sample))),
			);
		}
	}

	if (on.names) {
		for (const m of config.names) out.push(...termDetections(lines, m, { category: "names", group: "names:terms", groupLabel: "Names from your config" }));
	}
	for (const m of config.alwaysHide) {
		out.push(...termDetections(lines, m, { category: "custom", group: `custom:${m.source}`, groupLabel: `Matches "${m.source}"` }));
	}

	return out.filter((d) => !config.neverHide.some((m) => new RegExp(m.re.source, m.re.flags.replace("g", "")).test(d.sample)));
}
