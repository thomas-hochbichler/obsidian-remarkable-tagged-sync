// Build shim: replaces the `lie` Promise polyfill that jszip pulls in.
//
// jszip only ever reaches for it as a fallback -- `lib/external.js` is literally
// `if (typeof Promise !== "undefined") { ES6Promise = Promise } else { ES6Promise = require("lie") }`
// -- so in any environment this plugin can run in, the polyfill is dead code. esbuild still bundles
// it, because the `require` sits inside a branch it cannot drop, and with it comes `immediate`,
// whose environment probe creates `<script>` elements that Obsidian's review rejects.
//
// Exporting the native Promise makes the dead branch resolve to what the live branch already uses.
// CommonJS on purpose: jszip `require()`s this, and an ESM default export would arrive wrapped.

module.exports = Promise;
