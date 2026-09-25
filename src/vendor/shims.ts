// Stand-ins for the three helpers the vendored OpenScreen schema imports.
// The server only parses schemaVersion 7 documents, so the migration code that
// calls `anchorRegionsWithDerivedMs` never runs here.

export function createId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

function greatestCommonDivisor(a: number, b: number): number {
	return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

export function toAspectRatioToken(width: number, height: number): string | null {
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		return null;
	}
	const w = Math.round(width);
	const h = Math.round(height);
	if (w <= 0 || h <= 0) return null;
	const divisor = greatestCommonDivisor(w, h) || 1;
	return `${w / divisor}:${h / divisor}`;
}

export function anchorRegionsWithDerivedMs(..._args: unknown[]): never {
	throw new Error("pre-v7 OpenScreen documents are not supported");
}
