/**
 * AXI's default renderer truncates strings after this many Unicode code
 * points. Keep benchmark-generated exact values at or below the same limit.
 * This mirrors `AXI_OUTPUT_MAX_UNICODE_CODE_POINTS` in `src/output.rs`.
 */
export const AXI_OUTPUT_MAX_UNICODE_CODE_POINTS = 240;

export function unicodeCodePointLength(value: string): number {
	return Array.from(value).length;
}

export function isAxiRepresentable(value: string | undefined): value is string {
	return typeof value === "string" &&
		unicodeCodePointLength(value) <= AXI_OUTPUT_MAX_UNICODE_CODE_POINTS;
}
