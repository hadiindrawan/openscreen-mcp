import { describe, expect, it } from "vitest";
import type { OcrLine } from "../../src/analysis/ocr";
import { classifyFrame, type Detection, mask, termDetections } from "../../src/censor/classify";
import { compileMatcher, defaultCensorConfig, restrictCategories } from "../../src/censor/config";

const L = (text: string, x: number, y: number, w: number, h = 0.015): OcrLine => ({ text, conf: 1, x, y, w, h });

// Synthetic layout modelled on the user's test recording (a browser showing a transactions table).
const rows = [0, 1, 2].flatMap((k) => {
	const y = 0.241 + 0.032 * k;
	return [
		L(`032f28dd-ce92-439b-a5b4-d8220b2d20e${k}`, 0.038, y, 0.121, 0.007),
		L(`ACME TRADING REF00001${k}`, 0.24, y, 0.141),
		L(`120338${k}`, 0.532, y, 0.028),
		L("CR", 0.778, y, 0.01),
		L(`120863994${k}`, 0.815, y, 0.038),
	];
});
const frame: OcrLine[] = [
	L("beta.example.io/table/views?company=%7B123%7D", 0.087, 0.052, 0.5, 0.017),
	L("Pancake", 0.006, 0.088, 0.029, 0.013),
	L("Grafana", 0.52, 0.086, 0.04, 0.017),
	L("Worker", 0.48, 0.128, 0.039),
	L("neverhide Bq Id", 0.038, 0.212, 0.049, 0.013),
	L("Trans Description", 0.24, 0.212, 0.049, 0.013),
	L("Mutasi", 0.532, 0.212, 0.022, 0.012),
	L("Type", 0.778, 0.212, 0.015, 0.012),
	L("Balance", 0.815, 0.212, 0.025, 0.012),
	...rows,
	L("contact alice@example.com today", 0.05, 0.95, 0.3),
	L("token sk-live4f9a8b7c6d5e4f3a2b1c0d9e", 0.05, 0.9, 0.3),
	L("Total Rp 1.250.000", 0.6, 0.95, 0.1),
];

const groups = (ds: Detection[]) => [...new Set(ds.map((d) => d.group))].sort();
const one = (ds: Detection[], group: string) => ds.filter((d) => d.group === group);

describe("mask", () => {
	it("keeps two characters", () => {
		expect(mask("alice@example.com")).toBe("al•••");
		expect(mask("a")).toBe("••");
	});
});

describe("classifyFrame", () => {
	const all = classifyFrame(frame, defaultCensorConfig("/x"));

	it("finds every category on a realistic frame", () => {
		expect(groups(all)).toEqual([
			"chrome",
			"column:balance",
			"column:mutasi",
			"column:trans description",
			"emails",
			"money:amounts",
			"secrets:key",
			"secrets:uuid",
			"urls:addressbar",
		]);
	});

	it("covers a whole column with one detection, including left-aligned wider cells", () => {
		const [balance] = one(all, "column:balance");
		expect(balance).toMatchObject({ category: "money", groupLabel: "Balance column", sample: "1208639940" });
		expect(balance!.rect.y).toBeCloseTo(0.212, 3);
		expect(balance!.rect.y + balance!.rect.h).toBeCloseTo(0.305 + 0.015, 3);
		const [desc] = one(all, "column:trans description");
		expect(desc!.category).toBe("names");
		expect(desc!.rect.w).toBeCloseTo(0.141, 3);
	});

	it("does not also report column values as loose numbers", () => {
		expect(one(all, "money:numbers")).toEqual([]);
	});

	it("bands the browser chrome down to the bookmarks row, not the page nav", () => {
		const [chrome] = one(all, "chrome");
		expect(chrome!.rect).toEqual({ x: 0, y: 0, w: 1, h: expect.closeTo(0.103 + 0.005, 3) });
	});

	it("groups every UUID into one group with one key each", () => {
		const uuids = one(all, "secrets:uuid");
		expect(uuids).toHaveLength(3);
		expect(new Set(uuids.map((d) => d.key)).size).toBe(3);
	});

	it("narrows a match inside a longer line", () => {
		const [email] = one(all, "emails");
		expect(email!.sample).toBe("alice@example.com");
		expect(email!.rect.x).toBeGreaterThan(0.05);
		expect(email!.rect.w).toBeLessThan(0.3);
	});

	it("honours disabled categories", () => {
		const onlyEmails = classifyFrame(frame, restrictCategories(defaultCensorConfig("/x"), ["emails"]));
		expect(groups(onlyEmails)).toEqual(["emails"]);
	});

	it("applies alwaysHide, names and neverHide", () => {
		const config = {
			...defaultCensorConfig("/x"),
			alwaysHide: [compileMatcher("ACME")],
			names: [compileMatcher("alice")],
			neverHide: [compileMatcher("/^sk-/")],
		};
		const ds = classifyFrame(frame, config);
		expect(one(ds, "custom:ACME")).toHaveLength(3);
		expect(one(ds, "custom:ACME")[0]!.groupLabel).toBe('Matches "ACME"');
		expect(one(ds, "names:terms")[0]!.sample).toBe("alice");
		expect(one(ds, "secrets:key")).toEqual([]);
	});

	it("finds nothing on a frame without sensitive text", () => {
		expect(classifyFrame([L("Welcome", 0.4, 0.5, 0.2), L("Get started", 0.4, 0.6, 0.2)], defaultCensorConfig("/x"))).toEqual([]);
	});
});

describe("column chaining on irregular OCR boxes", () => {
	const header = L("Trans Description", 0.24, 0.212, 0.049, 0.013);
	const cell = (y: number, h: number) => L("ACME TRADING REF000001", 0.24, y, 0.141, h);
	const columnRect = (lines: OcrLine[]) =>
		one(classifyFrame(lines, defaultCensorConfig("/x")), "column:trans description")[0]!.rect;

	it("keeps the column whole when one OCR box is unusually short", () => {
		// A real recording gave a 0.007-tall box (a misread row) between 0.013-tall ones.
		const rect = columnRect([header, cell(0.244, 0.007), cell(0.276, 0.013), cell(0.308, 0.013), cell(0.34, 0.013)]);
		expect(rect.y + rect.h).toBeCloseTo(0.34 + 0.013, 3);
	});

	it("bridges a row hidden behind an overlay", () => {
		const rect = columnRect([header, cell(0.244, 0.013), cell(0.276, 0.013), cell(0.34, 0.013), cell(0.372, 0.013)]);
		expect(rect.y + rect.h).toBeCloseTo(0.372 + 0.013, 3);
	});

	it("still stops at a big gap", () => {
		const rect = columnRect([header, cell(0.244, 0.013), cell(0.276, 0.013), cell(0.7, 0.013)]);
		expect(rect.y + rect.h).toBeCloseTo(0.276 + 0.013, 3);
	});
});

describe("termDetections", () => {
	it("finds every occurrence of a term with its own key", () => {
		const ds = termDetections(frame, compileMatcher("ACME"), { category: "custom", group: "custom:ACME", groupLabel: "x" });
		expect(ds).toHaveLength(3);
		expect(ds[0]!.rect.x).toBeCloseTo(0.24, 3);
	});
});
