import type { Entitlement } from "./licence-state";
import { isGated } from "./ocr-resolution";
import { ocrBackendEntries } from "./ocr-registry";
import { allowedTransports } from "./ssh-transport";
import { planTagRouting, tagLimitFor } from "./tag-routing-view";

/**
 * Everything Tagged Sync Pro sells, in one list a test can walk.
 *
 * The problem this exists for, measured before it was written: a gate that falls open is invisible
 * from both sides. `requiresLicence: meta.kind === "cloud"` -> `false` passed all 996 tests, and
 * deleting the gate block in `main.ts` did too -- because the buyer cannot tell a paid feature from
 * a free one when the gate is gone, and nothing goes red.
 *
 * A list per gate would have the same hole one level up: the way a paywall breaks is that somebody
 * adds a feature and nobody adds its test. So this is a **walk over a declared list**, and the two
 * halves that make forgetting loud are:
 *
 *   1. **Membership comes from `BACKEND_TIER`, never from `requiresLicence`.** Filtering on the flag
 *      under test would empty the list the moment the flag was wrong -- and a walk over an empty
 *      list passes every assertion in it.
 *   2. **There is no default.** A registered backend with no line in `BACKEND_TIER` fails the census
 *      by id. Opting out costs a written sentence somebody can disagree with.
 */

/**
 * What the user gets instead when a capability is locked.
 *
 * There is deliberately no third member: "nothing happens, silently" is the failure this whole file
 * is about, so it cannot be declared.
 */
export type LockedOutcome =
	/** The run continues on a free backend, and says so. */
	| "falls-back-to-free"
	/** The action is not offered, and says why where it sits. */
	| "refused-in-place";

/**
 * How a capability's gate is checked.
 *
 * Both members are `exercised` today, and that is newer than the design: when this was specified,
 * both enforcement sites lived inside `main.ts` and could only be grepped for. The `main.ts` cut
 * moved the backend gate into `ocr-resolution.ts` and the tag cap into `tag-routing-view.ts`, so both
 * are now importable -- and a presence check that proves an `if` is still written has been replaced
 * by running the gate and comparing what came back.
 */
export interface Enforcement {
	/** The decision itself, driven at an entitlement. */
	run(entitlement: Entitlement): LockedOutcome | "allowed";
	/** Where it is acted on, for a failure message somebody can act on. */
	readonly site: string;
}

export interface ProCapability {
	readonly id: string;
	/** One sentence, in the words a buyer would recognise. */
	readonly label: string;
	/**
	 * The gate: true when this capability is not available at that entitlement.
	 *
	 * A **predicate over `Entitlement`**, not a boolean. A `gated: true` field could only ever be
	 * compared with itself; a predicate can be driven through the licence states, which is what makes
	 * the three cases in the test mean anything.
	 */
	locked(entitlement: Entitlement): boolean;
	readonly whenLocked: LockedOutcome;
	readonly enforcedAt: Enforcement;
}

/**
 * Which side of the paywall every registered backend is on, and why.
 *
 * A backend is listed here or it fails the census; there is no fallback value. `paid: false` costs a
 * sentence, which is the point -- omission fails and opting out is visible, where a bare
 * `requiresLicence: false` inside a registration loop is neither.
 */
export const BACKEND_TIER: Record<string, { readonly paid: boolean; readonly because: string }> = {
	vision: { paid: false, because: "Apple's on-device OCR. Ships with the operating system; nobody is billed for it." },
	off: { paid: false, because: "Transcribes nothing at all. There is no feature here to sell." },
	local: { paid: false, because: "The managed local model runs on the user's own machine and costs them battery, not us money." },
	ollama: { paid: false, because: "The user's own server. We neither host it nor bill for it." },
	lmstudio: { paid: false, because: "The user's own server. We neither host it nor bill for it." },
	custom: { paid: false, because: "Whatever endpoint the user points it at. Theirs to run, theirs to pay for." },
	anthropic: { paid: true, because: "Cloud LLM transcription is what Tagged Sync Pro sells." },
	openai: { paid: true, because: "Cloud LLM transcription is what Tagged Sync Pro sells." },
	gemini: { paid: true, because: "Cloud LLM transcription is what Tagged Sync Pro sells." },
	openrouter: { paid: true, because: "Cloud LLM transcription is what Tagged Sync Pro sells." },
};

/** Registered backend ids with no line in {@link BACKEND_TIER}. An id nobody wrote down is an error. */
export function undeclaredBackends(): string[] {
	return ocrBackendEntries()
		.map((entry) => entry.id)
		.filter((id) => BACKEND_TIER[id] === undefined);
}

function backendCapability(entry: { id: string; label: string; requiresLicence: boolean }): ProCapability {
	return {
		id: `ocr-backend:${entry.id}`,
		label: `${entry.label} transcription`,
		// The entry's own flag, read the way `resolveOcrBackend` reads it. If the flag is wrong this is
		// false for a free user, and the walk says so by id.
		locked: (entitlement) => isGated(entry, entitlement.tier),
		whenLocked: "falls-back-to-free",
		enforcedAt: {
			site: "src/ocr-resolution.ts isGated, called from src/main.ts resolveOcrBackend",
			// The production predicate itself, not a copy: `resolveOcrBackend` asks this exact question.
			run: (entitlement) => (isGated(entry, entitlement.tier) ? "falls-back-to-free" : "allowed"),
		},
	};
}

/**
 * The tag cap, which is not a backend and never will be, so it is written in directly.
 *
 * `locked` is phrased against **the limit**, not against the tier. Both say the same thing today and
 * only the first can see the mutation that matters: with `FREE_TAG_LIMIT = Infinity` a tier test
 * would still cheerfully report "free means locked".
 */
const TAG_MAPPING_CAPABILITY: ProCapability = {
	id: "tag-mappings-beyond-the-first",
	label: "More than one tag mapped to a folder",
	locked: (entitlement) => tagLimitFor(entitlement) < 2,
	whenLocked: "refused-in-place",
	enforcedAt: {
		site: "src/tag-routing-view.ts planTagRouting",
		/**
		 * Driven, not grepped: one tag already mapped and a second discovered is exactly the state the
		 * cap exists for, so the plan's own items say whether it closed -- and `capped` is what makes
		 * the refusal visible in place rather than silent.
		 */
		run: (entitlement) => {
			const view = planTagRouting({
				mapping: { "#first": "Inbox" },
				discoveredTags: ["#first", "#second"],
				folderPaths: ["/", "Inbox", "Archive"],
				entitlement,
			});
			return view.items.some((item) => item.kind === "capped") ? "refused-in-place" : "allowed";
		},
	},
};

/**
 * Reading the tablet directly instead of the cloud -- also not a backend, so also written in here.
 *
 * `locked` asks the production gate the question the production gate is asked: *may this vault sync
 * over SSH*. Phrased that way rather than against the tier, so that widening `allowedTransports` to
 * hand SSH to everyone shows up here as an unlocked capability rather than as nothing at all.
 */
const SSH_TRANSPORT_CAPABILITY: ProCapability = {
	id: "sync-straight-from-the-device",
	label: "Sync straight from the tablet over USB or Wi-Fi, without the reMarkable cloud",
	locked: (entitlement) => !allowedTransports(entitlement).includes("ssh"),
	// The run continues, on the cloud, and says why -- the same shape as a gated backend, and for the
	// same reason: a lapsed licence must not be a sync that stopped working.
	whenLocked: "falls-back-to-free",
	enforcedAt: {
		site: "src/ssh-transport.ts allowedTransports, called from src/main.ts transport and transportChain",
		run: (entitlement) => (allowedTransports(entitlement).includes("ssh") ? "allowed" : "falls-back-to-free"),
	},
};

/**
 * Every gated capability this build ships.
 *
 * The `filter` is the single most important line here. The obvious form --
 * `.filter((entry) => entry.requiresLicence)` -- is worthless: setting that flag to `false` would
 * empty the list, and an empty walk passes everything.
 */
export function proCapabilities(): ProCapability[] {
	const backends = ocrBackendEntries()
		.filter((entry) => BACKEND_TIER[entry.id]?.paid)
		.map(backendCapability);
	return [...backends, TAG_MAPPING_CAPABILITY, SSH_TRANSPORT_CAPABILITY];
}

/**
 * Which production files may read `entitlement.tier`, and **how many times**.
 *
 * The census above only sees backends. A brand-new gated capability that is not a backend -- the
 * exact shape of the tag cap -- cannot be enumerated by anything, because it does not exist until
 * somebody writes it. What *can* be enumerated is the act of gating, and gating means reading the
 * tier.
 *
 * The **count** is what makes this bite in a file that is already allowed: a second hand-written
 * gate beside the first inside `settings-tab.ts` moves 4 to 5, and the test names the file. It does
 * not stop anyone adding a gate; it makes adding one impossible to do *quietly*, and the `why`
 * strings say what the reviewer is meant to ask for -- a line in `proCapabilities()`.
 *
 * Same idiom the repo already uses for the other thing that must not slip out: `check-bundle.mjs`
 * counting needles in the published bundle.
 */
export const TIER_READERS: Record<string, { readonly reads: number; readonly why: string }> = {
	"src/licence-check.ts": { reads: 1, why: "Decides whether the ended-licence notice fires. Not a gate." },
	"src/licence-messages.ts": { reads: 1, why: "Renders the settings-tab status line. Not a gate." },
	"src/main.ts": { reads: 1, why: "The backend gate, asked through `isGated`. A gate, and it is in the list." },
	"src/tag-routing-view.ts": { reads: 1, why: "The tag cap's own limit function. A gate, and it is in the list." },
	"src/ssh-transport.ts": {
		reads: 1,
		why: "`allowedTransports`, the direct-device gate. A gate, and it is in the list -- `main.ts` asks it rather than reading the tier itself.",
	},
	"src/settings-tab.ts": {
		reads: 4,
		why: "3 display lines in the Pro section, plus the live licence re-check before a mapping past the cap. Display, and one re-read of a gate that lives elsewhere.",
	},
};
