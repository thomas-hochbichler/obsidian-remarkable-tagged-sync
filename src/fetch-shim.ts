// Injected by esbuild (see esbuild.config.mjs): every free-identifier `fetch` reference in the
// bundle resolves to this export instead of the global. Plugin code imports `obsidianFetch` by name,
// so in practice this catches rmapi-js, which calls the global `fetch` with no injection point, and
// any library or future line that reaches for a free `fetch`. Rationale in obsidian-fetch.ts.
export { obsidianFetch as fetch } from "./obsidian-fetch";
