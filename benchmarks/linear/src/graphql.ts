export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

type GraphqlData = Record<string, unknown>;
export type GraphqlRequester = (
	query: string,
	variables?: Record<string, unknown>,
) => Promise<GraphqlData>;

export class GraphqlSafetyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphqlSafetyError";
	}
}

export class GraphqlRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphqlRequestError";
	}
}

interface GraphqlRequestOptions {
	endpoint?: string;
	apiKey: string;
	fetchImpl?: typeof fetch;
}

type GraphqlToken =
	| { kind: "name"; value: string }
	| { kind: "punctuation"; value: string };

function isNameStart(character: string): boolean {
	return /[A-Za-z_]/u.test(character);
}

function isNameContinue(character: string): boolean {
	return /[A-Za-z0-9_]/u.test(character);
}

function skipGraphqlString(document: string, start: number): number {
	if (document.startsWith('"""', start)) {
		let index = start + 3;
		while (index < document.length) {
			if (document.startsWith('"""', index) && document[index - 1] !== "\\") {
				return index + 3;
			}
			index += 1;
		}
		throw new GraphqlSafetyError(
			"GraphQL document contains an unterminated block string",
		);
	}
	let index = start + 1;
	while (index < document.length) {
		if (document[index] === "\\") {
			index += 2;
			continue;
		}
		if (document[index] === '"') {
			return index + 1;
		}
		index += 1;
	}
	throw new GraphqlSafetyError(
		"GraphQL document contains an unterminated string",
	);
}

/**
 * Tokenizes only the parts needed by the read-only operation guard. Strings,
 * block strings, comments, commas, and whitespace are skipped so words such
 * as `mutation` in returned values or comments cannot become operations.
 */
function tokenizeGraphql(document: string): GraphqlToken[] {
	const tokens: GraphqlToken[] = [];
	let index = 0;
	while (index < document.length) {
		const character = document[index];
		if (character === "\ufeff" || /\s|,/u.test(character)) {
			index += 1;
			continue;
		}
		if (character === "#") {
			const newline = document.indexOf("\n", index + 1);
			index = newline === -1 ? document.length : newline + 1;
			continue;
		}
		if (character === '"') {
			index = skipGraphqlString(document, index);
			continue;
		}
		if (isNameStart(character)) {
			let end = index + 1;
			while (end < document.length && isNameContinue(document[end])) {
				end += 1;
			}
			tokens.push({ kind: "name", value: document.slice(index, end) });
			index = end;
			continue;
		}
		if ("{}()[]!$:@=|&".includes(character)) {
			tokens.push({ kind: "punctuation", value: character });
			index += 1;
			continue;
		}
		if (/[-0-9]/u.test(character)) {
			let end = index + 1;
			while (end < document.length && /[0-9.eE+-]/u.test(document[end])) {
				end += 1;
			}
			tokens.push({ kind: "punctuation", value: document.slice(index, end) });
			index = end;
			continue;
		}
		if (character === "." && document.slice(index, index + 3) === "...") {
			tokens.push({ kind: "punctuation", value: "..." });
			index += 3;
			continue;
		}
		throw new GraphqlSafetyError("GraphQL document contains an invalid token");
	}
	return tokens;
}

/**
 * Rejects mutations, subscriptions, and fragment-only documents without
 * treating those words inside a GraphQL string or comment as operations. A
 * document may contain fragments, but it must contain at least one executable
 * query operation (named or anonymous).
 */
export function assertQueryOnly(document: string): void {
	const tokens = tokenizeGraphql(document);
	if (tokens.length === 0) {
		throw new GraphqlSafetyError("GraphQL document is empty");
	}

	let braceDepth = 0;
	let parenDepth = 0;
	let bracketDepth = 0;
	let definition: "query" | "fragment" | undefined;
	let hasExecutableQuery = false;

	for (const token of tokens) {
		if (token.kind === "name") {
			if (
				braceDepth === 0 &&
				parenDepth === 0 &&
				bracketDepth === 0 &&
				definition === undefined
			) {
				if (token.value === "mutation" || token.value === "subscription") {
					throw new GraphqlSafetyError(
						`GraphQL operation '${token.value}' is not allowed in a read-only snapshot`,
					);
				}
				if (token.value === "query") {
					definition = "query";
				} else if (token.value === "fragment") {
					definition = "fragment";
				} else {
					throw new GraphqlSafetyError(
						`GraphQL document does not start with a query operation (found '${token.value}')`,
					);
				}
			}
			continue;
		}

		if (token.value === "{") {
			if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
				if (definition === "fragment") {
					// The selection set belongs to a fragment, not an executable query.
				} else {
					definition = "query";
					hasExecutableQuery = true;
				}
			}
			braceDepth += 1;
		} else if (token.value === "}") {
			braceDepth -= 1;
			if (braceDepth < 0) {
				throw new GraphqlSafetyError(
					"GraphQL document has an unmatched closing brace",
				);
			}
			if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
				definition = undefined;
			}
		} else if (token.value === "(") {
			parenDepth += 1;
		} else if (token.value === ")") {
			parenDepth -= 1;
			if (parenDepth < 0) {
				throw new GraphqlSafetyError(
					"GraphQL document has an unmatched closing parenthesis",
				);
			}
		} else if (token.value === "[") {
			bracketDepth += 1;
		} else if (token.value === "]") {
			bracketDepth -= 1;
			if (bracketDepth < 0) {
				throw new GraphqlSafetyError(
					"GraphQL document has an unmatched closing bracket",
				);
			}
		}
	}

	if (braceDepth !== 0 || parenDepth !== 0 || bracketDepth !== 0) {
		throw new GraphqlSafetyError("GraphQL document has unbalanced delimiters");
	}
	if (!hasExecutableQuery) {
		throw new GraphqlSafetyError(
			"GraphQL document contains no executable query operation",
		);
	}
}

function responseErrors(payload: unknown): string[] {
	if (!payload || typeof payload !== "object") {
		return [];
	}
	const errors = (payload as { errors?: unknown }).errors;
	if (!Array.isArray(errors)) {
		return [];
	}
	return errors.map((error) => {
		if (
			error &&
			typeof error === "object" &&
			typeof (error as { message?: unknown }).message === "string"
		) {
			return (error as { message: string }).message;
		}
		return "unknown GraphQL error";
	});
}

export async function requestLinearGraphql(
	document: string,
	variables: Record<string, unknown> = {},
	options: GraphqlRequestOptions,
): Promise<GraphqlData> {
	assertQueryOnly(document);
	const endpoint = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;
	if (endpoint !== LINEAR_GRAPHQL_ENDPOINT) {
		throw new GraphqlRequestError(
			"snapshot endpoint is fixed to https://api.linear.app/graphql",
		);
	}
	const apiKey = options.apiKey.trim();
	if (!apiKey) {
		throw new GraphqlRequestError(
			"LINEAR_API_KEY must be set for snapshot capture",
		);
	}
	const fetchImpl = options.fetchImpl ?? fetch;
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: {
			Authorization: apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ query: document, variables }),
	});
	if (!response.ok) {
		throw new GraphqlRequestError(
			`Linear GraphQL request failed with HTTP ${response.status}`,
		);
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new GraphqlRequestError("Linear GraphQL response was not valid JSON");
	}
	const errors = responseErrors(payload);
	if (errors.length > 0) {
		throw new GraphqlRequestError(
			`Linear GraphQL query returned ${errors.length} error(s): ${errors[0]}`,
		);
	}
	if (!payload || typeof payload !== "object" || !("data" in payload)) {
		throw new GraphqlRequestError(
			"Linear GraphQL response did not contain data",
		);
	}
	const data = (payload as { data?: unknown }).data;
	if (!data || typeof data !== "object") {
		throw new GraphqlRequestError(
			"Linear GraphQL response contained empty data",
		);
	}
	return data as GraphqlData;
}

export function createLinearRequester(
	options: GraphqlRequestOptions,
): GraphqlRequester {
	return (document, variables = {}) =>
		requestLinearGraphql(document, variables, options);
}
