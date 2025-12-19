import { type Credentials } from "../server/credentials.js";

export interface CredentialStorage {
    load(): Promise<Credentials>;
    save(credentials: Credentials): Promise<void>;
    delete(): Promise<void>;
}
