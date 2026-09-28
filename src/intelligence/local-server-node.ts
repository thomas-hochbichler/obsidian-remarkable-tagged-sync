/**
 * The managed local model's extraction server, reached from the running plugin: where the download
 * put `llama-server` and the model, and how to start it. Desktop only, like everything that spawns.
 */

import { Platform } from "obsidian";
import type { ChildProcess } from "child_process";
import { realSleep } from "../llm-transcript";
import { readLocalModelState, resolveLocalModel } from "../local-model-runtime";
import { readLocalModelSettings } from "../local-model-settings";
import { isLocalModelBusy } from "../local-ocr-runtime";
import { obsidianFetch } from "../obsidian-fetch";
import type { BackendSettings } from "../ocr-registry";
import type { ServerDeps } from "./local-server";

/**
 * The server and model of the managed download, or null when it cannot run now: not downloaded, not
 * verified, or busy transcribing. The server ships beside `llama-mtmd-cli` in the same archive.
 */
export function managedModelFiles(settings: BackendSettings, pluginId: string, windows: boolean = Platform.isWin): { executable: string; model: string } | null {
	const resolved = resolveLocalModel(pluginId, readLocalModelSettings(settings).preferredModelDir);
	if (resolved === null) return null;
	const { paths, generation } = resolved;
	if (readLocalModelState(paths, Date.now(), generation) !== "ready" || isLocalModelBusy(paths)) return null;
	const cut = Math.max(paths.runtimeExecutable.lastIndexOf("/"), paths.runtimeExecutable.lastIndexOf("\\"));
	return { executable: `${paths.runtimeExecutable.slice(0, cut + 1)}llama-server${windows ? ".exe" : ""}`, model: paths.modelFile };
}

/** A port from the dynamic range, per start: a busy one ends the start with a reason, and the next sync picks another. */
export function dynamicPort(random: () => number = Math.random): number {
	return 49152 + Math.floor(random() * 16383);
}

export function nodeServerDeps(): ServerDeps {
	return {
		spawn: (command, args) => {
			if (!Platform.isDesktop) throw new Error("The local model runs on desktop only.");
			// eslint-disable-next-line @typescript-eslint/no-require-imports -- Deliberate: a static import would load node modules on mobile, where they do not exist.
			const { spawn } = require("child_process") as typeof import("child_process");
			const child: ChildProcess = spawn(command, args, { stdio: "ignore" });
			return { kill: () => void child.kill(), onExit: (listener) => void child.on("exit", listener) };
		},
		fetchFn: obsidianFetch,
		sleep: realSleep,
		port: () => dynamicPort(),
	};
}
