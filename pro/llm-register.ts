import { Setting } from "obsidian";
import type { BackendSettings, BackendSettingsContext } from "../src/ocr-registry";
import { registerOcrBackend } from "../src/ocr-registry";
import type { OcrBackend as OcrBackendAdapter } from "../src/ocr-backend";
import { UnavailableOcrBackend } from "../src/vision-ocr-backend";
import { AnthropicOcrBackend } from "./anthropic-ocr-backend";
import { PROVIDERS, resolveProviderEndpoint, type LlmProviderConfig, type LlmProviderId, type ProviderMeta } from "./ocr-providers";
import { detectVisionCapability, type ModelCapabilities, type VisionVerdict } from "./ocr-vision-detect";
import { visionOnly } from "../src/localhost-vision-detect";
// In `src/` since the free build gained the localhost providers (free-localhost-ocr spec §2). Same
// class, same requests; only `metered` changed where it is derived from.
import { OpenAiCompatOcrBackend } from "../src/openai-compat-ocr-backend";

/**
 * Selects the adapter for one run (multi-provider spec §6). The asymmetry is deliberate: a missing
 * cloud key returns `null` so the plugin falls back to a free local backend rather than silently
 * rerouting to another metered API. Local providers (Ollama/LM Studio) and a configured `custom`
 * endpoint are never key-gated (free / BYO), so they build unconditionally.
 */
function createAdapter(meta: ProviderMeta, cfg: LlmProviderConfig): OcrBackendAdapter | null {
	const { baseURL, model, apiKey } = resolveProviderEndpoint(meta, cfg);

	if (meta.id === "anthropic") return apiKey ? new AnthropicOcrBackend({ apiKey, model }) : null;
	if (meta.kind === "cloud") {
		return apiKey ? new OpenAiCompatOcrBackend({ id: meta.id, baseURL, apiKey, model, extraHeaders: meta.extraHeaders, deterministic: meta.deterministic }) : null;
	}
	// `custom` needs a base URL before it can run. Unlike a missing key this is a misconfiguration,
	// not a reason to quietly transcribe somewhere else, so it reports unavailable rather than falling back.
	if (meta.id === "custom" && !baseURL) return new UnavailableOcrBackend("custom");
	return new OpenAiCompatOcrBackend({ id: meta.id, baseURL, apiKey, model, extraHeaders: meta.extraHeaders, deterministic: meta.deterministic });
}

/** The thinking line's tone, and `partial`'s: a warning, never an error -- see {@link thinkingSentence}. */
const WARNING_COLOR = "var(--text-warning)";
/**
 * Back to the theme's own colour. Written through a variable rather than as a literal, which is what
 * keeps the store's `no-static-styles-assignment` rule (an error, undisableable here) off this site --
 * the same reason `src/localhost-register.ts` has its own.
 */
const NO_COLOR = "";

/**
 * One line of the callout. Two facts want two lines and two colours (#116), and `setText` on the
 * callout itself can only carry one.
 */
function paintLine(el: HTMLElement, text: string, color: string): void {
	const line = el.createDiv();
	line.setText(text);
	line.style.color = color;
}

/**
 * Renders one probe's answer (spec §8) into the settings callout: what the model can see, tone scaled
 * to the provider's detection reach (spec §5.1), and whether it reasons before answering. It only
 * ever informs -- a mis-picked model still degrades to `failed` at run time, never blocked here.
 */
function renderCapabilities(el: HTMLElement, caps: ModelCapabilities, model: string, meta: ProviderMeta): void {
	el.empty();
	// Painted per line from here on, so the container's own colour must not linger from `Checking…`.
	el.style.color = NO_COLOR;

	const vision = visionSentence(caps.vision, model, meta.label);
	if (vision) paintLine(el, vision.text, vision.color);

	// Suppressed when nothing will transcribe anyway: `unsupported` means the model must be replaced,
	// and "it also reasons before answering" is advice about a model that is already going.
	if (caps.thinking === "on" && caps.vision !== "unsupported") paintLine(el, thinkingSentence(model, meta), WARNING_COLOR);
}

/**
 * The thinking line. `--text-warning`, the same tone as `partial`, and not `--text-error`: error is
 * reserved for "transcription will fail", and a reasoning model transcribes -- slowly, and sometimes
 * a page short.
 *
 * A cloud provider gets a third clause, because reasoning tokens are billed like any other and this
 * is where a user finds that out. It does not offer to switch thinking off: the plugin sends no
 * reasoning parameter, and on Anthropic's Fable and Mythos models thinking cannot be disabled at all
 * (`{"type":"disabled"}` is refused). The lever is the model, on every provider here.
 */
function thinkingSentence(model: string, meta: ProviderMeta): string {
	if (meta.kind === "cloud") {
		return (
			`⚠ "${model}" reasons before answering — expect much slower syncs, pages left out when an ` +
			`answer runs too long, and the reasoning tokens on your bill. A model that doesn't reason avoids all three.`
		);
	}
	return (
		`⚠ "${model}" reasons before answering — expect much slower syncs, and pages left out when an ` +
		`answer runs too long. A model that doesn't reason (often the "-instruct" build) avoids both.`
	);
}

/** The vision half, or `null` where there is nothing to say about it (`none`: no probe was made). */
function visionSentence(verdict: VisionVerdict, model: string, provider: string): { text: string; color: string } | null {
	switch (verdict) {
		case "none":
			return null;
		case "supported":
			return { text: `✓ "${model}" supports image input.`, color: "var(--text-success)" };
		case "unsupported":
			return {
				text: `⚠ ${provider} reports "${model}" has no image input — transcription will fail. Pick a vision model.`,
				color: "var(--text-error)",
			};
		case "partial":
			return { text: `Couldn't confirm "${model}" accepts images — make sure it's a vision model.`, color: WARNING_COLOR };
		case "unconfirmed-name":
			return {
				text: `"${model}" doesn't look like a vision model, and this provider can't be queried to confirm. If it can't see images, transcription will fail.`,
				color: WARNING_COLOR,
			};
		case "unreachable":
			return { text: `Couldn't reach ${provider} to check "${model}"'s image support.`, color: "var(--text-muted)" };
	}
}

/** The live vision-capability callout and its debounce timer, shared by whichever provider is shown. */
let visionWarningEl: HTMLElement | null = null;
let visionCheckTimer: number | null = null;

/**
 * Debounced, best-effort vision-capability check (spec §8) that updates the {@link visionWarningEl}
 * callout. Debounced so typing a model name or key doesn't fire a request per keystroke; the
 * el-identity guard drops a stale result if the settings pane re-rendered before it returned.
 */
function scheduleVisionCheck(meta: ProviderMeta, cfg: LlmProviderConfig): void {
	const el = visionWarningEl;
	if (!el) return;
	const { baseURL, model, apiKey } = resolveProviderEndpoint(meta, cfg);
	// Nothing to check, and nothing to warn about: no provider seeds a model id any more, so an empty
	// field is the state of a fresh install rather than a mistake. Probing it would render the
	// verdict about `""` -- a red "has no image input" on a field the user has not filled in yet.
	if (model.trim() === "") {
		el.setText("");
		return;
	}
	// `visionReach: "none"` means no vision *probe*, not no callout (#116): Anthropic's thinking half is
	// a lookup on the model id and needs no request, so it is the one provider with nothing to report
	// as pending. Every other one is about to make a request and says so.
	if (meta.visionReach !== "none") el.setText(`Checking whether "${model}" supports images…`);
	if (visionCheckTimer !== null) window.clearTimeout(visionCheckTimer);
	visionCheckTimer = window.setTimeout(() => {
		// `ProviderMeta.id` is the core's open backend id since the table split (free-localhost-ocr
		// §2.2); the seven keys of PROVIDERS are still the closed union, so this narrowing is safe.
		void detectVisionCapability({ provider: meta.id as LlmProviderId, model, baseURL, apiKey })
			// A probe that throws is precisely the "could not confirm" case, and `partial` already says
			// that. Without this branch the rejection escapes into the console and the row sits at
			// "Checking…" for good -- a wrong model would then look like a hung settings pane.
			.catch((): ModelCapabilities => visionOnly("partial"))
			.then((caps) => {
				if (visionWarningEl === el) renderCapabilities(el, caps, model, meta);
			});
	}, 500);
}

/** Reveals the selected provider's fields — endpoint, model, live vision warning, API key (multi-provider spec §5). */
function renderProviderSettings(meta: ProviderMeta, containerEl: HTMLElement, ctx: BackendSettingsContext): void {
	const cfg = ctx.settings as LlmProviderConfig;
	const save = () => ctx.save();

	// Endpoint (base URL): read-only for cloud presets, editable for local + custom (host/port varies).
	const urlSetting = new Setting(containerEl).setName("Endpoint (base URL)");
	if (meta.editableURL) {
		urlSetting.setDesc("The provider's OpenAI-compatible base URL.").addText((text) => {
			text.setPlaceholder(meta.baseURL || "https://…").setValue(cfg.baseURL ?? meta.baseURL);
			text.onChange(async (value) => {
				cfg.baseURL = value || undefined;
				await save();
				scheduleVisionCheck(meta, cfg);
			});
		});
	} else {
		urlSetting.setDesc(meta.baseURL);
	}

	new Setting(containerEl)
		.setName("Model")
		.setDesc("The vision model to transcribe with.")
		.addText((text) => {
			text.setPlaceholder(meta.defaultModel || "model id").setValue(cfg.model ?? meta.defaultModel);
			text.onChange(async (value) => {
				cfg.model = value || undefined;
				await save();
				scheduleVisionCheck(meta, cfg);
			});
		});

	// Vision-capability callout, rendered under the Model field (spec §5.1).
	visionWarningEl = containerEl.createDiv({ cls: "tagged-sync-note" });
	scheduleVisionCheck(meta, cfg);

	if (meta.key !== "none") {
		new Setting(containerEl)
			.setName(`API key${meta.key === "required" ? " (required)" : " (optional)"}`)
			.setDesc(meta.kind === "cloud" ? "Stored locally in this vault's plugin data." : "Only if your local server requires one.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(cfg.apiKey ?? "").onChange(async (value) => {
					cfg.apiKey = value || null;
					await save();
					scheduleVisionCheck(meta, cfg);
				});
			});
	}
}

// Registered in the dropdown order fixed by PROVIDERS (spec §2 / §5), after the free backends.
for (const meta of Object.values(PROVIDERS)) {
	registerOcrBackend({
		id: meta.id,
		label: meta.label,
		metered: meta.kind === "cloud",
		requiresLicence: meta.kind === "cloud",
		// Deliberately the same predicate as `metered`, so nothing about these six changes. That Ollama
		// and LM Studio run unconsented in the background is a pre-existing gap: naming it here is
		// correct, closing it would be a change to this build's behaviour that its own spec did not ask
		// for.
		needsBackgroundConsent: meta.kind === "cloud",
		create: (settings: BackendSettings) => createAdapter(meta, settings),
		renderSettings: (containerEl, ctx) => renderProviderSettings(meta, containerEl, ctx),
	});
}
