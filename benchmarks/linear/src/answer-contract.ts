import type {
	AnswerContract,
	BenchmarkTask,
	CanonicalAnswerRecord,
	RequiredFact,
} from "./types.js";

export const CANONICAL_ANSWER_CONTRACT = [
	"Canonical answer contract:",
	"Return exactly one minified JSON object for one record, or one minified JSON array for multiple ordered records.",
	"Use the exact top-level shape, record count, and schema key order specified below.",
	"Use literal Unicode and normal JSON escaping for quotes, backslashes, control characters, and multiline values.",
	"Every field value must be a string. The entire response must be JSON only: no whitespace outside string values, prose, commentary, Markdown, code fences, or extra fields.",
	"Copy every tool-returned value character-for-character, including leading and trailing whitespace, line breaks, and Unicode punctuation, without Unicode normalization or any other normalization.",
	"For an invalid issue, the error value must be exactly `issue IDENTIFIER not found`, replacing IDENTIFIER with the requested issue identifier.",
].join("\n");

export interface CanonicalAnswerObjectJsonSchema {
	type: "object";
	properties: Record<string, { type: "string" }>;
	required: string[];
	additionalProperties: false;
}

export type CanonicalAnswerJsonSchema = CanonicalAnswerObjectJsonSchema;

export function fieldKey(label: string): string {
	return label
		.trim()
		.toLocaleLowerCase()
		.replace(/[^a-z0-9]+/gu, "_")
		.replace(/^_|_$/gu, "");
}

function factForLabel(
	task: BenchmarkTask,
	label: string,
): RequiredFact | undefined {
	return task.requiredFacts.find((fact) => fact.label === label);
}

export function canonicalAnswerSchema(
	task: BenchmarkTask,
): CanonicalAnswerRecord[] {
	return task.canonicalAnswer ?? [
		{
			fields: task.requiredFacts.map((fact) => ({
				key: fieldKey(fact.label),
				factLabel: fact.label,
			})),
		},
	];
}

function canonicalAnswerObjectJsonSchema(
	record: CanonicalAnswerRecord,
): CanonicalAnswerObjectJsonSchema {
	const properties: Record<string, { type: "string" }> = {};
	for (const field of record.fields) {
		properties[field.key] = { type: "string" };
	}
	return {
		type: "object",
		properties,
		required: record.fields.map((field) => field.key),
		additionalProperties: false,
	};
}

/** Builds the provider-enforced schema when one can express the task exactly. */
export function canonicalAnswerJsonSchema(
	task: BenchmarkTask,
): CanonicalAnswerJsonSchema | undefined {
	const records = canonicalAnswerSchema(task);
	const record = records.length === 1 ? records[0] : undefined;
	return record ? canonicalAnswerObjectJsonSchema(record) : undefined;
}

export function serializeCanonicalRecords(
	records: readonly Readonly<Record<string, string>>[],
): string {
	return JSON.stringify(records.length === 1 ? records[0] : records);
}

export function expectedCanonicalAnswer(task: BenchmarkTask): string {
	const records = canonicalAnswerSchema(task).map((record) => {
		const value: Record<string, string> = {};
		for (const field of record.fields) {
			const fact = factForLabel(task, field.factLabel);
			value[field.key] =
				fact?.kind === "not_found"
					? `issue ${fact.value ?? ""} not found`
					: (fact?.value ?? "");
		}
		return value;
	});
	return serializeCanonicalRecords(records);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return Boolean(
		value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.values(value as Record<string, unknown>).every(
				(item) => typeof item === "string",
			),
	);
}

export function canonicalAnswerPassed(
	task: BenchmarkTask,
	answer: string,
): boolean {
	if (answer !== expectedCanonicalAnswer(task)) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(answer) as unknown;
	} catch {
		return false;
	}
	const expected = canonicalAnswerSchema(task);
	const records = Array.isArray(parsed) ? parsed : [parsed];
	return (
		records.length === expected.length &&
		records.every((record, index) => {
			if (!isStringRecord(record)) return false;
			const expectedRecord = expected[index];
			if (!expectedRecord) return false;
			const keys = Object.keys(record);
			return (
				keys.length === expectedRecord.fields.length &&
				keys.every(
					(key, fieldIndex) =>
						key === expectedRecord.fields[fieldIndex]?.key,
				)
			);
		})
	);
}

function canonicalValuePlaceholderTemplate(
	records: readonly CanonicalAnswerRecord[],
): Readonly<Record<string, string>> | Readonly<Record<string, string>>[] {
	const templates = records.map((record) => {
		const template: Record<string, string> = {};
		for (const field of record.fields) {
			template[field.key] = `<${field.key}>`;
		}
		return template;
	});
	return templates.length === 1 ? templates[0] ?? {} : templates;
}

export function answerContractPrompt(
	contract: AnswerContract,
	task?: BenchmarkTask,
): string {
	if (contract !== "canonical") {
		return [
			"Return only requested fields. Do not add a preamble, restate the task, or add tables, counts, or commentary unless requested.",
			"Copy every requested value character-for-character, including leading and trailing whitespace, line breaks, and Unicode punctuation, without Unicode normalization or any other normalization.",
			"When a requested issue does not exist, explicitly state that the issue was not found; do not use generic absence wording.",
		].join("\n");
	}
	const records = task ? canonicalAnswerSchema(task) : [];
	const schema = records.map((record) =>
		record.fields.map((field) => field.key),
	);
	const shape = records.length === 1
		? "one JSON object with exactly the listed keys in the listed order"
		: `one JSON array with exactly ${records.length} ordered JSON objects`;
	return [
		CANONICAL_ANSWER_CONTRACT,
		`Exact top-level JSON shape: ${shape}.`,
		`Schema key order: ${JSON.stringify(schema)}`,
		`Value-placeholder template derived only from keys: ${JSON.stringify(canonicalValuePlaceholderTemplate(records))}`,
	].join("\n");
}
