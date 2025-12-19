import streamDeck from "@elgato/streamdeck";
import { type Credentials, readCredentials } from "../server/credentials.js";
import { CredentialStorage } from "./credentialStorage.js";

type GlobalSettings = {
    credentials?: Credentials;
    [key: string]: unknown;
};

class Mutex {
    private mutex = Promise.resolve();

    lock(): Promise<() => void> {
        let release: () => void = () => {};
        const nextLock = new Promise<void>(resolve => {
            release = resolve;
        });
        
        const currentLock = this.mutex.then(() => release);
        
        this.mutex = this.mutex.then(() => nextLock);
        
        return currentLock;
    }

    async dispatch<T>(fn: (() => T) | (() => PromiseLike<T>)): Promise<T> {
        const unlock = await this.lock();
        try {
            return await Promise.resolve(fn());
        } finally {
            unlock();
        }
    }
}

function isValidCredentials(value: unknown): value is Credentials {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const creds = value as Partial<Credentials> & Record<string, unknown>;

    return (
        "serverMetadata" in creds &&
        "clientId" in creds &&
        "clientSecret" in creds &&
        "tokens" in creds &&
        typeof creds.clientId === "string" &&
        typeof creds.clientSecret === "string"
    );
}

export class StreamDeckCredentialStorage implements CredentialStorage {
    private mutex = new Mutex();

    async load(): Promise<Credentials> {
        return this.mutex.dispatch(async () => {
            const settings = await streamDeck.settings.getGlobalSettings() as GlobalSettings;
            
            if (settings.credentials && isValidCredentials(settings.credentials)) {
                return settings.credentials;
            }

            // Fallback: Try to read from file (read-only seed)
            try {
                const fileCreds = await readCredentials();
                
                if (!isValidCredentials(fileCreds)) {
                    throw new Error("Invalid credentials loaded from file.");
                }

                // If found, migrate to global settings immediately so we can refresh later
                // We call the internal save logic directly to avoid deadlock.
                await this._save(fileCreds);
                
                return fileCreds;
            } catch (e) {
                const details = e instanceof Error ? e.message : String(e);
                throw new Error(`No credentials found in settings or file. Original error: ${details}`);
            }
        });
    }

    async save(credentials: Credentials): Promise<void> {
        return this.mutex.dispatch(async () => {
            await this._save(credentials);
        });
    }

    private async _save(credentials: Credentials): Promise<void> {
        const settings = await streamDeck.settings.getGlobalSettings() as GlobalSettings;
        settings.credentials = credentials;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await streamDeck.settings.setGlobalSettings(settings as any);
    }

    async delete(): Promise<void> {
        return this.mutex.dispatch(async () => {
            const settings = await streamDeck.settings.getGlobalSettings() as GlobalSettings;
            delete settings.credentials;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await streamDeck.settings.setGlobalSettings(settings as any);
        });
    }
}
