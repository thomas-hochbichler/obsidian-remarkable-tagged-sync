import { describe, expect, it } from "vitest";
import { calendarDay } from "./dates";
import { managedLocalBackend, managedLocalEntry, managedServer, type ServerDeps, type ServerProcess } from "./local-server";
import { defaultSlots, genericProfile } from "./settings";

/** A server that answers /health after `readyAfter` polls, and records every request. */
function fakeServer(options: { readyAfter?: number; exitAfter?: number } = {}) {
	const spawned: string[][] = [];
	const bodies: Record<string, unknown>[] = [];
	let polls = 0;
	let killed = 0;
	let exit: ((code: number | null) => void) | null = null;
	const deps: ServerDeps = {
		spawn: (command, args) => {
			spawned.push([command, ...args]);
			const process: ServerProcess = { kill: () => void killed++, onExit: (listener) => void (exit = listener) };
			return process;
		},
		fetchFn: (async (url: string, init?: RequestInit) => {
			if (url.endsWith("/health")) {
				polls++;
				if (options.exitAfter !== undefined && polls >= options.exitAfter) exit?.(1);
				if (polls < (options.readyAfter ?? 1)) throw new Error("connect ECONNREFUSED");
				return new Response("{}", { status: 200 });
			}
			bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
			return new Response(JSON.stringify({ choices: [{ message: { content: "NONE" } }] }), { status: 200 });
		}) as unknown as typeof fetch,
		sleep: async () => {},
		port: () => 50001,
	};
	return { deps, spawned, bodies, polls: () => polls, killed: () => killed };
}

const INPUT = { profile: genericProfile(false), slots: defaultSlots().slice(0, 1), transcript: "a page", referenceDate: calendarDay(2026, 8, 28), known: {} };

describe("managedServer", () => {
	it("starts the server once, on first use, with the model, context and a local port, and waits until it answers", async () => {
		const s = fakeServer({ readyAfter: 3 });
		const server = managedServer(s.deps, "/bin/llama-server", "/m/model.gguf");
		expect(s.spawned).toEqual([]);
		const [a, b] = await Promise.all([server.baseURL(), server.baseURL()]);
		expect([a, b]).toEqual(["http://127.0.0.1:50001/v1", "http://127.0.0.1:50001/v1"]);
		expect(s.spawned).toEqual([["/bin/llama-server", "-m", "/m/model.gguf", "-c", "8192", "--host", "127.0.0.1", "--port", "50001"]]);
		expect(s.polls()).toBe(3);
		server.dispose();
		server.dispose();
		expect(s.killed()).toBe(1);
	});

	it("says so when the server stops while starting, and tells every later page at once, also after a rest", async () => {
		const s = fakeServer({ readyAfter: 99, exitAfter: 2 });
		const server = managedServer(s.deps, "srv", "m");
		await expect(server.baseURL()).rejects.toThrow("The local model stopped while starting (exit 1).");
		server.dispose();
		await expect(server.baseURL()).rejects.toThrow(/stopped while starting/);
		expect(s.spawned).toHaveLength(1);
	});

	it("starts again after a rest between documents", async () => {
		const s = fakeServer();
		const backend = managedLocalBackend(managedServer(s.deps, "srv", "m"), s.deps);
		await backend.extract(INPUT);
		backend.rest();
		expect(s.killed()).toBe(1);
		await backend.extract(INPUT);
		expect(s.spawned).toHaveLength(2);
	});

	it("gives up after two minutes of waiting, stopping what it started, and names a signal as a signal", async () => {
		const s = fakeServer({ readyAfter: Number.POSITIVE_INFINITY });
		await expect(managedServer(s.deps, "srv", "m").baseURL()).rejects.toThrow("The local model did not start within two minutes.");
		expect(s.killed()).toBe(1);
		const signalled = fakeServer({ readyAfter: 99 });
		const spawn = signalled.deps.spawn;
		signalled.deps.spawn = (command, args) => {
			const process = spawn(command, args);
			return { ...process, onExit: (listener) => listener(null) };
		};
		await expect(managedServer(signalled.deps, "srv", "m").baseURL()).rejects.toThrow("(exit signal)");
	});
});

describe("managedLocalBackend", () => {
	it("asks the managed server both passes with temperature 0 and seed 42, and stops it on dispose", async () => {
		const s = fakeServer();
		const backend = managedLocalBackend(managedServer(s.deps, "srv", "m"), s.deps);
		expect(backend).toMatchObject({ id: "local", metered: false, local: true });
		expect(await backend.extract(INPUT)).toMatchObject({ kind: "ok" });
		expect(s.bodies[0]).toMatchObject({ model: "local", temperature: 0, seed: 42, max_tokens: 3000 });
		backend.dispose();
		expect(s.killed()).toBe(1);
	});

	it("fails each page with the server's reason when it will not start", async () => {
		const s = fakeServer({ readyAfter: 99, exitAfter: 1 });
		expect(await managedLocalBackend(managedServer(s.deps, "srv", "m"), s.deps).extract(INPUT)).toEqual({ kind: "failed", reason: "The local model stopped while starting (exit 1)." });
		const throwing = { baseURL: () => Promise.reject("odd"), dispose: () => {} };
		expect(await managedLocalBackend(throwing, s.deps).extract(INPUT)).toEqual({ kind: "failed", reason: "odd" });
	});
});

describe("managedLocalEntry", () => {
	it("is the free, measured local entry, and has no backend while the model cannot run", () => {
		const s = fakeServer();
		const entry = managedLocalEntry((settings) => (settings.ready === true ? { executable: "srv", model: "m" } : null), () => s.deps);
		expect(entry).toMatchObject({ id: "local", metered: false, requiresLicence: false, measured: true });
		expect(entry.create({}, null)).toBeNull();
		expect(entry.create({ ready: true }, null)).toMatchObject({ id: "local", local: true });
		expect(s.spawned).toEqual([]);
	});
});
