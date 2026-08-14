import { Setting } from "obsidian";
import type { BackendSettings, BackendSettingsContext } from "../src/ocr-registry";
import { registerOcrBackend } from "../src/ocr-registry";
import type { OcrBackend as OcrBackendAdapter } from "../src/ocr-backend";
import { UnavailableOcrBackend } from "../src/vision-ocr-backend";
import { AnthropicOcrBackend } from "./anthropic-ocr-backend";
import { PROVIDERS, resolveProviderEndpoint, type LlmProviderConfig, type LlmProviderId, type ProviderMeta } from "./ocr-providers";
import { detectVisionCapability, type VisionVerdict } from "./ocr-vision-detect";
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
		return apiKey ? new OpenAiCompatOcrBackend({ id: meta.id, baseURL, apiKey, model, extraHeaders: meta.extraHeaders }) : null;
	}
	// `custom` needs a base URL before it can run. Unlike a missing key this is a misconfiguration,
	// not a reason to quietly transcribe somewhere else, so it reports unavailable rather than falling back.
	if (meta.id === "custom" && !baseURL) return new UnavailableOcrBackend("custom");
	return new OpenAiCompatOcrBackend({ id: meta.id, baseURL, apiKey, model, extraHeaders: meta.extraHeaders });
}

/**
 * Renders a vision-capability verdict (spec §8) into the settings callout, tone scaled to the
 * provider's detection reach (spec §5.1). It only ever informs -- a mis-picked model still degrades
 * to `failed` at run time, never blocked here.
 */
function renderVisionVerdict(el: HTMLElement, verdict: VisionVerdict, model: string, provider: string): void {
	const set = (text: string, color: string) => {
		el.setText(text);
		el.style.color = color;
	};
	switch (verdict) {
		case "none":
			set("", "");
			return;
		case "supported":
			set(`✓ "${model}" supports image input.`, "var(--text-success)");
			return;
		case "unsupported":
			set(`⚠ ${provider} reports "${model}" has no image input — transcription will fail. Pick a vision model.`, "var(--text-error)");
			return;
		case "partial":
			set(`Couldn't confirm "${model}" accepts images — make sure it's a vision model.`, "var(--text-warning)");
			return;
		case "unconfirmed-name":
			set(
				`"${model}" doesn't look like a vision model, and this provider can't be queried to confirm. If it can't see images, transcription will fail.`,
				"var(--text-warning)",
			);
			return;
		case "unreachable":
			set(`Couldn't reach ${provider} to check "${model}"'s image support.`, "var(--text-muted)");
			return;
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
	if (meta.visionReach === "none") {
		el.setText("");
		return;
	}
	const { baseURL, model, apiKey } = resolveProviderEndpoint(meta, cfg);
	el.setText(`Checking whether "${model}" supports images…`);
	if (visionCheckTimer !== null) window.clearTimeout(visionCheckTimer);
	visionCheckTimer = window.setTimeout(() => {
		// `ProviderMeta.id` is the core's open backend id since the table split (free-localhost-ocr
		// §2.2); the seven keys of PROVIDERS are still the closed union, so this narrowing is safe.
		void detectVisionCapability({ provider: meta.id as LlmProviderId, model, baseURL, apiKey })
			// A probe that throws is precisely the "could not confirm" case, and `partial` already says
			// that. Without this branch the rejection escapes into the console and the row sits at
			// "Checking…" for good -- a wrong model would then look like a hung settings pane.
			.catch((): VisionVerdict => "partial")
			.then((verdict) => {
				if (visionWarningEl === el) renderVisionVerdict(el, verdict, model, meta.label);
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
		// Deliberately the same predicate as `metered`, so nothing about these six changes. That Ollama
		// and LM Studio run unconsented in the background is a pre-existing gap: naming it here is
		// correct, closing it would be a change to this build's behaviour that its own spec did not ask
		// for.
		needsBackgroundConsent: meta.kind === "cloud",
		create: (settings: BackendSettings) => createAdapter(meta, settings),
		renderSettings: (containerEl, ctx) => renderProviderSettings(meta, containerEl, ctx),
	});
}
