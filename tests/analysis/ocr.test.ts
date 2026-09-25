import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findBins } from "../../src/analysis/media";
import { ensureOcrHelper, runOcr } from "../../src/analysis/ocr";
import { ToolError } from "../../src/errors";
import { renderFrame } from "../helpers/render";

const bins = await findBins();
const BIN = join(tmpdir(), "osmcp-test-bin");

describe("ensureOcrHelper", () => {
	it("explains how to get swiftc when it is missing", async () => {
		const empty = await mkdtemp(join(tmpdir(), "osmcp-nobin-"));
		await expect(ensureOcrHelper(empty, null)).rejects.toThrow(/xcode-select --install/);
		await expect(ensureOcrHelper(empty, null)).rejects.toThrow(ToolError);
		await rm(empty, { recursive: true, force: true });
	});
});

describe.skipIf(!bins.swiftc)("Apple Vision OCR helper", () => {
	let dir: string;
	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "osmcp-ocr-"));
	});
	afterAll(() => rm(dir, { recursive: true, force: true }));

	it("compiles once and reuses the binary", async () => {
		const a = await ensureOcrHelper(BIN, bins.swiftc);
		const b = await ensureOcrHelper(BIN, bins.swiftc);
		expect(a).toBe(b);
		expect(a).toMatch(/ocr-[0-9a-f]{8}$/);
	});

	it("reads text with top-left normalized boxes, in input order", async () => {
		const image = join(dir, "a.png");
		await renderFrame(bins.swiftc!, image, 1280, 720, [
			{ x: 40, y: 40, size: 28, text: "alice@example.com" },
			{ x: 900, y: 600, size: 26, text: "Balance" },
		]);
		const [result, missing] = await runOcr(await ensureOcrHelper(BIN, bins.swiftc), [image, join(dir, "none.png")]);
		const email = result!.lines.find((l) => l.text === "alice@example.com")!;
		expect(email.x).toBeCloseTo(40 / 1280, 1);
		expect(email.y).toBeCloseTo(40 / 720, 1);
		expect(email.w).toBeGreaterThan(0.1);
		const balance = result!.lines.find((l) => l.text === "Balance")!;
		expect(balance.y).toBeGreaterThan(0.8);
		expect(missing).toMatchObject({ path: join(dir, "none.png"), lines: [], error: "cannot read image" });
	});
});
