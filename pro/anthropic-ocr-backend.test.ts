import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnthropicOcrBackend } from "./anthropic-ocr-backend";
import type { RmPage } from "../src/rm-parser";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
	return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function page(): RmPage {
	return {
		formatVersion: 6,
		layers: [
			{
				id: "layer-1",
				name: null,
				strokes: [
					{
						layerId: "layer-1",
						id: "stroke-1",
						timestamp: "0001",
						penType: 0,
						color: 0,
						brushSize: 2,
						points: [
							{ x: 10, y: 10, speed: 0, width: 0, direction: 0, pressure: 0 },
							{ x: 20, y: 20, speed: 0, width: 0, direction: 0, pressure: 0 },
						],
					},
				],
			},
		],
	};
}

function requestBody(): { model: string; max_tokens: number; messages: { content: { type: string; source?: { media_type: string; data: string } }[] }[] } {
	return JSON.parse(fetchMock.mock.calls[0][1].body);
}

describe("AnthropicOcrBackend", () => {
	beforeEach(() => {
		fetchMock.mockReset();
	});

	it("skips OCR for an empty page list without making a request", async () => {
		const backend = new AnthropicOcrBackend({ apiKey: "key", model: "claude-sonnet-5", fetchFn: fetchMock });

		const result = await backend.recognize([]);

		expect(result).toEqual({ status: "skipped", pages: [], text: "", confidence: null });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("recognizes a single page in one HTTP call and reports ok status", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { content: [{ type: "text", text: "Hello world" }] }));
		const backend = new AnthropicOcrBackend({ apiKey: "sk-test", model: "claude-sonnet-5", fetchFn: fetchMock });

		const result = await backend.recognize([page()]);

		expect(result).toEqual({ status: "ok", pages: [{ status: "ok", text: "Hello world" }], text: "Hello world", confidence: null });
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		expect(init.method).toBe("POST");
		expect(init.headers["x-api-key"]).toBe("sk-test");

		const body = requestBody();
		expect(body.model).toBe("claude-sonnet-5");
		const content = body.messages[0].content;
		expect(content[0].type).toBe("text");
		expect(content[1].type).toBe("image");
		expect(content[1].source!.media_type).toBe("image/png");
		const pngBytes = Buffer.from(content[1].source!.data, "base64");
		expect([...pngBytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	});

	// One image per call is the only shape where the page boundary comes from the request array --
	// something we control -- rather than from the model agreeing to mark it.
	it("sends one page per HTTP call, one image block each", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { content: [{ type: "text", text: "text" }] }));
		const backend = new AnthropicOcrBackend({ apiKey: "key", model: "claude-sonnet-5", fetchFn: fetchMock });

		const result = await backend.recognize([page(), page(), page()]);

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(result.pages).toHaveLength(3);
		for (const call of fetchMock.mock.calls) {
			const content = JSON.parse(call[1].body).messages[0].content;
			expect(content.length).toBe(2); // 1 prompt + 1 image
			expect(content[1].type).toBe("image");
		}
	});

	it("joins one response's text blocks with a blank line", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(200, {
				content: [
					{ type: "text", text: "page one" },
					{ type: "text", text: "page two" },
				],
			}),
		);
		const backend = new AnthropicOcrBackend({ apiKey: "key", model: "claude-sonnet-5", fetchFn: fetchMock });

		const result = await backend.recognize([page()]);

		expect(result.status).toBe("ok");
		expect(result.text).toBe("page one\n\npage two");
	});

	it("reports failed when the API responds with a non-ok status", async () => {
		fetchMock.mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
		const backend = new AnthropicOcrBackend({ apiKey: "bad-key", model: "claude-sonnet-5", fetchFn: fetchMock });

		const result = await backend.recognize([page()]);

		expect(result).toEqual({ status: "failed", pages: [{ status: "failed", text: "" }], text: "", confidence: null });
	});

	it("reports failed and never throws when the request itself fails", async () => {
		fetchMock.mockRejectedValue(new Error("network down"));
		const backend = new AnthropicOcrBackend({ apiKey: "key", model: "claude-sonnet-5", fetchFn: fetchMock });

		const result = await backend.recognize([page()]);

		expect(result).toEqual({ status: "failed", pages: [{ status: "failed", text: "" }], text: "", confidence: null });
	});

	// The prompt tells the model to output nothing for a page with no legible text, so an empty
	// response is that page reporting itself blank -- not a failure. It used to be reported as one.
	it("reports a page with no usable text as skipped, not failed", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { content: [{ type: "text", text: "   " }] }));
		const backend = new AnthropicOcrBackend({ apiKey: "key", model: "claude-sonnet-5", fetchFn: fetchMock });

		const result = await backend.recognize([page()]);

		expect(result).toEqual({ status: "skipped", pages: [{ status: "skipped", text: "" }], text: "", confidence: null });
	});

	// A truncated page used to come back `ok` over a transcript that stopped mid-sentence, and the
	// sync would never revisit it: the device hash is unchanged, so the loss was permanent.
	it("reports a truncated response as failed", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { content: [{ type: "text", text: "half a page" }], stop_reason: "max_tokens" }));
		const backend = new AnthropicOcrBackend({ apiKey: "key", model: "claude-sonnet-5", fetchFn: fetchMock });

		expect((await backend.recognize([page()])).pages).toEqual([{ status: "failed", text: "" }]);
	});

	it("retries a rate-limited page, honouring Retry-After, and gives up after three attempts", async () => {
		const slept: number[] = [];
		const rateLimited = { ...jsonResponse(429, {}), headers: { get: (name: string) => (name === "retry-after" ? "2" : null) } } as unknown as Response;
		fetchMock.mockResolvedValueOnce(rateLimited).mockResolvedValue(jsonResponse(200, { content: [{ type: "text", text: "second try" }] }));
		const backend = new AnthropicOcrBackend({ apiKey: "key", model: "claude-sonnet-5", fetchFn: fetchMock, sleepFn: async (ms) => void slept.push(ms) });

		expect((await backend.recognize([page()])).text).toBe("second try");
		expect(slept).toEqual([2000]);

		fetchMock.mockReset();
		fetchMock.mockResolvedValue(rateLimited);
		const stubborn = new AnthropicOcrBackend({ apiKey: "key", model: "claude-sonnet-5", fetchFn: fetchMock, sleepFn: async () => {} });

		expect((await stubborn.recognize([page()])).pages).toEqual([{ status: "failed", text: "" }]);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("identifies as the anthropic backend", () => {
		expect(new AnthropicOcrBackend({ apiKey: "key" }).id).toBe("anthropic");
	});

	it("sends the supplied model", async () => {
		fetchMock.mockResolvedValue(jsonResponse(200, { content: [{ type: "text", text: "x" }] }));

		await new AnthropicOcrBackend({ apiKey: "key", model: "claude-opus-4-8", fetchFn: fetchMock }).recognize([page()]);
		expect(requestBody().model).toBe("claude-opus-4-8");
	});

	// No model id is seeded anywhere any more, so "unset" is a state a real user reaches. Anthropic
	// answers an empty `model` with a bare 400, which would reach the note as "Could not read this
	// page" and name nothing to fix -- so nothing is sent and the warning says what to do instead.
	it("refuses to transcribe when no model is set, and says so instead of asking Anthropic", async () => {
		const result = await new AnthropicOcrBackend({ apiKey: "key", fetchFn: fetchMock }).recognize([page(), page()]);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.status).toBe("failed");
		expect(result.warnings?.[0]).toBe("No model is set for this OCR backend — open the plugin settings and enter one. 2 pages were not transcribed.");
	});

	it("treats a whitespace-only model as unset", async () => {
		await new AnthropicOcrBackend({ apiKey: "key", model: "   ", fetchFn: fetchMock }).recognize([page()]);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("metered", () => {
	it("always bills, so a background sync needs explicit consent", () => {
		expect(new AnthropicOcrBackend({ apiKey: "key", fetchFn: fetchMock }).metered).toBe(true);
	});
});
