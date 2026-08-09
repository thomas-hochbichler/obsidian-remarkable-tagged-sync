// The free build's OpenAI-compatible localhost backends (free-localhost-ocr spec §3).
//
// Three entries -- Ollama, LM Studio, and any other OpenAI-compatible server -- talking to an address
// the user supplies. Nothing is downloaded, so there is no consent to collect up front and no setup
// card: the user either has a server or they do not.
//
// This is the first backend that registers on **every** platform. Windows x64, Linux and Intel Macs
// have had a dropdown with nothing selectable in it since the plugin shipped; a managed local runtime
// cannot reach them (managed-local-llm-ocr research 14: no Defender-clean binary exists), and this
// is what does.

import { Setting } from "obsidian";
import {
	LOCALHOST_PROVIDERS,
	type LlmProviderConfig,
	type LocalhostProviderId,
	type ProviderMeta,
	resolveProviderEndpoint,
} from "./localhost-providers";
import { detectLocalhostVisionCapability, type VisionVerdict } from "./localhost-vision-detect";
import type { OcrBackend as OcrBackendAdapter } from "./ocr-backend";
import { type BackendSettings, type BackendSettingsContext, registerOcrBackend } from "./ocr-registry";
import { OpenAiCompatOcrBackend } from "./openai-compat-ocr-backend";
import { UnavailableOcrBackend } from "./vision-ocr-backend";

/**
 * What the transcript looks like, in one sentence under the dropdown.
 *
 * No ceiling is promised because there is none to promise: the output is whatever model the user
 * loaded. Apple Vision's flat-text limit is a property of Vision; this backend's is a property of a
 * choice we did not make.
 */
const NOTE_CONTRACT = "Structure depends on the model you load — a capable vision model returns headings and lists, a weak one flat text.";

/**
 * The model recommendation, and the exact extent of what stands behind it (spec §4.3).
 *
 * The 7.6 % is ours and real: Qwen2.5-VL-7B-Instruct Q4_K_M, our raster, our prompt, our `llama.cpp`
 * invocation, against ten hand-corrected pages. What it is **not** is a measurement of that model
 * served by Ollama or LM Studio -- different quantisation, sampling and image preprocessing -- and
 * measuring those was ruled out of scope. So the caveat is permanent, not a placeholder, and the
 * model field ships empty rather than seeding a number we cannot stand behind.
 */
const MODEL_RECOMMENDATION =
	"We measured Qwen2.5-VL-7B at 7.6 % character error running it directly — about three times more " +
	"accurate than Apple Vision on the same pages. Through a local server the result may differ; we have not measured that.";

/**
 * Background-sync consent (spec §3.2), which Pro's own Ollama and LM Studio entries do **not** ask
 * for.
 *
 * Not an inconsistency. `pro/llm-register.ts` derives the flag from `kind === "cloud"` and says why
 * it was left alone: flipping it would silently stop background transcription for users who already
 * configured those providers. This registration has no such users, and the substance points the
 * other way -- a 7B on your own machine costs battery, fans and several GB of RAM for minutes at a
 * time, which is exactly what `src/local-register.ts` sets the same flag for.
 */
const BACKGROUND_CONSENT_DESC =
	"Transcribe in the background with your local server. It runs a model on this machine — expect fans and several GB of memory while a sync runs.";

/** This backend's slice of the opaque settings blob: the provider config plus its own consent flag. */
type LocalhostSettings = LlmProviderConfig & { backgroundConsent?: boolean };

function createAdapter(meta: ProviderMeta, cfg: LlmProviderConfig): OcrBackendAdapter {
	const { baseURL, model, apiKey } = resolveProviderEndpoint(meta, cfg);

	// `custom` needs a base URL before it can run. Unlike a missing cloud key this is a
	// misconfiguration, not a reason to quietly transcribe somewhere else, so it reports unavailable.
	// Never `null`: that means "fall back to a free local backend", which is a metered-provider
	// concept and nothing here is metered.
	if (meta.id === "custom" && !baseURL) return new UnavailableOcrBackend("custom");

	return new OpenAiCompatOcrBackend({ id: meta.id, baseURL, apiKey, model });
}

/**
 * Renders a verdict into the settings callout. Same tone scale as Pro's, with one string rewritten:
 * `unreachable` on a server the user runs is not a network mystery, it is almost always "the app is
 * not running" -- the most likely failure this backend has, and the one they can fix in seconds
 * (spec §5.1).
 */
function renderVisionVerdict(el: HTMLElement, verdict: VisionVerdict, model: string, meta: ProviderMeta, baseURL: string): void {
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
			set(`⚠ ${meta.label} reports "${model}" has no image input — transcription will fail. Pick a vision model.`, "var(--text-error)");
			return;
		case "partial":
			set(`Couldn't confirm "${model}" accepts images — make sure it's a vision model.`, "var(--text-warning)");
			return;
		case "unconfirmed-name":
			set(`"${model}" doesn't look like a vision model. If it can't see images, transcription will fail.`, "var(--text-warning)");
			return;
		case "unreachable":
			set(unreachableMessage(meta, baseURL), "var(--text-warning)");
			return;
	}
}

/**
 * The one sentence a user with a closed app needs. Names the app where we know it and the address
 * always, and stops there -- installing someone else's software is not this plugin's to explain.
 */
export function unreachableMessage(meta: ProviderMeta, baseURL: string): string {
	if (meta.id === "ollama") return `Nothing answered at ${baseURL}. Start Ollama and pull a vision model, then this will re-check.`;
	if (meta.id === "lmstudio") return `Nothing answered at ${baseURL}. Start LM Studio, load a vision model and start its server, then this will re-check.`;
	return `Nothing answered at ${baseURL}. Check the server is running and the address is right.`;
}

/** The live callout and its debounce timer, shared by whichever provider is shown. */
let visionWarningEl: HTMLElement | null = null;
let visionCheckTimer: number | null = null;

/**
 * Debounced, best-effort check that updates {@link visionWarningEl}. Debounced so typing a model name
 * doesn't fire a request per keystroke; the el-identity guard drops a stale result if the settings
 * pane re-rendered before it returned.
 */
function scheduleVisionCheck(meta: ProviderMeta, cfg: LlmProviderConfig): void {
	const el = visionWarningEl;
	if (!el) return;
	const { baseURL, model, apiKey } = resolveProviderEndpoint(meta, cfg);
	if (!baseURL) {
		el.setText("");
		return;
	}
	el.setText(`Checking "${model || "the model"}"…`);
	if (visionCheckTimer !== null) window.clearTimeout(visionCheckTimer);
	visionCheckTimer = window.setTimeout(() => {
		void (async () => {
			const verdict = await detectLocalhostVisionCapability({ provider: meta.id as LocalhostProviderId, model, baseURL, apiKey });
			if (visionWarningEl === el) renderVisionVerdict(el, verdict, model, meta, baseURL);
		})();
	}, 500);
}

/** Endpoint, model, the recommendation, the live callout, and a key only where a server might want one. */
function renderLocalhostSettings(meta: ProviderMeta, containerEl: HTMLElement, ctx: BackendSettingsContext): void {
	const cfg = ctx.settings as LocalhostSettings;
	const save = () => ctx.save();

	new Setting(containerEl)
		.setName("Endpoint (base URL)")
		.setDesc(meta.id === "custom" ? "Your server's OpenAI-compatible base URL." : "Change this only if the server runs on another host or port.")
		.addText((text) => {
			text.setPlaceholder(meta.baseURL || "http://localhost:…/v1").setValue(cfg.baseURL ?? meta.baseURL);
			text.onChange(async (value) => {
				cfg.baseURL = value || undefined;
				await save();
				scheduleVisionCheck(meta, cfg);
			});
		});

	new Setting(containerEl)
		.setName("Model")
		.setDesc("The vision model to transcribe with — whichever one you loaded.")
		.addText((text) => {
			text.setPlaceholder("e.g. qwen2.5vl").setValue(cfg.model ?? "");
			text.onChange(async (value) => {
				cfg.model = value || undefined;
				await save();
				scheduleVisionCheck(meta, cfg);
			});
		});

	containerEl.createDiv({ cls: "tagged-sync-note", text: MODEL_RECOMMENDATION });

	visionWarningEl = containerEl.createDiv({ cls: "tagged-sync-note" });
	scheduleVisionCheck(meta, cfg);

	if (meta.key !== "none") {
		new Setting(containerEl)
			.setName("API key (optional)")
			.setDesc("Only if your server requires one.")
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

// Registered after Vision and the managed local model, so they sit below both in the dropdown.
for (const meta of Object.values(LOCALHOST_PROVIDERS)) {
	registerOcrBackend({
		id: meta.id,
		label: meta.label,
		/** Never spends money: the server is the user's own. */
		metered: false,
		needsBackgroundConsent: true,
		create: (settings: BackendSettings) => createAdapter(meta, settings),
		renderSettings: (containerEl, ctx) => renderLocalhostSettings(meta, containerEl, ctx),
		noteContract: NOTE_CONTRACT,
		backgroundConsent: {
			get: (settings) => (settings as LocalhostSettings).backgroundConsent === true,
			set: (settings, value) => {
				(settings as LocalhostSettings).backgroundConsent = value;
			},
			description: BACKGROUND_CONSENT_DESC,
		},
		// No `unavailableLabel`: it can run anywhere. A server that is not running is a run-time
		// failure, not a property of the machine -- see spec §5 for where that is said instead.
		// No `renderSetup`: nothing to download, and a card would hide the entry from the dropdown.
	});
}
