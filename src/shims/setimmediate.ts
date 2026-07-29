// Build shim: replaces the `setimmediate@1.0.5` polyfill that jszip pulls in.
//
// The real polyfill probes the environment by creating `<script>` elements and, on the oldest
// path, calls `new Function(callback)`. Obsidian's automated review reads the built `main.js` and
// rejects both patterns outright, even though the code is a dependency and never runs in Electron.
//
// jszip does use setImmediate for real -- `lib/utils.js` `delay()` yields between chunks in its
// async pipeline -- so this must schedule work, not drop it. Order matters: the native function is
// best, MessageChannel is the fastest standards-only fallback, and setTimeout is last because
// browsers clamp nested timeouts to ~4ms, which would slow every chunked zip operation.
//
// Like the package it replaces, this module is imported for its side effect only.

const globals = globalThis as Record<string, unknown>;

if (typeof globals.setImmediate !== "function") {
	let schedule: (task: () => void) => void;

	if (typeof MessageChannel !== "undefined") {
		const queue: Array<() => void> = [];
		const channel = new MessageChannel();

		// Node keeps its event loop alive for as long as a port is listening, so a channel that is
		// always listening hangs any process bundling this, and one that never listens lets Node
		// exit with callbacks still queued. Hold the reference only while work is pending. Browsers
		// and Electron renderers have neither method and need neither.
		const port = channel.port1 as MessagePort & { ref?: () => void; unref?: () => void };
		port.unref?.();

		port.onmessage = () => {
			queue.shift()?.();
			if (queue.length === 0) port.unref?.();
		};
		schedule = (task) => {
			if (queue.push(task) === 1) port.ref?.();
			channel.port2.postMessage(0);
		};
	} else {
		schedule = (task) => {
			setTimeout(task, 0);
		};
	}

	// The polyfill's contract: return a handle, forward any extra arguments to the callback, and let
	// clearImmediate cancel it. Pending callbacks are held by handle so cancelling forgets them --
	// tracking cancelled ids instead would grow a set that nothing ever prunes.
	const pending = new Map<number, () => void>();
	let nextHandle = 1;

	globals.setImmediate = (callback: (...args: unknown[]) => void, ...args: unknown[]): number => {
		const handle = nextHandle++;
		pending.set(handle, () => callback(...args));
		schedule(() => {
			const task = pending.get(handle);
			pending.delete(handle);
			task?.();
		});
		return handle;
	};

	globals.clearImmediate = (handle: number): void => {
		pending.delete(handle);
	};
}

export {};
