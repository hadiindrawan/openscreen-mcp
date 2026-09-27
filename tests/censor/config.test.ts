import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileMatcher, describeConfig, loadCensorConfig, restrictCategories } from "../../src/censor/config";
import { ToolError } from "../../src/errors";

let dir: string;
let file: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "osmcp-config-"));
	file = join(dir, "censor.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("compileMatcher", () => {
	it("treats plain strings as case-insensitive substrings", () => {
		const m = compileMatcher("a.b");
		expect("xA.Bx a.b".match(m.re)).toEqual(["A.B", "a.b"]);
		expect("axb".match(m.re)).toBeNull();
	});

	it("treats /…/flags as a regex and always adds g", () => {
		const m = compileMatcher("/sewu\\s+segar/i");
		expect("PT SEWU  SEGAR".match(m.re)).toEqual(["SEWU  SEGAR"]);
		expect(m.re.flags).toContain("g");
	});

	it("rejects an invalid regex", () => {
		expect(() => compileMatcher("/([a-/")).toThrow(ToolError);
	});
});

describe("loadCensorConfig", () => {
	it("defaults to every category on when the file is absent", async () => {
		const config = await loadCensorConfig(file);
		expect(describeConfig(config)).toEqual({
			path: file,
			categories: { money: true, emails: true, names: true, secrets: true, urls: true, chrome: true },
			alwaysHide: [],
			neverHide: [],
			names: [],
			moneyHeaders: [],
			nameHeaders: [],
		});
	});

	it("reads categories and lists from the file", async () => {
		await writeFile(
			file,
			JSON.stringify({
				categories: { chrome: false },
				alwaysHide: ["ADONAN", "/sewu/i"],
				neverHide: ["neverhide"],
				names: ["Hadi"],
				moneyHeaders: ["Nominal"],
				nameHeaders: ["Nasabah"],
			}),
		);
		const d = describeConfig(await loadCensorConfig(file));
		expect(d.categories.chrome).toBe(false);
		expect(d.categories.money).toBe(true);
		expect(d.alwaysHide).toEqual(["ADONAN", "/sewu/i"]);
		expect(d.names).toEqual(["Hadi"]);
		expect(d.moneyHeaders).toEqual(["Nominal"]);
		expect(d.nameHeaders).toEqual(["Nasabah"]);
	});

	it("names the file on malformed JSON", async () => {
		await writeFile(file, "{ nope");
		await expect(loadCensorConfig(file)).rejects.toThrow(file);
	});

	it("rejects unknown keys", async () => {
		await writeFile(file, JSON.stringify({ hideEverything: true }));
		await expect(loadCensorConfig(file)).rejects.toThrow(ToolError);
	});

	it("restricts to requested categories", async () => {
		const only = restrictCategories(await loadCensorConfig(file), ["emails"]);
		expect(describeConfig(only).categories).toEqual({
			money: false, emails: true, names: false, secrets: false, urls: false, chrome: false,
		});
	});
});
