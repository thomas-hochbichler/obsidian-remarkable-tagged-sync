/**
 * `connectToDevice`, against an SSH server that answers the way the tablet does.
 *
 * The rest of the transport is tested over a `DeviceFiles` made of a plain map, which is what keeps
 * membership, hashing and caching testable without a tablet in the room. That leaves this file --
 * the host key, the two shell commands, the SFTP read, the exit code -- with nothing over it, and a
 * measured five deliberate breakages of it passed the whole suite: the host key check turned off,
 * the stat format swapped, the xochitl prefix dropped from every read, a failed command read as an
 * empty answer, and the timeout wording taken out of the failover gate.
 *
 * So the seam moves down to the wire. `ssh2` ships a server, the plugin's own client talks to it,
 * and everything between the two -- the handshake, the fingerprint, the channels, the SFTP protocol
 * -- is the real thing.
 *
 * **What this fake may and may not claim.** It answers commands; it does not interpret them. There
 * is no shell here, so a test says what the device would have printed and asserts on the command
 * that asked for it. A fake that ran `find` and `sha256sum` for real would be asserting what
 * BusyBox does, which is exactly the claim it cannot support -- the two commands in this module are
 * shaped the way they are because a real tablet rejected the obvious versions, and that measurement
 * lives in `s-ssh-transport.yaml` where it was made.
 */

import { createHash } from "node:crypto";
import { Platform } from "obsidian";
import { Server, utils } from "ssh2";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	asConnectionError,
	connectToDevice,
	DeviceUnreachableError,
	HostKeyMismatchError,
	type DeviceConnection,
	type SshCredentials,
	XOCHITL_DIR,
} from "./ssh-connection";

const { STATUS_CODE } = utils.sftp;

/** One key for the whole file: generating an EC key per test is the slowest thing here by far. */
const HOST_KEY = utils.generateKeyPairSync("ecdsa", { bits: 256 });

/** What `ssh` itself would print for that key, worked out a different way than the module does. */
const HOST_FINGERPRINT = (() => {
	const parsed = utils.parseKey(HOST_KEY.private);
	if (parsed instanceof Error) throw parsed;
	const digest = createHash("sha256").update(parsed.getPublicSSH()).digest("base64");
	return `SHA256:${digest.replace(/=+$/, "")}`;
})();

/** What the device wrote for one command: its output, anything on stderr, and how it exited. */
interface ExecReply {
	out?: string;
	err?: string;
	code?: number;
}

interface Tablet {
	readonly port: number;
	/** Every command the plugin ran, with whatever it sent on standard input. */
	readonly commands: { command: string; stdin: string }[];
	/** Every path the plugin opened over SFTP, exactly as it asked for it. */
	readonly opened: string[];
	/** Resolves when the plugin's connection goes away, so a test can insist that it did. */
	readonly disconnected: Promise<void>;
	stop(): void;
}

function startTablet(
	options: {
		reply?: (command: string, stdin: string) => ExecReply;
		files?: Record<string, Buffer>;
		refuseSftp?: boolean;
	} = {},
): Promise<Tablet> {
	const commands: { command: string; stdin: string }[] = [];
	const opened: string[] = [];
	let sawDisconnect = () => {};
	const disconnected = new Promise<void>((resolve) => (sawDisconnect = resolve));

	const server = new Server({ hostKeys: [HOST_KEY.private] }, (connection) => {
		connection.on("error", () => {});
		connection.on("close", () => sawDisconnect());
		// Authentication is not what this file is about: the key install is `ssh-pairing`'s, and a
		// tablet that refuses a key is already a row of its own over in `ssh-transport.test.ts`.
		connection.on("authentication", (context) => context.accept());
		connection.on("ready", () => {
			connection.on("session", (acceptSession) => {
				const session = acceptSession();

				session.on("exec", (accept, _reject, info) => {
					const stream = accept();
					let stdin = "";
					stream.on("data", (chunk: Buffer) => (stdin += chunk.toString("utf8")));

					const answer = (): void => {
						commands.push({ command: info.command, stdin });
						const reply = options.reply?.(info.command, stdin) ?? {};
						if (reply.err !== undefined) stream.stderr.write(reply.err);
						if (reply.out !== undefined) stream.write(reply.out);
						stream.exit(reply.code ?? 0);
						stream.end();
					};

					// A shell waits for the end of standard input only when the command reads it. The
					// listing does not, and never closes its input, so waiting here would hang it.
					if (info.command.includes("read -r")) stream.on("end", answer);
					else answer();
				});

				session.on("sftp", (accept, reject) => {
					if (options.refuseSftp === true) {
						reject();
						return;
					}
					const sftp = accept();
					const open = new Map<number, Buffer>();
					let next = 0;

					const contentOf = (handle: Buffer): Buffer | undefined => open.get(handle.readUInt32BE(0));

					sftp.on("OPEN", (reqid, filename) => {
						opened.push(filename);
						const content = options.files?.[filename];
						if (content === undefined) {
							sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
							return;
						}
						const handle = Buffer.alloc(4);
						handle.writeUInt32BE(next, 0);
						open.set(next, content);
						next += 1;
						sftp.handle(reqid, handle);
					});

					sftp.on("FSTAT", (reqid, handle) => {
						const content = contentOf(handle);
						if (content === undefined) {
							sftp.status(reqid, STATUS_CODE.FAILURE);
							return;
						}
						sftp.attrs(reqid, { size: content.length, uid: 0, gid: 0, mode: 0o100644, atime: 0, mtime: 0 });
					});

					sftp.on("READ", (reqid, handle, offset, length) => {
						const content = contentOf(handle);
						if (content === undefined) {
							sftp.status(reqid, STATUS_CODE.FAILURE);
							return;
						}
						if (offset >= content.length) {
							sftp.status(reqid, STATUS_CODE.EOF);
							return;
						}
						sftp.data(reqid, content.subarray(offset, offset + length));
					});

					sftp.on("CLOSE", (reqid, handle) => {
						open.delete(handle.readUInt32BE(0));
						sftp.status(reqid, STATUS_CODE.OK);
					});
				});
			});
		});
	});

	return new Promise<Tablet>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve({
				port: typeof address === "object" && address !== null ? address.port : 0,
				commands,
				opened,
				disconnected,
				stop: () => server.close(),
			});
		});
	});
}

function credentialsFor(port: number, pinned: string | null = null): SshCredentials {
	return { host: "127.0.0.1", port, privateKey: null, password: "root-password", hostKeyFingerprint: pinned };
}

let tablet: Tablet | null = null;
let device: DeviceConnection | null = null;

beforeEach(() => {
	Platform.isDesktop = true;
});

afterEach(async () => {
	await device?.close();
	device = null;
	tablet?.stop();
	tablet = null;
	Platform.isDesktop = false;
});

describe("the host key of the tablet that answered", () => {
	it("is pinned in the spelling ssh itself uses, so pairing can show a comparable fingerprint", async () => {
		tablet = await startTablet();

		device = await connectToDevice(credentialsFor(tablet.port));

		// Worked out from the server's own public key rather than from this module's answer: the point
		// of showing it during pairing is that a user can compare it with what `ssh` told them.
		expect(device.hostKeyFingerprint).toBe(HOST_FINGERPRINT);
	});

	it("is checked against the pinned one, and a different one is refused rather than re-learned", async () => {
		tablet = await startTablet();

		const refused = connectToDevice(credentialsFor(tablet.port, "SHA256:somethingelse"));

		// Trust on first use is only worth anything if the second use checks. The two things that
		// cause a mismatch are a factory reset and somebody else answering on that address.
		await expect(refused).rejects.toBeInstanceOf(HostKeyMismatchError);
	});

	it("is named in the refusal, because the fingerprint is the only thing that identifies who did answer", async () => {
		tablet = await startTablet();

		const error = await connectToDevice(credentialsFor(tablet.port, "SHA256:somethingelse")).catch(
			(caught: unknown) => caught,
		);

		expect((error as HostKeyMismatchError).fingerprint).toBe(HOST_FINGERPRINT);
	});

	it("never sends the failover a mismatch, which is the one refusal the other source cannot explain", async () => {
		tablet = await startTablet();

		const error = await connectToDevice(credentialsFor(tablet.port, "SHA256:somethingelse")).catch(
			(caught: unknown) => caught,
		);

		// Quietly syncing from the cloud instead would bury the one message worth reading.
		expect(error).not.toBeInstanceOf(DeviceUnreachableError);
	});
});

describe("which failures read as nobody answered", () => {
	const credentials = credentialsFor(22);

	it("takes every way a tablet can be absent, however the network worded it", () => {
		for (const message of [
			"Timed out while waiting for handshake",
			"connect ETIMEDOUT 192.168.1.9:22",
			"connect ECONNREFUSED 192.168.1.9:22",
			"connect EHOSTUNREACH 192.168.1.9:22",
			"connect ENETUNREACH 192.168.1.9:22",
			"read ECONNRESET",
			"getaddrinfo ENOTFOUND remarkable.local",
		]) {
			// A tablet that is asleep hands back a handshake timeout and nothing else. Losing that one
			// wording leaves the failover in place and never firing, which reads exactly like working.
			expect(asConnectionError(new Error(message), credentials)).toBeInstanceOf(DeviceUnreachableError);
		}
	});

	it("leaves a refused key alone, because the other source cannot fix a key", () => {
		const refused = new Error("All configured authentication methods failed");

		// Failing over here would sync from the cloud forever and never say that the pairing is dead.
		expect(asConnectionError(refused, credentials)).not.toBeInstanceOf(DeviceUnreachableError);
		expect(asConnectionError(refused, credentials)).toBe(refused);
	});

	it("names the address that was tried, which is the only one the user can act on", async () => {
		const error = await connectToDevice(credentialsFor(1)).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(DeviceUnreachableError);
		expect((error as DeviceUnreachableError).hosts).toEqual(["127.0.0.1"]);
	});
});

describe("listing what is on the tablet", () => {
	it("asks for size, time and name in one walk of the xochitl directory", async () => {
		tablet = await startTablet({ reply: () => ({ out: "" }) });

		device = await connectToDevice(credentialsFor(tablet.port));
		await device.list();

		const [{ command }] = tablet.commands;
		expect(command).toContain(`cd ${XOCHITL_DIR}`);
		// The order of `%s %Y %n` is the whole contract with `parseStatLine`: swapped, every file gets
		// a size of a unix timestamp and a time of a few kilobytes, and the hash cache silently rots.
		expect(command).toContain("find . -type f -exec stat -c '%s %Y %n' {} +");
	});

	it("reads back what the shell wrote, with the seconds it counts in turned into milliseconds", async () => {
		const listing = "4096 1755000000 ./abcd/0.rm\n12 1755000060 ./abcd.metadata\n";
		tablet = await startTablet({ reply: () => ({ out: listing }) });

		device = await connectToDevice(credentialsFor(tablet.port));

		expect(await device.list()).toEqual([
			{ path: "abcd/0.rm", size: 4096, mtimeMs: 1_755_000_000_000 },
			{ path: "abcd.metadata", size: 12, mtimeMs: 1_755_000_060_000 },
		]);
	});
});

describe("reading a file off the tablet", () => {
	const PAGE = Buffer.from([0x72, 0x65, 0x4d, 0x00, 0xff, 0x01, 0x80]);

	it("asks for it under the xochitl directory, because the caller only ever holds a relative path", async () => {
		tablet = await startTablet({ files: { [`${XOCHITL_DIR}/abcd/0.rm`]: PAGE } });

		device = await connectToDevice(credentialsFor(tablet.port));
		await device.read("abcd/0.rm");

		expect(tablet.opened).toEqual([`${XOCHITL_DIR}/abcd/0.rm`]);
	});

	it("hands the bytes on exactly as they are, which for a page means not text", async () => {
		tablet = await startTablet({ files: { [`${XOCHITL_DIR}/abcd/0.rm`]: PAGE } });

		device = await connectToDevice(credentialsFor(tablet.port));

		expect(await device.read("abcd/0.rm")).toEqual(new Uint8Array(PAGE));
	});

	it("fails rather than reporting an empty file when the page is not there", async () => {
		tablet = await startTablet({ files: {} });

		device = await connectToDevice(credentialsFor(tablet.port));

		// An empty answer would be rendered as a blank page and stored under the hash of a real one.
		await expect(device.read("abcd/0.rm")).rejects.toThrow();
	});
});

describe("running a command on the tablet", () => {
	it("hands back what the device printed", async () => {
		tablet = await startTablet({ reply: () => ({ out: "1.2.3.4\n" }) });

		device = await connectToDevice(credentialsFor(tablet.port));

		expect(await device.exec("ip addr")).toBe("1.2.3.4\n");
	});

	it("fails when the device refused, and says what the device said about it", async () => {
		tablet = await startTablet({ reply: () => ({ err: "chmod: Read-only file system\n", code: 1 }) });

		device = await connectToDevice(credentialsFor(tablet.port));

		// Pairing installs a key with this and then checks it works. Reading a non-zero exit as an
		// empty answer would report a pairing that succeeded and a device that refuses every sync.
		await expect(device.exec("chmod 600 /home/root/.ssh/authorized_keys")).rejects.toThrow(
			"Read-only file system",
		);
	});
});

describe("hashing a library", () => {
	const paths = Array.from({ length: 600 }, (_, index) => `doc-${index}/0.rm`);
	const hashOf = (path: string): string => createHash("sha256").update(path).digest("hex");
	const answer = (_command: string, stdin: string): ExecReply => ({
		out: stdin
			.split("\n")
			.filter((line) => line !== "")
			.map((path) => `${hashOf(path)}  ${path}\n`)
			.join(""),
	});

	it("takes the paths on standard input and puts every batch's answer into one map", async () => {
		tablet = await startTablet({ reply: answer });

		device = await connectToDevice(credentialsFor(tablet.port));
		const hashes = await device.hash(paths);

		expect(hashes.size).toBe(600);
		expect(hashes.get("doc-0/0.rm")).toBe(hashOf("doc-0/0.rm"));
		// The last batch is the short one, and dropping it is the failure that looks like a full run.
		expect(hashes.get("doc-599/0.rm")).toBe(hashOf("doc-599/0.rm"));
	});

	it("breaks a first run into batches, so a library of thousands says something before it is done", async () => {
		tablet = await startTablet({ reply: answer });

		device = await connectToDevice(credentialsFor(tablet.port));
		const seen: number[] = [];
		await device.hash(paths, (done) => seen.push(done));

		expect(tablet.commands).toHaveLength(3);
		// One report before each batch and one when the last one lands, so the bar reaches its end.
		expect(seen).toEqual([0, 250, 500, 600]);
	});
});

describe("a connection that cannot be finished", () => {
	it("is closed rather than left authenticated with nobody holding it", async () => {
		tablet = await startTablet({ refuseSftp: true });

		// Past this point the caller has nothing to `close()`, because it never received a connection.
		await expect(connectToDevice(credentialsFor(tablet.port))).rejects.toThrow();

		await expect(tablet.disconnected).resolves.toBeUndefined();
	});
});

describe("where this may run at all", () => {
	it("refuses anywhere the node modules it needs are not there", async () => {
		Platform.isDesktop = false;

		// The plugin is desktop-only, and `ssh2` plus `crypto` are the reason this one says so twice.
		await expect(connectToDevice(credentialsFor(22))).rejects.toThrow("desktop-only");
	});
});
