import { readCredentials, writeCredentials, deleteCredentials, type Credentials } from "../server/credentials.js";
import { CredentialStorage } from "./credentialStorage.js";

export class FileCredentialStorage implements CredentialStorage {
    async load(): Promise<Credentials> {
        return readCredentials();
    }

    async save(credentials: Credentials): Promise<void> {
        // We pass empty strings for clientId/secret if they are missing, 
        // but credentials object usually has them.
        await writeCredentials(
            credentials.serverMetadata,
            credentials.clientId,
            credentials.clientSecret,
            credentials.tokens
        );
    }

    async delete(): Promise<void> {
        await deleteCredentials();
    }
}
