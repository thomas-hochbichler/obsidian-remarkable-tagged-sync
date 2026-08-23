/**
 * Where the failure happened. The same underlying error means different things in the two places:
 * during `connect` a rejection is almost always a stale one-time code, while during a sync it is a
 * device token that has stopped being accepted.
 */
export type ErrorContext = "connect" | "sync";

// Matched against the error text because the plugin talks to the reMarkable cloud through rmapi-js
// and Electron's fetch, neither of which exposes a stable typed error. Deliberately loose: an
// unrecognised error still gets the honest "unexpected answer" message below.
const OFFLINE_RE = /network|failed to fetch|fetch failed|enotfound|econnrefused|eai_again|getaddrinfo|err_internet_disconnected|offline/i;
const REJECTED_RE = /\b401\b|\b403\b|unauthorized|unauthorised|forbidden|invalid[ _-]?token|token[ _-]?expired/i;
// Obsidian's own vault refusals: "File already exists.", "Folder already exists.", and the
// forbidden-character sentence. Without this, a local name conflict falls through to the
// unexpected-answer message below and reads as a reMarkable API break (issue #73).
const VAULT_RE = /already exists|cannot contain/i;

/**
 * Turns whatever the cloud or the runtime threw into one plain sentence that says what to do next.
 * Users see raw rmapi-js and Electron text otherwise, which explains nothing and reads as a crash.
 *
 * The unexpected-answer case is load-bearing: the reMarkable API is reverse-engineered and
 * unversioned, so "they changed their service" is a real and recurring cause, and this is the
 * plugin's whole answer to it -- naming it keeps a firmware break from looking like data loss.
 */
export function explainError(error: unknown, context: ErrorContext): string {
	const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

	if (OFFLINE_RE.test(text)) return "No connection to the reMarkable cloud. Check your internet connection.";

	if (context === "connect") {
		return "That code was not accepted. Codes expire after a few minutes — get a fresh one from my.remarkable.com and try again.";
	}

	if (REJECTED_RE.test(text)) {
		return "Your reMarkable connection is no longer valid. Open Settings → Connect and enter a new code.";
	}

	if (VAULT_RE.test(text)) {
		return (
			"A file or folder in your vault is in the way of what the sync tried to write. This is a local " +
			"name conflict, not a reMarkable problem — check the folder names in the plugin settings."
		);
	}

	return (
		"reMarkable's cloud answered in a way this plugin did not expect. This can happen when reMarkable " +
		"changes their service. Check for a plugin update, and report it if it keeps happening."
	);
}
