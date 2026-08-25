import { describe, expect, it } from "vitest";
import { hashBytes, indexEntry, indexFileBytes, type Sync15Entry } from "./sync15-hash";

/**
 * A real document, as the device itself hashed it.
 *
 * These numbers were read out of `.tree` -- the hash tree xochitl maintains on the tablet while it
 * is cloud-connected -- for the public-domain Alice test book, and they are the whole point of this
 * file: the entry hash below was written by reMarkable's own code, so reproducing it is a check
 * against the format rather than against this module's opinion of the format.
 */
const ALICE = "b9ff40e1-1b3d-4479-b905-fb931ad618bc";
const ALICE_FILES: Sync15Entry[] = [
	{ hash: "9e8fe4eb3c3c3102935dfd88339573ad382af463326228f01756e2f0022a1660", id: `${ALICE}.content`, subfiles: 0, size: 57888 },
	{ hash: "6b79f2d23b804172816e81c463dbcea689593bbde63ef200d52b6c0da7ef629c", id: `${ALICE}.epub`, subfiles: 0, size: 189231 },
	{ hash: "b15d83b9f9b74d2a8366290e51ffc656a83aec3e5c0baeac07d58f85ce3ccb71", id: `${ALICE}.metadata`, subfiles: 0, size: 330 },
	{ hash: "a32c880e6a8796b00f4441f618e323792c770201da8e7cb9d1084f033f01308f", id: `${ALICE}.pagedata`, subfiles: 0, size: 686 },
	{ hash: "13b8bbbc54f9c6063fdd7748e37f69335d844b1da617b5c5fccc9c7c0a657107", id: `${ALICE}.pdf`, subfiles: 0, size: 1014216 },
	{ hash: "70155bcad9be7a8957376849d32af135c31458a308fb239aede9935cc28a658c", id: `${ALICE}/35272928-d0c0-4802-a958-ed0cf9477890.rm`, subfiles: 0, size: 449 },
	{ hash: "2e165d8cb3ea9fcc41eefa6c3ce6cd695329f77ec2f397bae8cc2c533a5302c1", id: `${ALICE}/47245b73-40a2-4e41-ab85-10942d2574b0.rm`, subfiles: 0, size: 4841 },
	{ hash: "e18dac0d59e411279ef203736226be2d4e07077ddf2f25deedc5e8d3b9934465", id: `${ALICE}/7d451d0e-1a12-46cb-a256-3dbdec021802.rm`, subfiles: 0, size: 4890 },
	{ hash: "9e16813d807bed8cf43c32344cead8aa643f847943424b3d44bc753ae3c44c7d", id: `${ALICE}/9d47c16a-56f6-4344-8e0b-5bcc8e34ec43.rm`, subfiles: 0, size: 1144 },
	{ hash: "ed61e040fca51932a8a358dc3931be5cead8f7642c0dea60f73a3526902678ea", id: `${ALICE}/e697235b-3520-43f2-9218-aa4e22d6110c.rm`, subfiles: 0, size: 6857 },
];
/** What the device's own hash tree records for that document. */
const ALICE_ENTRY_HASH = "5f2422bd81df03cb4d8a7f3f22f4244039895be26238cb33d96625d52292d7a6";

function text(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

describe("sync15 hashes", () => {
	it("hashes a file as the SHA-256 of exactly its bytes", async () => {
		// The published SHA-256 of "abc" -- an outside answer, not this module's own.
		expect(await hashBytes(new TextEncoder().encode("abc"))).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("hashes the window it was given, not the buffer behind it", async () => {
		const shared = new Uint8Array([0, 0, 97, 98, 99, 0]);
		const window = shared.subarray(2, 5);

		// Without the copy in hashBytes this reads the neighbours too, and every page hash on a
		// chunked read would be wrong in a way no size or count would show.
		expect(await hashBytes(window)).toBe(await hashBytes(new TextEncoder().encode("abc")));
	});

	it("reproduces the document hash the device itself recorded", async () => {
		const entry = await indexEntry(ALICE, ALICE_FILES);

		expect(entry.hash).toBe(ALICE_ENTRY_HASH);
		expect(entry.subfiles).toBe(10);
		expect(entry.size).toBe(1_280_532);
	});

	it("sorts the index by id, so the same files in any order hash the same", async () => {
		const shuffled = [...ALICE_FILES].reverse();

		expect((await indexEntry(ALICE, shuffled)).hash).toBe(ALICE_ENTRY_HASH);
	});

	it("writes the schema, the self-describing info line, and one line per file", () => {
		const lines = text(indexFileBytes("doc-1", [{ hash: "aa", id: "doc-1.content", subfiles: 0, size: 7 }])).split("\n");

		expect(lines[0]).toBe("4");
		expect(lines[1]).toBe("0:doc-1:1:7");
		expect(lines[2]).toBe("aa:0:doc-1.content:0:7");
	});

	it("calls the root index `.` rather than `root`, as the cloud does", () => {
		expect(text(indexFileBytes("root", [])).split("\n")[1]).toBe("0:.:0:0");
	});

	it("gives a different hash when a member file changed", async () => {
		const changed = ALICE_FILES.map((entry, index) => (index === 0 ? { ...entry, hash: `${"0".repeat(64)}` } : entry));

		expect((await indexEntry(ALICE, changed)).hash).not.toBe(ALICE_ENTRY_HASH);
	});
});
