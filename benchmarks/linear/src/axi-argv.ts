export const AXI_MAX_ARG_COUNT = 64;
export const AXI_MAX_ARG_BYTES = 4096;

export type AxiCompactRead =
	| { kind: "issue_view"; identifier: string }
	| { kind: "issue_query"; search: string }
	| { kind: "issue_comment_list"; identifier: string; limit: 10 }
	| { kind: "issue_relation_list"; identifier: string; limit: 10 }
	| { kind: "project_view"; projectId: string };

export type AxiOperation = AxiCompactRead | { kind: "auth_whoami" };

export type AxiArgvParse =
	| {
			ok: true;
			core: string[];
			help: boolean;
			version: boolean;
			operation?: AxiOperation;
	  }
	| {
			ok: false;
			core: string[];
			help: boolean;
			version: boolean;
			reason: string;
	  };

interface SelectorOptions {
	allowLimit: boolean;
	allowSearch?: boolean;
	exactLimit?: 10;
}

interface SelectorState {
	fields: boolean;
	limit?: number;
	positionals: string[];
	search?: string;
}

interface Selectors {
	limit?: number;
	positionals: string[];
	search?: string;
}

type ParseStep = { nextIndex: number } | { reason: string };

interface GlobalState {
	core: string[];
	help: boolean;
	version: boolean;
	seen: Set<string>;
}

interface GlobalParseError {
	state: GlobalState;
	reason: string;
}

type GlobalParse = GlobalState | GlobalParseError;

interface ReadSpec {
	path: readonly string[];
	options: SelectorOptions;
}

const COMPACT_READ_SPECS: ReadSpec[] = [
	{ path: ["issue", "query"], options: { allowLimit: false, allowSearch: true } },
	{ path: ["issue", "view"], options: { allowLimit: false } },
	{
		path: ["issue", "comment", "list"],
		options: { allowLimit: true, exactLimit: 10 },
	},
	{
		path: ["issue", "relation", "list"],
		options: { allowLimit: true, exactLimit: 10 },
	},
	{ path: ["project", "view"], options: { allowLimit: false } },
];

const HELP_OPERATIONS = new Map<string, Set<string>>([
	["issue", new Set(["mine", "list", "query", "view", "v", "title", "describe", "url", "id", "commits", "pull-request", "comment", "relation", "agent-session"])],
	["team", new Set(["list", "create", "delete", "members", "states", "autolinks"])],
	["user", new Set(["list"])],
	["project", new Set(["list", "view", "v", "create", "update", "delete"])],
	["project-update", new Set(["list", "l", "create", "c"])],
	["pu", new Set(["list", "l", "create", "c"])],
	["cycle", new Set(["list", "view", "v"])],
	["cy", new Set(["list", "view", "v"])],
	["milestone", new Set(["list", "view", "v", "create", "update", "delete"])],
	["m", new Set(["list", "view", "v", "create", "update", "delete"])],
	["initiative", new Set(["list", "ls", "view", "v", "create", "update", "archive", "unarchive", "delete", "add-project", "remove-project"])],
	["init", new Set(["list", "ls", "view", "v", "create", "update", "archive", "unarchive", "delete", "add-project", "remove-project"])],
	["initiative-update", new Set(["list", "l", "create", "c"])],
	["iu", new Set(["list", "l", "create", "c"])],
	["label", new Set(["list", "create", "delete"])],
	["l", new Set(["list", "create", "delete"])],
	["document", new Set(["list", "l", "view", "v", "create", "update", "delete"])],
	["docs", new Set(["list", "l", "view", "v", "create", "update", "delete"])],
	["doc", new Set(["list", "l", "view", "v", "create", "update", "delete"])],
	["auth", new Set(["whoami", "login", "list", "default", "token", "logout"])],
	["config", new Set()],
	["setup", new Set()],
	["schema", new Set()],
	["api", new Set()],
]);

const ISSUE_HELP_NESTED_OPERATIONS = new Map<string, Set<string>>([
	["comment", new Set(["list", "add", "update", "delete"])],
	["relation", new Set(["list", "add", "delete"])],
	["agent-session", new Set(["list", "view"])],
]);

function validHelpCore(core: readonly string[]): boolean {
	if (core.length === 0) return true;
	if (core.length > 3) return false;
	const family = core[0];
	if (!family || !HELP_OPERATIONS.has(family)) return false;
	if (core.length === 1) return true;
	const operation = core[1];
	if (!operation || !HELP_OPERATIONS.get(family)?.has(operation)) return false;
	if (core.length === 2) return true;
	if (family !== "issue") return false;
	const nestedOperation = core[2];
	return Boolean(nestedOperation && ISSUE_HELP_NESTED_OPERATIONS.get(operation)?.has(nestedOperation));
}

function invalid(
	core: string[],
	help: boolean,
	version: boolean,
	reason: string,
): AxiArgvParse {
	return { ok: false, core, help, version, reason };
}

function validValue(
	value: string | undefined,
	allowLeadingDash = false,
): string | undefined {
	if (
		value === undefined ||
		value.length === 0 ||
		(!allowLeadingDash && value.startsWith("-")) ||
		value.trim().length === 0
	) {
		return undefined;
	}
	return value;
}

function parseLimitValue(
	value: string | undefined,
	exactLimit: 10 | undefined,
): number | undefined {
	if (value === undefined || !/^\d{1,3}$/u.test(value)) return undefined;
	const limit = Number(value);
	if (limit < 1 || limit > 100) return undefined;
	if (exactLimit !== undefined && value !== String(exactLimit)) return undefined;
	return limit;
}

function limitError(options: SelectorOptions): string {
	return options.exactLimit === 10
		? "malformed AXI request: --limit must be exactly 10"
		: "malformed AXI request: --limit is outside the read bound";
}

function parseFieldsSelector(
	args: readonly string[],
	index: number,
	state: SelectorState,
): ParseStep {
	if (state.fields) return { reason: "malformed AXI request: duplicate --fields" };
	const argument = args[index] ?? "";
	const inline = argument.startsWith("--fields=");
	const value = inline ? argument.slice("--fields=".length) : args[index + 1];
	if (value !== "compact") {
		return { reason: "malformed AXI request: --fields must be compact" };
	}
	state.fields = true;
	return { nextIndex: inline ? index : index + 1 };
}

function parseLimitSelector(
	args: readonly string[],
	index: number,
	state: SelectorState,
	options: SelectorOptions,
): ParseStep {
	if (!options.allowLimit) {
		return { reason: "malformed AXI request: --limit is not allowed for this read" };
	}
	if (state.limit !== undefined) {
		return { reason: "malformed AXI request: duplicate --limit" };
	}
	const argument = args[index] ?? "";
	const inline = argument.startsWith("--limit=");
	const value = inline ? argument.slice("--limit=".length) : args[index + 1];
	const limit = parseLimitValue(value, options.exactLimit);
	if (limit === undefined) return { reason: limitError(options) };
	state.limit = limit;
	return { nextIndex: inline ? index : index + 1 };
}

function parseSearchSelector(
	args: readonly string[],
	index: number,
	state: SelectorState,
	options: SelectorOptions,
): ParseStep {
	if (!options.allowSearch) {
		return { reason: "malformed AXI request: --search is not allowed for this read" };
	}
	const argument = args[index] ?? "";
	if (argument === "--search") {
		return {
			reason:
				"malformed AXI request: issue query requires unambiguous --search=<TEXT>",
		};
	}
	if (state.search !== undefined) {
		return { reason: "malformed AXI request: duplicate --search" };
	}
	const search = validValue(argument.slice("--search=".length), true);
	if (search === undefined) {
		return { reason: "malformed AXI request: --search requires a value" };
	}
	state.search = search;
	return { nextIndex: index };
}

function parseSelectorArgument(
	args: readonly string[],
	index: number,
	state: SelectorState,
	options: SelectorOptions,
): ParseStep | undefined {
	const argument = args[index];
	if (argument === "--fields" || argument?.startsWith("--fields=")) {
		return parseFieldsSelector(args, index, state);
	}
	if (argument === "--limit" || argument?.startsWith("--limit=")) {
		return parseLimitSelector(args, index, state, options);
	}
	if (argument === "--search" || argument?.startsWith("--search=")) {
		return parseSearchSelector(args, index, state, options);
	}
	return undefined;
}

function parseSelectors(
	args: readonly string[],
	options: SelectorOptions,
): { selectors: Selectors } | { reason: string } {
	const state: SelectorState = { fields: false, positionals: [] };
	for (let index = 0; index < args.length; index += 1) {
		const step = parseSelectorArgument(args, index, state, options);
		if (step !== undefined) {
			if ("reason" in step) return step;
			index = step.nextIndex;
			continue;
		}
		const argument = args[index];
		if (argument?.startsWith("-")) return { reason: "unknown or malformed AXI flag" };
		if (argument !== undefined) state.positionals.push(argument);
	}
	if (!state.fields) {
		return { reason: "malformed AXI request: read requires --fields compact" };
	}
	const selectors: Selectors = { positionals: state.positionals };
	if (state.limit !== undefined) selectors.limit = state.limit;
	if (state.search !== undefined) selectors.search = state.search;
	return { selectors };
}

function pathMatches(core: readonly string[], path: readonly string[]): boolean {
	return path.every((part, index) => core[index] === part);
}

function parseSingleIdentifier(
	path: readonly string[],
	positionals: readonly string[],
): { identifier: string } | { reason: string } {
	if (positionals.length !== 1 || positionals[0] === undefined) {
		return { reason: `malformed AXI request: ${path.join(" ")} requires one identifier` };
	}
	const identifier = validValue(positionals[0]);
	if (identifier === undefined) {
		return { reason: `malformed AXI request: ${path.join(" ")} requires an identifier` };
	}
	return { identifier };
}

function buildReadOperation(
	path: readonly string[],
	selectors: Selectors,
): { operation: AxiCompactRead } | { reason: string } {
	const name = path.join(" ");
	if (name === "issue query") {
		if (selectors.positionals.length > 0 || selectors.search === undefined) {
			return { reason: "malformed AXI request: issue query requires --search=<TEXT>" };
		}
		return {
			operation: {
				kind: "issue_query",
				search: selectors.search,
			},
		};
	}
	const parsedIdentifier = parseSingleIdentifier(path, selectors.positionals);
	if ("reason" in parsedIdentifier) return parsedIdentifier;
	if (name === "issue view") {
		return { operation: { kind: "issue_view", identifier: parsedIdentifier.identifier } };
	}
	if (name === "issue comment list" || name === "issue relation list") {
		if (selectors.limit !== 10) {
			return { reason: `malformed AXI request: ${name} requires --limit=10` };
		}
		return {
			operation: {
				kind: name === "issue comment list" ? "issue_comment_list" : "issue_relation_list",
				identifier: parsedIdentifier.identifier,
				limit: 10,
			},
		};
	}
	if (name === "project view") {
		return { operation: { kind: "project_view", projectId: parsedIdentifier.identifier } };
	}
	return { reason: "unknown or disallowed AXI operation" };
}

function parseRead(
	core: string[],
	spec: ReadSpec,
): { operation: AxiCompactRead } | { reason: string } | undefined {
	if (!pathMatches(core, spec.path)) return undefined;
	const parsed = parseSelectors(core.slice(spec.path.length), spec.options);
	if ("reason" in parsed) return parsed;
	return buildReadOperation(spec.path, parsed.selectors);
}

function isFieldsSelector(argument: string): boolean {
	return argument === "--fields" || argument.startsWith("--fields=");
}

function parseGlobalValue(
	argv: readonly string[],
	index: number,
	state: GlobalState,
): ParseStep {
	const argument = argv[index] ?? "";
	const inline = argument.includes("=");
	const separator = argument.indexOf("=");
	const flag = inline ? argument.slice(0, separator) : argument;
	if (state.seen.has(flag)) return { reason: `malformed AXI request: duplicate ${flag}` };
	const value = inline ? argument.slice(separator + 1) : argv[index + 1];
	if (validValue(value) === undefined) {
		return { reason: `malformed AXI request: ${flag} requires a value` };
	}
	if (flag === "--format" && value !== "toon" && value !== "json") {
		return { reason: "malformed AXI request: --format must be toon or json" };
	}
	state.seen.add(flag);
	return { nextIndex: inline ? index : index + 1 };
}

function parseHelpVersionArgument(
	argument: string | undefined,
	index: number,
	state: GlobalState,
): ParseStep | undefined {
	if (argument === "--help" || argument === "-h") {
		if (state.help) return { reason: "malformed AXI request: duplicate help flag" };
		state.help = true;
		return { nextIndex: index };
	}
	if (argument === "--version" || argument === "-V") {
		if (state.version) return { reason: "malformed AXI request: duplicate version flag" };
		state.version = true;
		return { nextIndex: index };
	}
	return undefined;
}

function parseForbiddenGlobal(argument: string | undefined): ParseStep | undefined {
	if (argument === "--full") return { reason: "AXI request cannot use legacy full output" };
	if (argument === "--color") {
		return { reason: "AXI request uses an unsupported global flag" };
	}
	if (argument === "--endpoint" || argument === "-e" || argument?.startsWith("--endpoint")) {
		return { reason: "AXI request cannot override the pinned endpoint" };
	}
	return undefined;
}

function parseGlobalArgument(
	argv: readonly string[],
	index: number,
	state: GlobalState,
): ParseStep | undefined {
	const argument = argv[index];
	const helpOrVersion = parseHelpVersionArgument(argument, index, state);
	if (helpOrVersion !== undefined) return helpOrVersion;
	const forbidden = parseForbiddenGlobal(argument);
	if (forbidden !== undefined) return forbidden;
	if (
		argument === "--format" ||
		argument === "--workspace" ||
		argument?.startsWith("--format=") ||
		argument?.startsWith("--workspace=")
	) {
		return parseGlobalValue(argv, index, state);
	}
	return undefined;
}

function parseGlobalArgs(argv: readonly string[]): GlobalParse {
	const state: GlobalState = { core: [], help: false, version: false, seen: new Set() };
	for (let index = 0; index < argv.length; index += 1) {
		const step = parseGlobalArgument(argv, index, state);
		if (step !== undefined) {
			if ("reason" in step) return { state, reason: step.reason };
			index = step.nextIndex;
			continue;
		}
		const argument = argv[index];
		if (argument === undefined || argument.length === 0) {
			return { state, reason: "malformed AXI request: invalid argument" };
		}
		state.core.push(argument);
	}
	return state;
}

function argvShapeError(argv: readonly string[]): string | undefined {
	if (argv.length === 0 || argv.length > AXI_MAX_ARG_COUNT) {
		return "malformed AXI request: invalid argument count";
	}
	for (const argument of argv) {
		if (
			typeof argument !== "string" ||
			argument.length === 0 ||
			argument.includes("\u0000") ||
			Buffer.byteLength(argument, "utf8") > AXI_MAX_ARG_BYTES
		) {
			return "malformed AXI request: invalid or oversized argument";
		}
	}
	return undefined;
}

function parseCore(state: GlobalState): AxiArgvParse {
	const { core, help, version } = state;
	if (version) {
		return help || core.length > 0
			? invalid(core, help, version, "malformed AXI request: version must be a root operation")
			: { ok: true, core, help, version };
	}
	if (help) {
		if (core.some(isFieldsSelector)) {
			return invalid(core, help, version, "malformed AXI request: --fields is not allowed with help");
		}
		return validHelpCore(core)
			? { ok: true, core, help, version }
			: invalid(core, help, version, "unknown AXI help operation");
	}
	for (const spec of COMPACT_READ_SPECS) {
		const read = parseRead(core, spec);
		if (read === undefined) continue;
		if ("reason" in read) return invalid(core, help, version, read.reason);
		return { ok: true, core, help, version, operation: read.operation };
	}
	if (core.length === 2 && core[0] === "auth" && core[1] === "whoami") {
		return { ok: true, core, help, version, operation: { kind: "auth_whoami" } };
	}
	return invalid(core, help, version, "unknown or disallowed AXI operation");
}

/**
 * Parses the bounded AXI argv grammar shared by the broker, grader, and audit.
 * Global format/workspace selectors are ignored after validation; operation
 * selectors are deliberately strict so legacy full projections cannot enter a
 * benchmark trajectory unnoticed.
 */
export function parseAxiArgv(argv: readonly string[]): AxiArgvParse {
	const shapeError = argvShapeError(argv);
	if (shapeError !== undefined) return invalid([], false, false, shapeError);
	const globals = parseGlobalArgs(argv);
	if ("reason" in globals) {
		return invalid(globals.state.core, globals.state.help, globals.state.version, globals.reason);
	}
	return parseCore(globals);
}

/** Returns the non-option command path used by the safety audit's write checks. */
export function axiCommandPath(tokens: readonly string[]): string[] {
	const path: string[] = [];
	const valueFlags = new Set([
		"--workspace",
		"--endpoint",
		"--format",
		"--output",
		"--fields",
		"--limit",
		"--search",
	]);
	for (let index = 1; index < tokens.length && path.length < 4; index += 1) {
		const token = tokens[index]?.toLowerCase();
		if (!token) continue;
		if (token.startsWith("--")) {
			const flag = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
			if (valueFlags.has(flag) && !token.includes("=")) index += 1;
			continue;
		}
		if (token === "-e" || token === "-h" || token === "-v") {
			if (token === "-e") index += 1;
			continue;
		}
		path.push(token);
	}
	return path;
}
