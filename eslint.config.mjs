// The Obsidian store's automated review runs `eslint-plugin-obsidianmd` with its `recommended`
// preset. This file reproduces that locally, so a rejection is something you find before you
// submit rather than after. The store's scanner ignores this config, so nothing here changes what
// the reviewer sees -- which is why the ignore list below is the scanner's own and not ours.
//
// The gate is a never-worse ratchet, not fail-on-error -- see scripts/release-checks.mjs and
// docs/RELEASING.md.

import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores, defineConfig } from "eslint/config";

export default defineConfig(
	globalIgnores([
		// The scanner's hardcoded ignore list, copied verbatim from obsidianmd/eslint-plugin PR #158.
		// A list of our own drifts: a file we skip and the scanner reads is a scorecard finding no
		// local run shows, and a file we read and the scanner skips is a ratchet number the store
		// never sees. Edit it only when the scanner's list changes.
		"node_modules",
		"dist",
		"build",
		"pkg",
		"test-vault",
		".obsidian",
		"esbuild.config.mjs",
		"version-bump.mjs",
		"**/*.test.*",
		"**/*.spec.*",
		"**/test/**",
		"**/tests/**",
		"**/__tests__/**",
		"**/mocks/**",
		"**/__mocks__/**",
		"**/*.cjs",
		"**/*.mjs",
		"**/*.cts",
		"**/*.mts",
		"**/vite*",
		"**/scripts/**",
		"**/docs/**",
		"automation/**",
		"e2e-tests/**",
		// Kept in addition. These sit on disk in the maintainer's copy but are gitignored, so
		// neither CI nor the scanner sees them. Without these entries `eslint .` counts them locally
		// and nowhere else, and the ratchet baseline would mean two different numbers on two
		// machines. (`.scratch/` alone once contributed 3 parse errors that CI cannot see; agent
		// worktrees under `.claude/` would count the whole repo again.)
		"main.js",
		".scratch/**",
		".scratch-inspect/**",
		".claude/**",
		// No lintable source today; ignored so a fixture never turns into a lint finding.
		"test-fixtures/**",
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
		// The store scanner applies the five type-aware `no-unsafe-*` rules to plain `.js` files
		// too; the published `recommended` preset scopes them to `.ts` (scanner overlay documented
		// in obsidianmd/eslint-plugin PRs #158/#173, reproduced in
		// .scratch/store-scorecard-fixes/issues/01-scanner-lint-behavior.md). Mirroring it keeps
		// `eslint .` and the ratchet counting what the store counts -- and keeps the generated
		// parser's scoped eslint-disable pair from being flagged as an unused directive.
		files: ["**/*.js"],
		rules: {
			"@typescript-eslint/no-unsafe-member-access": "warn",
			"@typescript-eslint/no-unsafe-call": "warn",
			"@typescript-eslint/no-unsafe-assignment": "warn",
			"@typescript-eslint/no-unsafe-return": "warn",
			"@typescript-eslint/no-unsafe-argument": "warn",
		},
	},
	{
		rules: {
			// "reMarkable" and "Obsidian" are brand names; without this the sentence-case rule
			// lowercases them (8 hits).
			"obsidianmd/ui/sentence-case": ["warn", { brands: ["reMarkable", "Obsidian"] }],
		},
	},
);
