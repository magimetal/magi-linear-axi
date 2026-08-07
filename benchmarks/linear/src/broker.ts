import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINEAR_GRAPHQL_ENDPOINT } from "./graphql.js";
import {
	AXI_MAX_ARG_BYTES,
	AXI_MAX_ARG_COUNT,
	parseAxiArgv,
} from "./axi-argv.js";
import { redactSecrets } from "./safety.js";

/** The broker is intentionally Unix-only; benchmark cases run on local Unix hosts. */
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
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

function validateArgShape(argv: readonly string[]): void {
	if (argv.length === 0 || argv.length > AXI_MAX_ARG_COUNT) {
		reject("malformed AXI request: invalid argument count");
	}
	for (const argument of argv) {
		if (
			typeof argument !== "string" ||
			argument.length === 0 ||
			argument.includes("\u0000") ||
			Buffer.byteLength(argument, "utf8") > AXI_MAX_ARG_BYTES
		) {
			reject("malformed AXI request: invalid or oversized argument");
		}
	}
}

/** Validates the complete argv accepted by the credential broker. */
export function validateAxiBrokerArgv(argv: readonly string[]): void {
	validateArgShape(argv);
	const parsed = parseAxiArgv(argv);
	if (!parsed.ok) {
		if (parsed.core[0] === "api") {
			reject("raw AXI API requests are not permitted by the benchmark broker");
		}
		if (parsed.core[0] === "schema") {
			reject("AXI schema output is not permitted by the benchmark broker");
		}
		if (parsed.core[0] === "auth") {
			reject("only AXI auth whoami is permitted by the benchmark broker");
		}
		reject(parsed.reason);
	}
	if (parsed.help || parsed.version) return;
	if (parsed.operation !== undefined) return;
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
