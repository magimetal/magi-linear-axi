import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINEAR_GRAPHQL_ENDPOINT } from "./graphql.js";
import { redactSecrets } from "./safety.js";

/** The broker is intentionally Unix-only; benchmark cases run on local Unix hosts. */
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_ARG_COUNT = 64;
const MAX_ARG_BYTES = 4096;
const BROKER_TIMEOUT_MS = 2 * 60 * 1000;

const SAFE_CHILD_ENVIRONMENT_KEYS = [
	"PATH",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LC_MESSAGES",
	"TERM",
	"NO_COLOR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"CURL_CA_BUNDLE",
	"REQUESTS_CA_BUNDLE",
	"NODE_EXTRA_CA_CERTS",
] as const;

const HELP_FAMILIES = new Map<string, Set<string>>([
	["issue", new Set(["comment", "relation", "agent-session"])],
	["team", new Set()],
	["user", new Set()],
	["project", new Set()],
	["project-update", new Set()],
	["pu", new Set()],
	["cycle", new Set()],
	["cy", new Set()],
	["milestone", new Set()],
	["m", new Set()],
	["initiative", new Set()],
	["init", new Set()],
	["initiative-update", new Set()],
	["iu", new Set()],
	["label", new Set()],
	["l", new Set()],
	["document", new Set()],
	["docs", new Set()],
	["doc", new Set()],
	["auth", new Set()],
	["config", new Set()],
	["setup", new Set()],
	["schema", new Set()],
	["api", new Set()],
]);

const HELP_NESTED_OPERATIONS = new Map<string, Set<string>>([
	[
		"issue",
		new Set([
			"mine",
			"list",
			"query",
			"view",
			"v",
			"title",
			"describe",
			"url",
			"id",
			"commits",
			"pull-request",
			"comment",
			"relation",
			"agent-session",
		]),
	],
	["team", new Set(["list", "create", "delete", "members", "states", "autolinks"])],
	["user", new Set(["list"])],
	["project", new Set(["list", "view", "v", "create", "update", "delete"])],
	["project-update", new Set(["list", "l", "create", "c"])],
	["pu", new Set(["list", "l", "create", "c"])],
	["cycle", new Set(["list", "view", "v"])],
	["cy", new Set(["list", "view", "v"])],
	["milestone", new Set(["list", "view", "v", "create", "update", "delete"])],
	["m", new Set(["list", "view", "v", "create", "update", "delete"])],
	[
		"initiative",
		new Set(["list", "ls", "view", "v", "create", "update", "archive", "unarchive", "delete", "add-project", "remove-project"]),
	],
	[
		"init",
		new Set(["list", "ls", "view", "v", "create", "update", "archive", "unarchive", "delete", "add-project", "remove-project"]),
	],
	["initiative-update", new Set(["list", "l", "create", "c"])],
	["iu", new Set(["list", "l", "create", "c"])],
	["label", new Set(["list", "create", "delete"])],
	["l", new Set(["list", "create", "delete"])],
	["document", new Set(["list", "l", "view", "v", "create", "update", "delete"])],
	["docs", new Set(["list", "l", "view", "v", "create", "update", "delete"])],
	["doc", new Set(["list", "l", "view", "v", "create", "update", "delete"])],
	["auth", new Set(["whoami", "login", "list", "default", "token", "logout"])],
]);

export class AxiBrokerValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AxiBrokerValidationError";
	}
}

export interface AxiBrokerOptions {
	apiKey: string;
	axiBin: string;
	endpoint?: string;
	xdgConfigHome: string;
	cwd: string;
	/** Environment source for non-secret PATH/locale/proxy/certificate values. */
	timingFile?: string;
	environment?: NodeJS.ProcessEnv;
}

export interface BrokerTimingSummary {
	wrapperRoundTripMs: number;
	wrapperRoundTripCount: number;
	axiChildMs: number;
	axiChildCount: number;
}

export interface AxiBrokerHandle {
	directory: string;
	socketPath: string;
	wrapperPath: string;
	cleanup: () => Promise<void>;
	timing: BrokerTimingSummary;
}

interface BrokerRequest {
	argv: string[];
}

interface BrokerResponse {
	stdout: string;
	stderr: string;
	exitCode: number;
	signal?: string;
}

interface NormalizedArgs {
	core: string[];
	help: boolean;
	version: boolean;
}

function boundedUtf8(value: string, maxBytes: number): string {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.byteLength <= maxBytes) {
		return value;
	}
	return buffer.subarray(0, maxBytes).toString("utf8");
}

function reject(message: string): never {
	throw new AxiBrokerValidationError(message);
}

function validValue(
	value: string | undefined,
	label: string,
	maxLength = MAX_ARG_BYTES,
	allowLeadingDash = false,
): string {
	if (!value || (!allowLeadingDash && value.startsWith("-"))) {
		reject(`malformed AXI request: ${label} requires a value`);
	}
	if (value.includes("\u0000") || Buffer.byteLength(value, "utf8") > maxLength) {
		reject(`malformed AXI request: ${label} is invalid or oversized`);
	}
	return value;
}

function validateArgShape(argv: readonly string[]): void {
	if (argv.length === 0 || argv.length > MAX_ARG_COUNT) {
		reject("malformed AXI request: invalid argument count");
	}
	for (const argument of argv) {
		if (
			typeof argument !== "string" ||
			argument.length === 0 ||
			argument.includes("\u0000") ||
			Buffer.byteLength(argument, "utf8") > MAX_ARG_BYTES
		) {
			reject("malformed AXI request: invalid or oversized argument");
		}
	}
}

function stripSafeGlobalFlags(argv: readonly string[]): NormalizedArgs {
	const core: string[] = [];
	let help = false;
	let version = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--") {
			reject("AXI request cannot use a positional argument separator");
		}
		if (argument === "--help" || argument === "-h") {
			if (help) {
				reject("malformed AXI request: duplicate help flag");
			}
			help = true;
			continue;
		}
		if (argument === "--version" || argument === "-V") {
			if (version) {
				reject("malformed AXI request: duplicate version flag");
			}
			version = true;
			continue;
		}
		if (argument === "--full" || argument === "--color") {
			if (argument === "--color") {
				reject("AXI request uses an unsupported global flag");
			}
			continue;
		}
		if (argument === "--format" || argument === "--workspace") {
			const value = validValue(argv[index + 1], argument);
			if (argument === "--format" && value !== "toon" && value !== "json") {
				reject("malformed AXI request: --format must be toon or json");
			}
			index += 1;
			continue;
		}
		if (argument.startsWith("--format=") || argument.startsWith("--workspace=")) {
			const [flag, ...parts] = argument.split("=");
			const value = parts.join("=");
			validValue(value, flag ?? "global flag");
			if (flag === "--format" && value !== "toon" && value !== "json") {
				reject("malformed AXI request: --format must be toon or json");
			}
			continue;
		}
		if (argument.startsWith("--endpoint") || argument === "-e") {
			reject("AXI request cannot override the pinned endpoint");
		}
		if (argument.startsWith("-") && argument !== "-") {
			core.push(argument);
			continue;
		}
		core.push(argument);
	}
	return { core, help, version };
}

function validateHelp(core: readonly string[], help: boolean, version: boolean): void {
	if (version) {
		if (help || core.length > 0) {
			reject("malformed AXI request: version must be a root operation");
		}
		return;
	}
	if (!help) {
		return;
	}
	if (core.length === 0) {
		return;
	}
	if (core.length > 3) {
		reject("unknown AXI help operation");
	}
	const family = core[0];
	if (!family || !HELP_FAMILIES.has(family)) {
		reject("unknown AXI help family");
	}
	if (core.length === 2) {
		const operation = core[1];
		if (!operation || !HELP_NESTED_OPERATIONS.get(family)?.has(operation)) {
			reject("unknown AXI help operation");
		}
	}
	if (core.length === 3) {
		const nested = core[1];
		const operation = core[2];
		let allowed = new Set<string>();
		if (nested === "comment") {
			allowed = new Set(["list", "add", "update", "delete"]);
		} else if (nested === "relation") {
			allowed = new Set(["list", "add", "delete"]);
		} else if (nested === "agent-session") {
			allowed = new Set(["list", "view"]);
		}
		if (!operation || !allowed.has(operation)) {
			reject("unknown AXI help operation");
		}
	}
}

function exactRead(core: readonly string[], expected: readonly string[]): boolean {
	if (core.length !== expected.length || core.some((value, index) => value !== expected[index])) {
		return false;
	}
	return true;
}

function positional(core: readonly string[], index: number, label: string): void {
	validValue(core[index], label);
}

function validateIssueQuery(core: readonly string[]): void {
	if (core.length < 3 || core[0] !== "issue" || core[1] !== "query") {
		reject("unknown or malformed AXI read operation");
	}
	let search: string | undefined;
	for (let index = 2; index < core.length; index += 1) {
		const argument = core[index];
		if (argument === "--search") {
			reject(
				"malformed AXI request: issue query requires unambiguous --search=<TEXT>",
			);
		}
		if (argument?.startsWith("--search=")) {
			if (search !== undefined) {
				reject("malformed AXI request: duplicate --search");
			}
			search = validValue(
				argument.slice("--search=".length),
				"--search",
				MAX_ARG_BYTES,
				true,
			);
			continue;
		}
		if (argument === "--limit") {
			const value = validValue(core[index + 1], "--limit", 32);
			if (!/^\d{1,3}$/u.test(value) || Number(value) < 1 || Number(value) > 100) {
				reject("malformed AXI request: --limit is outside the read bound");
			}
			index += 1;
			continue;
		}
		if (argument?.startsWith("--limit=")) {
			const value = validValue(argument.slice("--limit=".length), "--limit", 32);
			if (!/^\d{1,3}$/u.test(value) || Number(value) < 1 || Number(value) > 100) {
				reject("malformed AXI request: --limit is outside the read bound");
			}
			continue;
		}
		reject("unknown or malformed AXI read operation");
	}
	if (search === undefined) {
		reject("malformed AXI request: issue query requires --search");
	}
}

/** Validates the complete argv accepted by the credential broker. */
export function validateAxiBrokerArgv(argv: readonly string[]): void {
	validateArgShape(argv);
	if (argv.some((argument) => argument === "--endpoint" || argument.startsWith("--endpoint="))) {
		reject("AXI request cannot override the pinned endpoint");
	}
	const normalized = stripSafeGlobalFlags(argv);
	validateHelp(normalized.core, normalized.help, normalized.version);
	if (normalized.help || normalized.version) {
		return;
	}
	const core = normalized.core;
	if (core[0] === "issue" && core[1] === "query") {
		validateIssueQuery(core);
		return;
	}
	if (core.some((argument) => argument.startsWith("-"))) {
		reject("unknown or malformed AXI flag");
	}
	if (exactRead(core, ["auth", "whoami"])) {
		return;
	}
	if (core[0] === "api") {
		reject("raw AXI API requests are not permitted by the benchmark broker");
	}
	if (core[0] === "schema") {
		reject("AXI schema output is not permitted by the benchmark broker");
	}
	if (core[0] === "auth") {
		reject("only AXI auth whoami is permitted by the benchmark broker");
	}
	if (exactRead(core.slice(0, 2), ["issue", "view"])) {
		if (core.length !== 3) {
			reject("malformed AXI request: issue view requires one identifier");
		}
		positional(core, 2, "issue identifier");
		return;
	}
	if (exactRead(core.slice(0, 3), ["issue", "comment", "list"])) {
		if (core.length !== 4) {
			reject("malformed AXI request: issue comment list requires one identifier");
		}
		positional(core, 3, "issue identifier");
		return;
	}
	if (exactRead(core.slice(0, 3), ["issue", "relation", "list"])) {
		if (core.length !== 4) {
			reject("malformed AXI request: issue relation list requires one identifier");
		}
		positional(core, 3, "issue identifier");
		return;
	}
	if (exactRead(core.slice(0, 2), ["project", "view"])) {
		if (core.length !== 3) {
			reject("malformed AXI request: project view requires one identifier");
		}
		positional(core, 2, "project identifier");
		return;
	}
	reject("unknown or disallowed AXI operation");
}

function childEnvironment(options: AxiBrokerOptions): NodeJS.ProcessEnv {
	const source = options.environment ?? process.env;
	const environment: NodeJS.ProcessEnv = {};
	for (const key of SAFE_CHILD_ENVIRONMENT_KEYS) {
		const value = source[key];
		if (value !== undefined) {
			environment[key] = value;
		}
	}
	environment.PATH = environment.PATH ?? "/usr/local/bin:/usr/bin:/bin";
	environment.LINEAR_API_KEY = options.apiKey;
	environment.LINEAR_API_URL = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;
	environment.XDG_CONFIG_HOME = options.xdgConfigHome;
	if (options.timingFile) {
		environment.MAGI_LINEAR_TIMING_FILE = options.timingFile;
	}
	return environment;
}

function responseText(value: string, apiKey: string): string {
	return boundedUtf8(redactSecrets(value, [apiKey]), MAX_OUTPUT_BYTES);
}

function responseJson(response: BrokerResponse): string {
	return boundedUtf8(JSON.stringify(response), MAX_RESPONSE_BYTES);
}

function allowedEndpoint(endpoint: string): boolean {
	if (endpoint === LINEAR_GRAPHQL_ENDPOINT) {
		return true;
	}
	try {
		const url = new URL(endpoint);
		return url.protocol === "http:" &&
			(url.hostname === "127.0.0.1" ||
				url.hostname === "localhost" ||
				url.hostname === "[::1]");
	} catch {
		return false;
	}
}

async function spawnAxi(
	options: AxiBrokerOptions,
	argv: string[],
	activeChildren: Set<ChildProcess>,
	timing: BrokerTimingSummary,
): Promise<BrokerResponse> {
	const childStarted = performance.now();
	return new Promise((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn(options.axiBin, argv, {
				cwd: options.cwd,
				env: childEnvironment(options),
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error: unknown) {
			resolve({
				stdout: "",
				stderr: responseText(
					error instanceof Error ? error.message : "AXI could not be started",
					options.apiKey,
				),
				exitCode: 127,
			});
			return;
		}
		activeChildren.add(child);
		let stdout = "";
		let stderr = "";
		let overflow = false;
		let settled = false;
		const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
			if (overflow) {
				return;
			}
			const current = target === "stdout" ? stdout : stderr;
			const next = `${current}${chunk.toString("utf8")}`;
			if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) {
				overflow = true;
				stderr = `${stderr}AXI broker output exceeded the bounded limit`;
				child.kill("SIGKILL");
				return;
			}
			if (target === "stdout") {
				stdout = next;
			} else {
				stderr = next;
			}
		};
		const finish = (response: BrokerResponse): void => {
			if (settled) {
				return;
			}
			settled = true;
			activeChildren.delete(child);
			timing.axiChildMs += performance.now() - childStarted;
			timing.axiChildCount += 1;
			resolve({
				stdout: responseText(response.stdout, options.apiKey),
				stderr: responseText(response.stderr, options.apiKey),
				exitCode: response.exitCode,
				...(response.signal ? { signal: response.signal } : {}),
			});
		};
		child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
		const timer = setTimeout(() => {
			if (!settled) {
				stderr += "AXI broker child exceeded the execution limit";
				child.kill("SIGKILL");
			}
		}, BROKER_TIMEOUT_MS);
		child.once("error", (error) => {
			clearTimeout(timer);
			finish({ stdout, stderr: error.message, exitCode: 127 });
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			finish({
				stdout,
				stderr,
				exitCode: code === null ? 1 : code,
				...(signal ? { signal } : {}),
			});
		});
	});
}

function errorResponse(error: unknown, apiKey: string): BrokerResponse {
	return {
		stdout: "",
		stderr: responseText(error instanceof Error ? error.message : "AXI broker rejected the request", apiKey),
		exitCode: 2,
	};
}

function parseRequest(value: string): BrokerRequest {
	if (Buffer.byteLength(value, "utf8") > MAX_REQUEST_BYTES) {
		reject("malformed AXI broker request: request is oversized");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		reject("malformed AXI broker request: invalid JSON");
	}
	if (
		!parsed ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		Object.keys(parsed).length !== 1 ||
		!("argv" in parsed) ||
		!Array.isArray((parsed as { argv?: unknown }).argv)
	) {
		reject("malformed AXI broker request: expected an argv array");
	}
	const argv = (parsed as { argv: unknown[] }).argv;
	if (argv.some((argument) => typeof argument !== "string")) {
		reject("malformed AXI broker request: argv must contain strings");
	}
	return { argv: argv as string[] };
}

function wrapperSource(socketPath: string): string {
	return `#!/usr/bin/env node
import net from "node:net";

const socketPath = ${JSON.stringify(socketPath)};
const maxResponseBytes = ${MAX_RESPONSE_BYTES};
let finished = false;
const fail = (message) => {
  if (finished) return;
  finished = true;
  process.stderr.write(message + "\\n");
  process.exitCode = 2;
};
const socket = net.createConnection({ path: socketPath });
const chunks = [];
let total = 0;
socket.on("data", (chunk) => {
  if (finished) return;
  total += chunk.byteLength;
  if (total > maxResponseBytes) {
    socket.destroy();
    fail("AXI broker returned an oversized response");
    return;
  }
  chunks.push(chunk);
});
socket.once("error", () => fail("AXI credential broker is unavailable"));
socket.once("end", () => {
  if (finished) return;
  let response;
  try {
    response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("AXI broker returned malformed response");
    return;
  }
  if (!response || typeof response !== "object" || typeof response.stdout !== "string" || typeof response.stderr !== "string" || !Number.isInteger(response.exitCode)) {
    fail("AXI broker returned an invalid response");
    return;
  }
  finished = true;
  process.stdout.write(response.stdout);
  process.stderr.write(response.stderr);
  process.exitCode = response.exitCode;
});
socket.end(JSON.stringify({ argv: process.argv.slice(2) }));
`;
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		if (!server.listening) {
			resolve();
			return;
		}
		server.close(() => resolve());
	});
}

/**
 * Starts a per-case credential broker and returns a key-free executable wrapper.
 * The actual AXI path, endpoint, cwd, XDG directory, and credential never cross
 * the wrapper/protocol boundary; only validated argv crosses the Unix socket.
 */
export async function createAxiBroker(options: AxiBrokerOptions): Promise<AxiBrokerHandle> {
	if (process.platform === "win32") {
		throw new Error("AXI credential broker requires Unix-domain sockets and is unsupported on Windows");
	}
	if (!options.apiKey.trim()) {
		throw new Error("AXI credential broker requires a non-empty API key");
	}
	const endpoint = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;
	if (!allowedEndpoint(endpoint)) {
		throw new Error(
			"AXI credential broker endpoint must be official Linear GraphQL or loopback test HTTP",
		);
	}
	const directory = await mkdtemp(join(tmpdir(), "axi-broker-"));
	await chmod(directory, 0o700);
	const socketPath = join(directory, "s.sock");
	const wrapperPath = join(directory, "axi-wrapper");
	try {
		await writeFile(wrapperPath, wrapperSource(socketPath), { mode: 0o700 });
		await chmod(wrapperPath, 0o700);
	} catch (error: unknown) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}

	const activeChildren = new Set<ChildProcess>();
	const sockets = new Set<Socket>();
	const timing: BrokerTimingSummary = {
		wrapperRoundTripMs: 0,
		wrapperRoundTripCount: 0,
		axiChildMs: 0,
		axiChildCount: 0,
	};
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		const wrapperStarted = performance.now();
		sockets.add(socket);
		let chunks: Buffer[] = [];
		let total = 0;
		let handled = false;
		let timingRecorded = false;
		const sendResponse = (response: BrokerResponse): void => {
			if (!timingRecorded) {
				timingRecorded = true;
				timing.wrapperRoundTripMs += performance.now() - wrapperStarted;
				timing.wrapperRoundTripCount += 1;
			}
			socket.end(responseJson(response));
		};
		const rejectSocket = (error: unknown): void => {
			if (handled) {
				return;
			}
			handled = true;
			sendResponse(errorResponse(error, options.apiKey));
		};
		socket.setTimeout(10_000, () =>
			rejectSocket(
				new AxiBrokerValidationError("AXI broker request timed out"),
			),
		);
		socket.on("data", (chunk: Buffer) => {
			if (handled) {
				return;
			}
			total += chunk.byteLength;
			if (total > MAX_REQUEST_BYTES) {
				chunks = [];
				rejectSocket(new AxiBrokerValidationError("malformed AXI broker request: request is oversized"));
				return;
			}
			chunks.push(chunk);
		});
		socket.once("error", () => {
			sockets.delete(socket);
		});
		socket.once("close", () => sockets.delete(socket));
		socket.once("end", () => {
			if (handled) {
				return;
			}
			handled = true;
			const requestText = Buffer.concat(chunks).toString("utf8");
			void (async () => {
				try {
					const request = parseRequest(requestText);
					validateAxiBrokerArgv(request.argv);
					const response = await spawnAxi(options, request.argv, activeChildren, timing);
					sendResponse(response);
				} catch (error: unknown) {
					sendResponse(errorResponse(error, options.apiKey));
				}
			})();
		});
	});
	try {
		await new Promise<void>((resolve, rejectPromise) => {
			server.once("error", rejectPromise);
			server.listen(socketPath, () => resolve());
		});
		await chmod(socketPath, 0o700);
	} catch (error: unknown) {
		await closeServer(server).catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	let cleaned = false;
	return {
		directory,
		socketPath,
		wrapperPath,
		cleanup: async () => {
			if (cleaned) {
				return;
			}
			cleaned = true;
			for (const socket of sockets) {
				socket.destroy();
			}
			for (const child of activeChildren) {
				child.kill("SIGKILL");
			}
			await closeServer(server);
			await rm(directory, { recursive: true, force: true });
		},
		timing,
	};
}
