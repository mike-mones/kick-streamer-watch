import { CredentialStorage } from "./credentialStorage.js";
import { FileCredentialStorage } from "./fileStorage.js";

let currentStorage: CredentialStorage = new FileCredentialStorage(); // Default to File for safety/CLI
let storageConfigured = false;

/**
 * Configure the credential storage implementation.
 *
 * This function is intended to be called once during application initialization.
 * Subsequent calls with a different storage instance will throw an error to
 * prevent inconsistent storage usage across the application.
 *
 * Calling this multiple times with the same storage instance is allowed.
 */
export function setCredentialStorage(storage: CredentialStorage) {
    if (storageConfigured && storage !== currentStorage) {
        throw new Error(
            "Credential storage has already been configured. " +
            "setCredentialStorage should only be called once during initialization."
        );
    }

    currentStorage = storage;
    storageConfigured = true;
}

export function getCredentialStorage(): CredentialStorage {
    return currentStorage;
}
