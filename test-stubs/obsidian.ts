// The `obsidian` module, as vitest sees it. Aliased in vitest.config.ts.
//
// This file is only the surface: it re-exports, under Obsidian's own names, exactly what a non-test
// file in `src/` or `pro/` imports. The behaviour, the rules it models and the reasoning are in
// `fake-obsidian.ts` beside it -- and tests import THAT, relatively, never this. The split is not
// tidiness: `tsc` typechecks a test's `import ... from "obsidian"` against the real `obsidian.d.ts`,
// so a test reaching for `FakeVault` through this path would fail the typecheck while passing the
// run. Going through the file directly keeps both honest.
//
// Adding a name here means a non-test file now imports it. Anything absent stays absent.

export {
	apiVersion,
	debounce,
	MarkdownRenderChild,
	Modal,
	normalizePath,
	Notice,
	parseLinktext,
	Platform,
	Plugin,
	PluginSettingTab,
	ProgressBarComponent,
	requestUrl,
	Setting,
	setIcon,
	setTooltip,
	TAbstractFile,
	TFile,
	TFolder,
	FakeApp as App,
	FakeVault as Vault,
} from "./fake-obsidian";
