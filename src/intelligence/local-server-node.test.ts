import { beforeEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { dynamicPort, managedModelFiles, nodeServerDeps } from "./local-server-node";

const runtime = vi.hoisted(() => ({ resolved: null as unknown, state: "ready", busy: false }));
vi.mock("../local-model-runtime", () => ({
	resolveLocalModel: () => runtime.resolved,
	readLocalModelState: () => runtime.state,
}));
vi.mock("../local-ocr-runtime", () => ({ isLocalModelBusy: () => runtime.busy }));

const PATHS = { runtimeExecutable: "/App/bin/llama-b10295/llama-mtmd-cli", modelFile: "/App/models/q/model.gguf" };

describe("managedModelFiles", () => {
	beforeEach(() => {
		runtime.resolved = { paths: PATHS, generation: {} };
		runtime.state = "ready";
		runtime.busy = false;
	});

	it("finds the server beside the transcription runtime, with .exe on Windows", () => {
		expect(managedModelFiles({}, "p")).toEqual({ executable: "/App/bin/llama-b10295/llama-server", model: "/App/models/q/model.gguf" });
		runtime.resolved = { paths: { ...PATHS, runtimeExecutable: "C:\\\\App\\\\bin\\\\llama-mtmd-cli.exe" }, generation: {} };
		expect(managedModelFiles({}, "p", true)?.executable).toBe("C:\\\\App\\\\bin\\\\llama-server.exe");
	});

	it("has nothing while the model is missing, unverified, or busy transcribing", () => {
		runtime.resolved = null;
		expect(managedModelFiles({}, "p", false)).toBeNull();
		runtime.resolved = { paths: PATHS, generation: {} };
		runtime.state = "downloading";
		expect(managedModelFiles({}, "p", false)).toBeNull();
		runtime.state = "ready";
		runtime.busy = true;
		expect(managedModelFiles({}, "p", false)).toBeNull();
	});
});

describe("nodeServerDeps", () => {
	it("picks a port from the dynamic range", () => {
		expect([dynamicPort(() => 0), dynamicPort(() => 0.99999)]).toEqual([49152, 65534]);
		expect(nodeServerDeps().port()).toBeGreaterThanOrEqual(49152);
	});

	it("spawns a real process on the desktop, hears it end, and stops it", async () => {
		const desktop = Platform.isDesktop;
		(Platform as { isDesktop: boolean }).isDesktop = true;
		try {
			const deps = nodeServerDeps();
			const child = deps.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"]);
			const ended = new Promise<number | null>((resolve) => child.onExit(resolve));
			child.kill();
			expect(await ended).toBeNull();
			await deps.sleep(1);
		} finally {
			(Platform as { isDesktop: boolean }).isDesktop = desktop;
		}
	});

	it("refuses to spawn off the desktop", () => {
		const desktop = Platform.isDesktop;
		(Platform as { isDesktop: boolean }).isDesktop = false;
		try {
			expect(() => nodeServerDeps().spawn("x", [])).toThrow("The local model runs on desktop only.");
		} finally {
			(Platform as { isDesktop: boolean }).isDesktop = desktop;
		}
	});
});
