import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ToolError } from "../errors";
import { fileExists, requireBin, run } from "./media";

// Compiled on first use; the binary name carries this source's hash, so editing it recompiles.
const OCR_SWIFT = `import AppKit
import Foundation
import Vision
// ocr <image>... -> one JSON line per image: {"path","lines":[{"text","conf","x","y","w","h"}]}
// Boxes are 0-1 fractions of the image with a top-left origin.
for path in CommandLine.arguments.dropFirst() {
  var out: [String: Any] = ["path": path]
  if let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) {
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.usesLanguageCorrection = false
    do {
      try VNImageRequestHandler(cgImage: cg).perform([req])
      out["lines"] = (req.results ?? []).compactMap { o -> [String: Any]? in
        guard let c = o.topCandidates(1).first else { return nil }
        let b = o.boundingBox
        return ["text": c.string, "conf": Double(c.confidence), "x": Double(b.minX), "y": Double(1 - b.maxY), "w": Double(b.width), "h": Double(b.height)]
      }
    } catch {
      out["lines"] = [[String: Any]]()
      out["error"] = error.localizedDescription
    }
  } else {
    out["lines"] = [[String: Any]]()
    out["error"] = "cannot read image"
  }
  let data = try! JSONSerialization.data(withJSONObject: out)
  print(String(data: data, encoding: .utf8)!)
}
`;

export interface OcrLine {
	text: string;
	conf: number;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface OcrResult {
	path: string;
	lines: OcrLine[];
	error?: string;
}

const BATCH = 50;

export async function ensureOcrHelper(binDir: string, swiftc: string | null): Promise<string> {
	const sha = createHash("sha256").update(OCR_SWIFT).digest("hex").slice(0, 8);
	const out = join(binDir, `ocr-${sha}`);
	if (await fileExists(out)) return out;
	const compiler = requireBin(
		swiftc,
		"swiftc",
		"Install the Xcode command line tools with `xcode-select --install`, then retry.",
	);
	await mkdir(binDir, { recursive: true });
	await writeFile(`${out}.swift`, OCR_SWIFT);
	try {
		await run(compiler, ["-O", `${out}.swift`, "-o", out], { timeoutMs: 300_000 });
	} catch (error) {
		throw new ToolError(`Could not compile the OCR helper: ${(error as Error).message}`);
	}
	return out;
}

export async function runOcr(helper: string, paths: string[]): Promise<OcrResult[]> {
	const results: OcrResult[] = [];
	for (let i = 0; i < paths.length; i += BATCH) {
		const { stdout } = await run(helper, paths.slice(i, i + BATCH), { timeoutMs: 600_000 });
		for (const line of stdout.toString().split("\n")) {
			if (line.trim()) results.push(JSON.parse(line) as OcrResult);
		}
	}
	return results;
}
