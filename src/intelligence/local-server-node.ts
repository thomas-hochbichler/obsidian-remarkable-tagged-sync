/**
 * The managed local model's extraction server, reached from the running plugin: where the download
 * put `llama-server` and the model, and how to start it. Desktop only, like everything that spawns.
 */

import { Platform } from "obsidian";
import type { ChildProcess } from "child_process";
import { realSleep } from "../llm-transcript";
import { QWEN3_VL_8B } from "../local-model-artefacts";
import { pathsForGeneration, readLocalModelState } from "../local-model-runtime";
import { isLocalModelBusy } from "../local-ocr-runtime";
import { obsidianFetch } from "../obsidian-fetch";
import type { ServerDeps } from "./local-server";

/**
 * The server and the 8B model of the managed download, or null when it cannot run now: not
 * downloaded, not verified, or busy transcribing. Always the 8B, whichever model transcribes: the
 * extraction prompt is measured on it only, and the 2B copies the transcript into its notes and then
 * breaks the format pass (live test, 2026-09-29). The server ships beside `llama-mtmd-cli`.
 */
export function managedModelFiles(pluginId: string, windows: boolean = Platform.isWin): { executable: string; model: string } | null {
	const paths = pathsForGeneration(pluginId, QWEN3_VL_8B);
	if (paths === null) return null;
	if (readLocalModelState(paths, Date.now(), QWEN3_VL_8B) !== "ready" || isLocalModelBusy(paths)) return null;
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
