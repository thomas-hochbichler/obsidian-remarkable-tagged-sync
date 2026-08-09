// Minimal stand-in for the `obsidian` module, which only exists inside the Obsidian app and so
// cannot be resolved under vitest. Aliased in vitest.config.ts.
//
// It reports the *least* capable environment on purpose: a test that reaches real Obsidian API
// should fail loudly rather than quietly pass against a fake. Only add to this when a test genuinely
// needs it -- the real behaviour of these APIs is not covered here.

/** `isDesktop: false` keeps the Vision backend's platform gate closed, so no test spawns a subprocess. */
export const Platform = {
	isDesktop: false,
	isMacOS: false,
};

/**
 * Present only so a module that builds settings rows can be imported at all — registering a backend
 * and rendering its settings live in the same file. Constructing one is a test bug: settings UI is
 * not covered here, and a silent fake would let a test claim it was.
 */
export class Setting {
	constructor() {
		throw new Error("test-stubs/obsidian: Setting is not implemented. A test tried to render real settings UI.");
	}
}
