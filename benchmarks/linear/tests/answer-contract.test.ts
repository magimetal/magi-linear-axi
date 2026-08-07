import { describe, expect, it } from "vitest";
import {
	answerContractPrompt,
	canonicalAnswerJsonSchema,
	canonicalAnswerPassed,
	expectedCanonicalAnswer,
	fieldKey,
	serializeCanonicalRecords,
} from "../src/answer-contract.js";
import type { BenchmarkTask } from "../src/types.js";

function task(
	requiredFacts: BenchmarkTask["requiredFacts"],
	canonicalAnswer?: BenchmarkTask["canonicalAnswer"],
): BenchmarkTask {
	return {
		id: "lookup",
		category: "single_step",
		title: "Lookup",
		prompt: "Read issue.",
		minimumToolCalls: 1,
		requiredOperations: [],
		requiredFacts,
		gradingHints: [],
		...(canonicalAnswer ? { canonicalAnswer } : {}),
	};
}

describe("canonical answer contract", () => {
	it("serializes one record as an object and multiple records as an ordered array", () => {
		expect(serializeCanonicalRecords([{ a: "1" }])).toBe('{"a":"1"}');
		expect(
			serializeCanonicalRecords([{ a: "1" }, { a: "2" }]),
		).toBe('[{"a":"1"},{"a":"2"}]');
	});

	it("builds strict object schemas and leaves multi-record arrays to deterministic grading", () => {
		const one = task([
			{ label: "issue identifier", kind: "contains", value: "ENG-1" },
			{ label: "issue title", kind: "contains", value: "Fix" },
		]);
		expect(canonicalAnswerJsonSchema(one)).toEqual({
			type: "object",
			properties: {
				issue_identifier: { type: "string" },
				issue_title: { type: "string" },
			},
			required: ["issue_identifier", "issue_title"],
			additionalProperties: false,
		});

		const sameShape = task(
			[
				{ label: "first identifier", kind: "contains", value: "ENG-1" },
				{ label: "first title", kind: "contains", value: "One" },
				{ label: "second identifier", kind: "contains", value: "ENG-2" },
				{ label: "second title", kind: "contains", value: "Two" },
			],
			[
				{
					fields: [
						{ key: "identifier", factLabel: "first identifier" },
						{ key: "title", factLabel: "first title" },
					],
				},
				{
					fields: [
						{ key: "identifier", factLabel: "second identifier" },
						{ key: "title", factLabel: "second title" },
					],
				},
			],
		);
		expect(canonicalAnswerJsonSchema(sameShape)).toBeUndefined();
		expect(answerContractPrompt("canonical", sameShape)).toContain(
			"one JSON array with exactly 2 ordered JSON objects",
		);

		const differentShape = task(
			[
				{ label: "first", kind: "contains", value: "one" },
				{ label: "second", kind: "contains", value: "two" },
			],
			[
				{ fields: [{ key: "first", factLabel: "first" }] },
				{ fields: [{ key: "second", factLabel: "second" }] },
			],
		);
		expect(canonicalAnswerJsonSchema(differentShape)).toBeUndefined();
		expect(answerContractPrompt("canonical", differentShape)).toContain(
			'Value-placeholder template derived only from keys: [{"first":"<first>"},{"second":"<second>"}]',
		);
		expect(
			canonicalAnswerPassed(differentShape, '[{"first":"one"},{"second":"two"}]'),
		).toBe(true);
	});

	it("preserves Unicode and applies normal JSON escaping to exact string values", () => {
		const candidate = task(
			[
				{ label: "empty", kind: "contains", value: "" },
				{
					label: "text",
					kind: "contains",
					value: '🙂 | = , : "quote" \\ slash\nsecond line',
				},
			],
			[
				{
					fields: [
						{ key: "empty", factLabel: "empty" },
						{ key: "text", factLabel: "text" },
					],
				},
			],
		);
		const expected =
			'{"empty":"","text":"🙂 | = , : \\"quote\\" \\\\ slash\\nsecond line"}';
		expect(expectedCanonicalAnswer(candidate)).toBe(expected);
		expect(canonicalAnswerPassed(candidate, expected)).toBe(true);
	});

	it("supports ordered multiple records with repeated keys", () => {
		const candidate = task(
			[
				{ label: "first identifier", kind: "contains", value: "ENG-1" },
				{ label: "first title", kind: "contains", value: "One" },
				{ label: "second identifier", kind: "contains", value: "ENG-2" },
				{ label: "second title", kind: "contains", value: "Two" },
			],
			[
				{
					fields: [
						{ key: "identifier", factLabel: "first identifier" },
						{ key: "title", factLabel: "first title" },
					],
				},
				{
					fields: [
						{ key: "identifier", factLabel: "second identifier" },
						{ key: "title", factLabel: "second title" },
					],
				},
			],
		);
		const expected =
			'[{"identifier":"ENG-1","title":"One"},{"identifier":"ENG-2","title":"Two"}]';
		expect(expectedCanonicalAnswer(candidate)).toBe(expected);
		expect(canonicalAnswerPassed(candidate, expected)).toBe(true);
		expect(
			canonicalAnswerPassed(
				candidate,
				'[{"identifier":"ENG-2","title":"Two"},{"identifier":"ENG-1","title":"One"}]',
			),
		).toBe(false);
	});

	it("uses exact issue-scoped error serialization", () => {
		const candidate = task(
			[
				{
					label: "invalid issue is explicitly absent",
					kind: "not_found",
					value: "ENG-404",
				},
			],
			[
				{
					fields: [
						{
							key: "error",
							factLabel: "invalid issue is explicitly absent",
						},
					],
				},
			],
		);
		expect(expectedCanonicalAnswer(candidate)).toBe(
			'{"error":"issue ENG-404 not found"}',
		);
		expect(
			canonicalAnswerPassed(
				candidate,
				'{"error":"issue ENG-404 not found"}',
			),
		).toBe(true);
		expect(
			canonicalAnswerPassed(candidate, '{"error":"ENG-404 not found"}'),
		).toBe(false);
	});

	it("rejects whitespace, prose, fences, escaped Unicode, schema drift, and non-string values", () => {
		const candidate = task([
			{ label: "issue identifier", kind: "contains", value: "ENG-1" },
			{ label: "issue title", kind: "contains", value: "Fix 🙂" },
		]);
		const expected = '{"issue_identifier":"ENG-1","issue_title":"Fix 🙂"}';
		expect(canonicalAnswerPassed(candidate, expected)).toBe(true);
		for (const invalid of [
			'{ "issue_identifier":"ENG-1","issue_title":"Fix 🙂"}',
			`${expected}\n`,
			`Answer: ${expected}`,
			`\`\`\`json\n${expected}\n\`\`\``,
			'{"issue_title":"Fix 🙂","issue_identifier":"ENG-1"}',
			'{"issue_identifier":"ENG-1","issue_title":"Fix \\ud83d\\ude42"}',
			'{"issue_identifier":"ENG-1","issue_title":"Fix 🙂","extra":"x"}',
			'{"issue_identifier":"ENG-1"}',
			'{"issue_identifier":1,"issue_title":"Fix 🙂"}',
			'{"issue_identifier":"ENG-1","issue_title":"Wrong"}',
		]) {
			expect(canonicalAnswerPassed(candidate, invalid), invalid).toBe(false);
		}
	});

	it("includes exact object and array templates without oracle values", () => {
		const candidate = task([
			{ label: "issue identifier", kind: "contains", value: "ENG-1" },
			{ label: "issue title", kind: "contains", value: "Fix" },
		]);
		const prompt = answerContractPrompt("canonical", candidate);
		expect(prompt).toContain(
			'Schema key order: [["issue_identifier","issue_title"]]',
		);
		expect(prompt).toContain(
			'Value-placeholder template derived only from keys: {"issue_identifier":"<issue_identifier>","issue_title":"<issue_title>"}',
		);
		expect(prompt).toContain("Exact top-level JSON shape: one JSON object");
		expect(prompt).toContain("normal JSON escaping");
		expect(prompt).toContain("character-for-character");
		expect(prompt).toContain("without Unicode normalization");
		expect(prompt).toContain("exactly `issue IDENTIFIER not found`");
		expect(prompt).not.toContain("ENG-1");
		expect(prompt).not.toContain("Fix");

		const arrayCandidate = task(
			[
				{ label: "first", kind: "contains", value: "oracle-one" },
				{ label: "second", kind: "contains", value: "oracle-two" },
			],
			[
				{ fields: [{ key: "value", factLabel: "first" }] },
				{ fields: [{ key: "value", factLabel: "second" }] },
			],
		);
		const arrayPrompt = answerContractPrompt("canonical", arrayCandidate);
		expect(arrayPrompt).toContain(
			"Exact top-level JSON shape: one JSON array with exactly 2 ordered JSON objects.",
		);
		expect(arrayPrompt).toContain(
			'Value-placeholder template derived only from keys: [{"value":"<value>"},{"value":"<value>"}]',
		);
		expect(arrayPrompt).not.toContain("oracle-one");
		expect(arrayPrompt).not.toContain("oracle-two");
		expect(answerContractPrompt("compact")).toContain(
			"character-for-character",
		);
	});

	it("derives stable ASCII keys for generic fact labels", () => {
		expect(fieldKey("  Project URL / Status  ")).toBe("project_url_status");
	});
});
