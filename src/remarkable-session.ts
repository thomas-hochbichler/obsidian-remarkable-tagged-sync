import { type RemarkableApi, session as remarkableSession } from "rmapi-js";
import { tolerateSlimContent } from "./remarkable-content";
import { tolerateLegacyMetadata } from "./remarkable-metadata";

/** The only way this plugin opens a cloud session -- see tolerateLegacyMetadata and tolerateSlimContent for what they fix. */
export function openSession(sessionToken: string): RemarkableApi {
	const api = remarkableSession(sessionToken);
	tolerateLegacyMetadata(api.raw);
	tolerateSlimContent(api.raw);
	return api;
}
