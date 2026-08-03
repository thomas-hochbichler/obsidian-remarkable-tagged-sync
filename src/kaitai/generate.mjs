// Regenerates rmv6-generated.js from rmv6.ksy.
//
// Run with: npm run generate:kaitai
//
// kaitai-struct-compiler is GPL-3.0-licensed, but it is a build-time devDependency
// only -- it is never bundled into the plugin, and its own license explicitly
// disclaims copyleft on compiler *output* (see kaitai/PROVENANCE.md).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import compiler from "kaitai-struct-compiler";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ksyPath = path.join(dir, "rmv6.ksy");
const outPath = path.join(dir, "rmv6-generated.js");

const ksy = parseYaml(fs.readFileSync(ksyPath, "utf8"));
const files = await compiler.compile("javascript", ksy, null, false);

const [name, rawContent] = Object.entries(files)[0];

// ---- post-processing ---------------------------------------------------------------------------
//
// The store scanner lints this file with its own config (repo config and ignores are not honored,
// and there is no exclusion for generated code), so the compiler's raw output has to be cleaned up
// here rather than ignored. See .scratch/store-scorecard-fixes/ for the full analysis. Each
// transform asserts it matched, so a compiler upgrade that changes the emitted shape fails loudly
// here instead of silently shipping findings again.

function applyTransform(content, description, apply) {
	const out = apply(content);
	if (out === content) throw new Error(`post-processing transform did nothing: ${description}`);
	return out;
}

let content = rawContent;

// 1. ESM instead of the UMD wrapper. The wrapper's `require()`/`define()` branches are what the
//    scanner's no-require-imports and no-undef flag; only the module body is wanted.
const umdOpen = /^[\s\S]*?\}\)\(typeof self !== 'undefined' \? self : this, function \(Rmv6_, KaitaiStream\) \{\n/;
const umdClose = /\nRmv6_\.Rmv6 = Rmv6;\n\}\);\n?$/;
content = applyTransform(content, "strip UMD wrapper (open)", (c) =>
	c.replace(umdOpen, `import KaitaiStream from "kaitai-struct/KaitaiStream";\n\n`),
);
content = applyTransform(content, "strip UMD wrapper (close)", (c) => c.replace(umdClose, "\nexport { Rmv6 };\n"));

// 2. The block-type switch declares `var _io__raw_body` once per case (8x in one scope);
//    hoist a single declaration above the switch.
content = applyTransform(content, "dedupe _io__raw_body declarations", (c) => {
	const declared = c.replace(/(\n(\s*)switch \(this\.blockType\) \{)/, "\n$2var _io__raw_body;$1");
	return declared.replace(/var (_io__raw_body = new KaitaiStream)/g, "$1");
});

// 3. repeat-eos loops count an `i` that nothing reads.
content = applyTransform(content, "drop unused loop counters", (c) =>
	c.replace(/^(\s*)var i = 0;\n(\1while \(!this\._io\.isEof\(\)\) \{\n(?:.*\n)*?)\1 {2}i\+\+;\n/gm, "$2"),
);

// 4. The parser's internals read from the untyped kaitai-struct runtime, so the type-aware
//    `no-unsafe-*` rules fire on every access. A scoped, described disable/enable pair is the
//    sanctioned suppression (these rules are not on the scanner's restricted-disable list); the
//    public surface is typed by the hand-written rmv6-generated.d.ts instead.
const unsafeRules = ["no-unsafe-member-access", "no-unsafe-call", "no-unsafe-assignment", "no-unsafe-return", "no-unsafe-argument"]
	.map((r) => `@typescript-eslint/${r}`)
	.join(", ");
const disableComment = `/* eslint-disable ${unsafeRules} -- generated parser (see PROVENANCE.md): internals read from the untyped kaitai-struct runtime; the public surface is typed by rmv6-generated.d.ts */\n`;
const enableComment = `/* eslint-enable ${unsafeRules} -- end of generated parser */\n`;
content = disableComment + content + enableComment;

// Sanity: nothing a transform was meant to remove may survive.
for (const forbidden of ["require(", "define(", "var i = 0;\n"]) {
	if (content.includes(forbidden)) throw new Error(`post-processed output still contains ${JSON.stringify(forbidden)}`);
}
const hoisted = content.match(/var _io__raw_body/g) ?? [];
if (hoisted.length !== 1) throw new Error(`expected exactly 1 hoisted _io__raw_body declaration, found ${hoisted.length}`);

const header = `// GENERATED FILE -- do not edit by hand.\n// Source: kaitai/rmv6.ksy, compiled with kaitai-struct-compiler, post-processed below.\n// Regenerate with: npm run generate:kaitai\n\n`;
fs.writeFileSync(outPath, header + content);
console.log(`wrote ${outPath} (from ${name})`);
