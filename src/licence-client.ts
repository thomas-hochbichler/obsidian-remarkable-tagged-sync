/**
 * The Polar half of the licence check — the only part of it that speaks HTTP.
 *
 * Polar's customer-portal endpoints take **no** authentication: they are documented as safe to call
 * "on a public client, like a desktop application", and the only identifier they need besides the
 * key is the organization id, which is public. That is why a licence check can ship inside a plugin
 * bundle at all — there is no secret to hide in it.
 *
 * Requests go through the global `fetch`, which esbuild rewrites to Obsidian's `requestUrl`
 * (see `obsidian-fetch.ts`), so there is no CORS problem and no new dependency.
 */

import type { ActivationResult, LicenceApi } from "./licence-check";
import type { LicenceOutcome } from "./licence-state";

const POLAR_API = "https://api.polar.sh/v1/customer-portal/license-keys";

/**
 * Public identifier of the Polar organization selling Tagged Sync Pro. Not a secret, and not a
 * credential: it only says which organization's keys to look up.
 */
export const POLAR_ORGANIZATION_ID = "e1f4bd71-6fb3-4f0f-a602-f42985a89e15";

type Fetch = typeof fetch;

export function createPolarLicenceApi(
	organizationId: string = POLAR_ORGANIZATION_ID,
	fetchImpl: Fetch = fetch,
): LicenceApi {
	const post = async (path: string, body: Record<string, unknown>): Promise<Response> =>
		fetchImpl(`${POLAR_API}/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ organization_id: organizationId, ...body }),
		});

	return {
		/**
		 * ⚠️ Two calls, and the second one is the whole reason this function exists.
		 *
		 * Polar answers **404 for every failure** on validate: a key that never existed, a key
		 * withdrawn after a refund, an expired key, and an activation that someone has freed all look
		 * identical. Acting on that directly would mean choosing between two wrong behaviours — lock a
		 * buyer out because a stranger freed their slot (`deactivate` needs no authentication), or
		 * never lock anyone because a revocation cannot be told apart from it.
		 *
		 * So a 404 is followed by a validate **without** the activation id. Polar only checks an
		 * activation when one is sent, so this asks the narrower question: is the *key* still alive?
		 * An answer means the key is fine and only the activation is gone.
		 */
		async validate(key, activationId): Promise<LicenceOutcome> {
			const first = await post("validate", { key, activation_id: activationId });
			if (first.ok) return "valid";
			if (first.status !== 404) return "unreachable";

			const keyAlone = await post("validate", { key });
			if (keyAlone.ok) return "unknown-activation";
			if (keyAlone.status === 404) return "unknown-key";
			return "unreachable";
		},

		/**
		 * ⚠️ 403 is two different answers, and they need different sentences.
		 *
		 * Polar refuses an activation with 403 both when all 50 slots are taken and when the key is no
		 * longer active — `activate` checks `is_active()` and raises the same status either way. Read
		 * as "the limit is full", someone whose licence was withdrawn after a refund is told their key
		 * is on fifty devices, which is untrue and unactionable.
		 *
		 * So a 403 asks the same narrowing question the validate path asks: is the key itself alive?
		 * If it validates on its own, the slots really are full. If it does not, the key is dead.
		 */
		async activate(key, label): Promise<ActivationResult> {
			const response = await post("activate", { key, label });
			if (response.ok) {
				const body = (await response.json()) as { id?: unknown };
				if (typeof body.id !== "string") return { outcome: "unreachable" };
				return { outcome: "valid", activationId: body.id };
			}
			if (response.status === 404) return { outcome: "unknown-key" };
			if (response.status === 403) {
				const keyAlone = await post("validate", { key });
				if (keyAlone.ok) return { outcome: "activation-limit" };
				if (keyAlone.status === 404) return { outcome: "unknown-key" };
				return { outcome: "unreachable" };
			}
			return { outcome: "unreachable" };
		},

		/** Frees this vault's slot. Answers 204 with no body; a failure is the caller's to shrug off. */
		async deactivate(key, activationId): Promise<void> {
			await post("deactivate", { key, activation_id: activationId });
		},
	};
}
