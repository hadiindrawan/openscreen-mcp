import { describe, expect, it } from "vitest";
import { isOpenscreenRunning } from "../../src/project/guard";

describe("isOpenscreenRunning", () => {
	it("returns a boolean without throwing", async () => {
		expect(typeof (await isOpenscreenRunning())).toBe("boolean");
	});
});
