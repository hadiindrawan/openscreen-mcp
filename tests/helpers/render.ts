import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/analysis/media";

const RENDER_SWIFT = `import AppKit
// render <out.png> <width> <height> [<x> <y> <size> <text>]...  (x, y = top-left, pixels)
let a = Array(CommandLine.arguments.dropFirst())
let w = Int(a[1])!, h = Int(a[2])!
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor.white.setFill()
NSRect(x: 0, y: 0, width: w, height: h).fill()
var i = 3
while i + 3 < a.count {
  let x = Double(a[i])!, y = Double(a[i + 1])!, size = Double(a[i + 2])!, text = a[i + 3]
  let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size), .foregroundColor: NSColor.black]
  let s = NSAttributedString(string: text, attributes: attrs)
  s.draw(at: NSPoint(x: x, y: Double(h) - y - s.size().height))
  i += 4
}
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[0]))
`;

export interface TextItem {
	x: number;
	y: number;
	size: number;
	text: string;
}

let compiled: Promise<string> | null = null;

function renderer(swiftc: string): Promise<string> {
	compiled ??= (async () => {
		const sha = createHash("sha256").update(RENDER_SWIFT).digest("hex").slice(0, 8);
		const dir = join(tmpdir(), "osmcp-test-bin");
		const out = join(dir, `render-${sha}`);
		try {
			await access(out);
			return out;
		} catch {
			await mkdir(dir, { recursive: true });
			await writeFile(`${out}.swift`, RENDER_SWIFT);
			await run(swiftc, ["-O", `${out}.swift`, "-o", out], { timeoutMs: 300_000 });
			return out;
		}
	})();
	return compiled;
}

export async function renderFrame(
	swiftc: string,
	out: string,
	width: number,
	height: number,
	items: TextItem[],
): Promise<void> {
	const args = items.flatMap((t) => [String(t.x), String(t.y), String(t.size), t.text]);
	await run(await renderer(swiftc), [out, String(width), String(height), ...args]);
}

/** One rendered frame per second, encoded at 30 fps. */
export async function makeTextVideo(
	ffmpeg: string,
	swiftc: string,
	dir: string,
	frames: TextItem[][],
	width = 1280,
	height = 720,
): Promise<string> {
	for (const [i, items] of frames.entries()) {
		await renderFrame(swiftc, join(dir, `frame${i}.png`), width, height, items);
	}
	const out = join(dir, "text.mp4");
	await run(ffmpeg, [
		"-y", "-v", "error", "-framerate", "1", "-i", join(dir, "frame%d.png"),
		"-vf", "fps=30", "-pix_fmt", "yuv420p", out,
	]);
	return out;
}
