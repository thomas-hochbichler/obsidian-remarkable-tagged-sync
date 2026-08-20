/**
 * What stops a sync nobody asked for.
 *
 * Every one of these refusals is silent by design -- no notice, no error, nothing in the console --
 * because a background run that explains itself is a popup on a machine whose owner is elsewhere.
 * That is also what makes them dangerous to leave untested: a gate that stopped working looks
 * exactly like a gate that was never reached, and two of them are the only thing between an
 * overnight Obsidian and a bill nobody agreed to.
 *
 * The gates are in two halves because resolving a backend is not free -- it constructs adapters and
 * can raise a fallback notice -- so everything decidable without one is decided first.
 */

/** Which rule refused. Named rather than boolean so a test can tell one gate's `false` from another's. */
export type AutoSyncSkip =
	| "auto-sync-off"
	| "already-running"
	| "not-connected"
	| "no-background-consent"
	| "no-consent-to-spend";

export interface BackgroundConditions {
	/** The master switch in settings. */
	readonly enabled: boolean;
	/** A sync or a re-transcribe is in flight. */
	readonly running: boolean;
	/** A device token is stored. */
	readonly connected: boolean;
	/** The chosen backend may run unattended at all -- see {@link backgroundConsentGiven}. */
	readonly backgroundConsent: boolean;
}

/** The gates that can be judged before a backend is resolved, in the order they are asked. */
export function backgroundRunBlocked(conditions: BackgroundConditions): AutoSyncSkip | null {
	if (!conditions.enabled) return "auto-sync-off";
	if (conditions.running) return "already-running";
	if (!conditions.connected) return "not-connected";
	if (!conditions.backgroundConsent) return "no-background-consent";
	return null;
}

/**
 * The money gate, which can only be asked of the adapter that will actually run.
 *
 * Reading the *chosen* backend id instead would refuse a run that costs nothing: a cloud provider
 * with no API key falls back to a free local one, and the id still says "openai".
 */
export function autoSpendBlocked(backendIsMetered: boolean, consentedToSpend: boolean): AutoSyncSkip | null {
	return backendIsMetered && !consentedToSpend ? "no-consent-to-spend" : null;
}

/** Only the part of a registry entry this decision reads. */
export interface BackgroundConsentSource {
	readonly needsBackgroundConsent: boolean;
	readonly backgroundConsent?: { get(settings: Record<string, unknown>): boolean };
}

/**
 * Whether the chosen backend may run unattended, money aside.
 *
 * A backend that does not ask for this consent has it: most cost nothing but network. The one that
 * asks costs no money either and still costs battery, fans and several GB of RAM, which is why this
 * is a separate promise from the auto-spend one -- agreeing to be billed by a cloud provider is not
 * agreeing to run a local model all night.
 *
 * A backend this build does not have (the registry answers `null`) is not blocked here. It cannot run
 * at all, and refusing it as unconsented would name the wrong reason.
 */
export function backgroundConsentGiven(entry: BackgroundConsentSource | null | undefined, settings: Record<string, unknown>): boolean {
	if (!entry?.needsBackgroundConsent || !entry.backgroundConsent) return true;
	return entry.backgroundConsent.get(settings);
}
