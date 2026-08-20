import { type RemarkableApi, session as remarkableSession } from "rmapi-js";
import { tolerateLegacyMetadata } from "./remarkable-metadata";

/** The only way this plugin opens a cloud session -- see tolerateLegacyMetadata for what it fixes. */
export function openSession(sessionToken: string): RemarkableApi {
	const api = remarkableSession(sessionToken);
	tolerateLegacyMetadata(api.raw);
	return api;
}
