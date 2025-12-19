
import { startAuthFlow } from "./authManager.js";
import { setCredentialStorage } from "./storageProvider.js";
import { FileCredentialStorage } from "./fileStorage.js";

// Configure storage for CLI environment
setCredentialStorage(new FileCredentialStorage());

startAuthFlow().catch(console.error);
