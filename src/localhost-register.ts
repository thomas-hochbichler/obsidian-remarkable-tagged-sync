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
import { detectLocalhostVisionCapability, type ModelCapabilities, type VisionVerdict } from "./localhost-vision-detect";
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
 *
 * The **size** sentence was added for #116, where a reporter running a 4B variant read the 7.6 % as a
 * property of the family. It lives here rather than in the live callout below because nothing can
 * detect it: the probe can say what a model does, never how far it sits from the one we measured.
 * We name our own reach and borrow no number for the smaller builds -- #116 carries measurements for
 * those, beside the caveats their own author put on them.
 */
const MODEL_RECOMMENDATION =
	"Qwen2.5-VL-7B is the model we measured — about three times more accurate than Apple Vision when run " +
	"directly, though through a local server the result may differ. That number is the 7B build: a smaller " +
	"variant of the same family is a different model, and we have measured none.";

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

	return new OpenAiCompatOcrBackend({ id: meta.id, baseURL, apiKey, model, deterministic: meta.deterministic });
}

/**
 * The one place the callout is written. Lifted out of `renderVisionVerdict` so the empty-model
 * message can reuse it -- and so the colour is written through a variable, which is what keeps the
 * store's `no-static-styles-assignment` rule (an error, undisableable here) off a second site.
 */
const ERROR_COLOR = "var(--text-error)";
/** Back to the theme's own colour -- for the states that are not a warning at all. */
const NO_COLOR = "";
/** The thinking line's tone, and `partial`'s: a warning, never an error -- see {@link thinkingSentence}. */
const WARNING_COLOR = "var(--text-warning)";

function paintCallout(el: HTMLElement, text: string, color: string): void {
	el.setText(text);
	el.style.color = color;
}

/**
 * One line of the callout. Two facts want two lines and two colours (#116), and `setText` on the
 * callout itself can only carry one -- so a verdict paints child divs, while the transient states
 * above stay on `paintCallout` and its single `setText`.
 */
function paintLine(el: HTMLElement, text: string, color: string): void {
	const line = el.createDiv();
	line.setText(text);
	line.style.color = color;
}

/**
 * Renders one probe's answer into the settings callout: what the model can see, and whether it
 * reasons before answering.
 *
 * Same tone scale as Pro's, with one string rewritten: `unreachable` on a server the user runs is not
 * a network mystery, it is almost always "the app is not running" -- the most likely failure this
 * backend has, and the one they can fix in seconds (spec §5.1).
 */
function renderCapabilities(el: HTMLElement, caps: ModelCapabilities, model: string, meta: ProviderMeta, baseURL: string): void {
	el.empty();
	// Painted per line from here on, so the container's own colour must not linger from a previous
	// single-line state (`Checking…`, the empty-model message).
	el.style.color = NO_COLOR;

	const vision = visionSentence(caps.vision, model, meta, baseURL);
	if (vision) paintLine(el, vision.text, vision.color);

	// Suppressed when nothing will transcribe anyway: `unsupported` means the model must be replaced,
	// and "it also reasons before answering" is advice about a model that is already going.
	if (caps.thinking === "on" && caps.vision !== "unsupported") paintLine(el, thinkingSentence(model), WARNING_COLOR);
}

/**
 * The thinking line. `--text-warning`, the same tone as `partial`, and not `--text-error`: error is
 * reserved for "transcription will fail", and a reasoning model transcribes -- slowly, and sometimes
 * a page short. Overstating it would make the one red string in this pane mean two different things.
 *
 * It names the lever, because it has to stand alone for someone who never reads an issue: `-instruct`
 * is the one reliable naming signal there is. It is worthless as a positive marker -- of the models
 * that reason by default, only 4 % say so in their name -- but as a negative one it held on every
 * model measured: 0 of 31 ids carrying `instruct` reasoned unasked.
 */
function thinkingSentence(model: string): string {
	return (
		`⚠ "${model}" reasons before answering — expect much slower syncs, and pages left out when an ` +
		`answer runs too long. A model that doesn't reason (often the "-instruct" build) avoids both.`
	);
}

/** The vision half, or `null` where there is nothing to say about it (`none`: no probe was made). */
function visionSentence(verdict: VisionVerdict, model: string, meta: ProviderMeta, baseURL: string): { text: string; color: string } | null {
	switch (verdict) {
		case "none":
			return null;
		case "supported":
			return { text: `✓ "${model}" supports image input.`, color: "var(--text-success)" };
		case "unsupported":
			return {
				text: `⚠ ${meta.label} reports "${model}" has no image input — transcription will fail. Pick a vision model.`,
				color: ERROR_COLOR,
			};
		case "partial":
			return { text: `Couldn't confirm "${model}" accepts images — make sure it's a vision model.`, color: WARNING_COLOR };
		case "unconfirmed-name":
			return { text: `"${model}" doesn't look like a vision model. If it can't see images, transcription will fail.`, color: WARNING_COLOR };
		case "unreachable":
			return { text: unreachableMessage(meta, baseURL), color: WARNING_COLOR };
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

/**
 * What the callout says while the model field is still empty.
 *
 * The check it replaces asked the server about a model named `""` and rendered the answer as
 * `"" doesn't look like a vision model` -- a sentence about a model the user never typed. This one
 * states the run-time behaviour instead: the adapter refuses an empty model rather than letting the
 * server pick one for it, so nothing transcribes until this row is filled.
 */
export const NO_MODEL_MESSAGE = "No model set — nothing will transcribe until you name the model to use.";

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
	// Cleared before the early returns too, or a check still pending from the previous keystroke
	// would land on top of whatever they render.
	if (visionCheckTimer !== null) window.clearTimeout(visionCheckTimer);
	if (!baseURL) {
		paintCallout(el, "", NO_COLOR);
		return;
	}
	if (!model.trim()) {
		paintCallout(el, NO_MODEL_MESSAGE, ERROR_COLOR);
		return;
	}
	paintCallout(el, `Checking "${model}"…`, NO_COLOR);
	visionCheckTimer = window.setTimeout(() => {
		void (async () => {
			const caps = await detectLocalhostVisionCapability({ provider: meta.id as LocalhostProviderId, model, baseURL, apiKey });
			if (visionWarningEl === el) renderCapabilities(el, caps, model, meta, baseURL);
		})();
	}, 500);
}

/** Endpoint, model, the recommendation, the live callout, and a key only where a server might want one. */
function renderLocalhostSettings(meta: ProviderMeta, containerEl: HTMLElement, ctx: BackendSettingsContext): void {
	const cfg = ctx.settings as LocalhostSettings;
	const save = () => ctx.save();

	// The model field ships empty and nothing transcribes until it is filled, so it stays in the open.
	// Everything else here already has a working value -- the endpoint is the provider's own default,
	// and a key is only wanted by a server that asks for one -- and a row nobody has to touch is a row
	// that can wait behind a disclosure.
	new Setting(containerEl)
		.setName("Model")
		.setDesc("The vision model to transcribe with — whichever one you loaded.")
		.addText((text) => {
			text.setPlaceholder("e.g. qwen2.5vl:7b").setValue(cfg.model ?? "");
			text.onChange(async (value) => {
				cfg.model = value || undefined;
				await save();
				scheduleVisionCheck(meta, cfg);
			});
		});

	containerEl.createDiv({ cls: "tagged-sync-note", text: MODEL_RECOMMENDATION });

	visionWarningEl = containerEl.createDiv({ cls: "tagged-sync-note" });
	scheduleVisionCheck(meta, cfg);

	const advanced = containerEl.createEl("details", { cls: "tagged-sync-advanced" });
	advanced.createEl("summary", { text: "Advanced" });

	new Setting(advanced)
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

	if (meta.key !== "none") {
		new Setting(advanced)
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

	// A custom server has no default endpoint to fall back on: leaving it folded away would hide the
	// one field that makes the backend work at all.
	if (meta.id === "custom" || cfg.baseURL !== undefined) advanced.open = true;
}

// Registered after Vision and the managed local model, so they sit below both in the dropdown.
for (const meta of Object.values(LOCALHOST_PROVIDERS)) {
	registerOcrBackend({
		id: meta.id,
		label: meta.label,
		/** Never spends money: the server is the user's own. */
		metered: false,
		requiresLicence: false,
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
