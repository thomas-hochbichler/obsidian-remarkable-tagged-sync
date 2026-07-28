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
import * as yaml from "js-yaml";
import compiler from "kaitai-struct-compiler";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ksyPath = path.join(dir, "rmv6.ksy");
const outPath = path.join(dir, "rmv6-generated.js");

const ksy = yaml.load(fs.readFileSync(ksyPath, "utf8"));
const files = await compiler.compile("javascript", ksy, null, false);

const [name, content] = Object.entries(files)[0];
const header = `// GENERATED FILE -- do not edit by hand.\n// Source: kaitai/rmv6.ksy, compiled with kaitai-struct-compiler.\n// Regenerate with: npm run generate:kaitai\n\n`;
fs.writeFileSync(outPath, header + content);
console.log(`wrote ${outPath} (from ${name})`);
