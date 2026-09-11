// Fetch exactly the members of Ollama's signed Windows x64 zip that a CUDA-less install needs, by
// HTTP range request, and verify every one of them before it touches the disk.
//
// Why not just download the zip: it is 1.47 GB, of which 1.43 GB is CUDA 12/13 -- `cublasLt64_12.dll`
// alone is 692 MB. What the plugin would actually run is 42,914,054 B compressed. The zip's central
// directory gives every member's offset, so a client can take those and leave the rest.
//
// This is measurement scaffolding for managed-llm-windows-x64 ticket 07. It is NOT the shipped
// download path and nothing in `src/` calls it.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
const target = process.argv[2];
if (!target) {
	console.error("usage: node fetch-runtime.mjs <target directory>");
	process.exit(64);
}

/**
 * GitHub redirects a release download to a **signed** object URL, and a range request that arrives
 * at the CDN after a second redirect is answered `501 Unsupported client range`. So the redirect is
 * resolved once, up front, and every range goes to the object itself.
 */
async function resolve(url) {
	const head = await fetch(url, { method: "HEAD", redirect: "follow" });
	if (!head.ok) throw new Error(`HEAD ${url}: ${head.status}`);
	const length = Number(head.headers.get("content-length"));
	if (length !== manifest.zipBytes) {
		throw new Error(`zip is ${length} B, manifest says ${manifest.zipBytes} -- the release moved`);
	}
	return head.url;
}

async function range(url, start, end) {
	const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
	// A 200 means the server ignored the range and is sending 1.47 GB. Refuse rather than read it.
	if (response.status !== 206) throw new Error(`range ${start}-${end}: HTTP ${response.status}, expected 206`);
	return Buffer.from(await response.arrayBuffer());
}

/** The local file header is variable-length, so its two length fields have to be read first. */
async function member(url, entry) {
	const header = await range(url, entry.localHeaderOffset, entry.localHeaderOffset + 29);
	if (header.readUInt32LE(0) !== 0x04034b50) throw new Error(`${entry.name}: not a local file header`);
	const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
	const raw = await range(url, start, start + entry.compressed - 1);
	const data = entry.method === 8 ? inflateRawSync(raw) : raw;
	if (data.length !== entry.uncompressed) throw new Error(`${entry.name}: ${data.length} B, expected ${entry.uncompressed}`);
	const sha256 = createHash("sha256").update(data).digest("hex");
	if (sha256 !== entry.sha256) throw new Error(`${entry.name}: sha256 ${sha256}, pinned ${entry.sha256}`);
	return data;
}

const url = await resolve(manifest.url);
let bytes = 0;
for (const entry of manifest.members) {
	const data = await member(url, entry);
	const file = join(target, ...entry.name.split("/"));
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, data);
	bytes += data.length;
	console.log(`ok  ${entry.name.padEnd(44)} ${String(entry.uncompressed).padStart(12)}  ${entry.sha256.slice(0, 16)}…`);
}
console.log(`\n${manifest.members.length} members verified, ${bytes.toLocaleString("en-US")} B written to ${target}`);
console.log("CUDA directories deliberately absent: cuda_v12, cuda_v13");
