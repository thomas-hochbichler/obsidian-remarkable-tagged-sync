/**
 * The managed local model as an extraction backend: the Free default (spec §6, §11). Transcription
 * runs the model once per page through `llama-mtmd-cli`; extraction asks two text questions per page,
 * so it runs `llama-server` from the same download instead -- started once, on the first page a sync
 * extracts, and stopped when that sync ends. Loading an 8B model per question would cost more than the
 * questions.
 *
 * Settings follow research 15: context 8192, temperature 0, seed 42.
 */

import type { BackendSettings } from "../ocr-registry";
import { type Complete, type ExtractionBackend, openAiCompatComplete, twoCallBackend } from "./extraction-backend";
import type { ExtractionBackendEntry } from "./extraction-registry";

export interface ServerProcess {
	kill(): void;
	/** Registers what to do when the process ends on its own -- a crash, or a port already taken. */
	onExit(listener: (code: number | null) => void): void;
}

export interface ServerDeps {
	spawn(command: string, args: string[]): ServerProcess;
	fetchFn: typeof fetch;
	sleep(ms: number): Promise<void>;
	/** A port to listen on; one from the dynamic range is picked per start. */
	port(): number;
}

export const LOCAL_CONTEXT = 8192;
export const LOCAL_SEED = 42;
/** Loading the 8B model from disk takes seconds on an M2 Max; two minutes is a machine that cannot. */
const START_TIMEOUT_MS = 120_000;
const POLL_MS = 250;

export interface ManagedServer {
	/** The server's OpenAI-compatible base URL, starting it on first use. Rejects with a reason a user can act on. */
	baseURL(): Promise<string>;
	/**
	 * Stops the server if it runs. Safe to call twice, or never started. A start that failed stays
	 * failed: every later page is told at once, instead of waiting two minutes each.
	 */
	dispose(): void;
}

export function managedServer(deps: ServerDeps, executable: string, model: string): ManagedServer {
	let starting: Promise<string> | null = null;
	let process: ServerProcess | null = null;
	let failed: Error | null = null;

	const start = async (): Promise<string> => {
		const port = deps.port();
		let exited: number | null | undefined;
		process = deps.spawn(executable, ["-m", model, "-c", String(LOCAL_CONTEXT), "--host", "127.0.0.1", "--port", String(port)]);
		process.onExit((code) => void (exited = code));
		const url = `http://127.0.0.1:${port}`;
		for (let waited = 0; waited < START_TIMEOUT_MS; waited += POLL_MS) {
			if (exited !== undefined) throw new Error(`The local model stopped while starting (exit ${exited ?? "signal"}).`);
			try {
				if ((await deps.fetchFn(`${url}/health`)).ok) return `${url}/v1`;
			} catch {
				// Not listening yet: the model is still loading.
			}
			await deps.sleep(POLL_MS);
		}
		process.kill();
		throw new Error("The local model did not start within two minutes.");
	};

	return {
		baseURL: () =>
			failed !== null
				? Promise.reject(failed)
				: (starting ??= start().catch((error: Error) => {
						failed = error;
						throw error;
					})),
		dispose: () => {
			process?.kill();
			process = null;
			starting = null;
		},
	};
}

/** The two-call backend on the managed server. A server that will not start fails each page with its reason. */
export function managedLocalBackend(server: ManagedServer, deps: Pick<ServerDeps, "fetchFn">): ExtractionBackend & { dispose(): void; rest(): void } {
	const complete: Complete = async (request) => {
		let baseURL: string;
		try {
			baseURL = await server.baseURL();
		} catch (error) {
			return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
		}
		return openAiCompatComplete({ baseURL, model: "local", deterministic: true, seed: LOCAL_SEED, fetchFn: deps.fetchFn })(request);
	};
	return { ...twoCallBackend("local", false, complete), dispose: () => server.dispose(), rest: () => server.dispose() };
}

/**
 * The "local" extraction entry: the managed download, free, and measured on the corpus (research 15;
 * the prompt is research 22's). `files` answers where the server and model are, or null when the
 * model cannot run now -- the engine then pauses with the backend's reason.
 */
export function managedLocalEntry(files: (settings: BackendSettings) => { executable: string; model: string } | null, deps: () => ServerDeps): ExtractionBackendEntry {
	return {
		id: "local",
		label: "Local model (this computer)",
		metered: false,
		requiresLicence: false,
		measured: true,
		create: (settings) => {
			const found = files(settings);
			if (found === null) return null;
			const serverDeps = deps();
			return managedLocalBackend(managedServer(serverDeps, found.executable, found.model), serverDeps);
		},
	};
}
