// Injected by esbuild (see esbuild.config.mjs): every free-identifier `fetch` reference in the
// bundle -- in practice rmapi-js's calls and the OCR backends' `fetchFn ?? fetch` defaults --
// resolves to this export instead of the global. Rationale in obsidian-fetch.ts.
export { obsidianFetch as fetch } from "./obsidian-fetch";
