// The Obsidian store's automated review runs `eslint-plugin-obsidianmd` with its `recommended`
// preset. This file reproduces that locally, so a rejection is something you find before you
// submit rather than after. It buys a local gate only: the store's scanner ignores this config,
// so `globalIgnores` below never changes what the reviewer sees.
//
// The gate is a never-worse ratchet, not fail-on-error -- see scripts/release-checks.mjs and
// docs/RELEASING.md.

import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores, defineConfig } from "eslint/config";

export default defineConfig(
	globalIgnores([
		"node_modules",
		"main.js",
		"main.pro.js",
		"esbuild.config.mjs",
		"vitest.config.ts",
		"package-lock.json",
		"tsconfig.json",
		"versions.json",
		"**/*.test.*",
		"**/*.spec.*",
		"**/test/**",
		"**/tests/**",
		"**/*.cjs",
		"**/*.mjs",
		"**/*.cts",
		"**/*.mts",
		"**/scripts/**",
		"**/docs/**",
		"test-fixtures/**",
		"test-stubs/**",
		"tools/**",
		// These sit on disk in the maintainer's copy but are gitignored, so CI never sees them.
		// Without these entries `eslint .` counts them locally and not in CI, and the ratchet
		// baseline would mean two different numbers on two machines. Same principle as the
		// vitest `include`. (`.scratch/` alone contributed 3 parse errors that CI cannot see.)
		"pro/**",
		".scratch/**",
		".scratch-inspect/**",
		// NOTE: `package.json` is deliberately NOT ignored, even though the official template
		// ignores it. Ignoring it switches off `depend/ban-dependencies`, the check that flags
		// `builtin-modules` and `js-yaml`.
	]),
	{
		languageOptions: {
			globals: { ...globals.browser },
			parserOptions: {
				projectService: {
					allowDefaultProject: ["eslint.config.mjs", "manifest.json"],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			// "reMarkable" and "Obsidian" are brand names; without this the sentence-case rule
			// lowercases them (8 hits).
			"obsidianmd/ui/sentence-case": ["warn", { brands: ["reMarkable", "Obsidian"] }],
		},
	},
);
