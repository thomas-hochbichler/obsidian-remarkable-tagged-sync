import { auth, register } from "rmapi-js";

export interface AuthStore {
	getDeviceToken(): string | null;
	setDeviceToken(token: string | null): Promise<void>;
}

export class RemarkableAuth {
	constructor(private readonly store: AuthStore) {}

	isConnected(): boolean {
		return this.store.getDeviceToken() !== null;
	}

	async connect(code: string): Promise<void> {
		const deviceToken = await register(code);
		await this.store.setDeviceToken(deviceToken);
	}

	async disconnect(): Promise<void> {
		await this.store.setDeviceToken(null);
	}

	async session(): Promise<string> {
		const deviceToken = this.store.getDeviceToken();
		if (deviceToken === null) {
			throw new Error("Not connected to reMarkable.");
		}
		return auth(deviceToken);
	}
}
