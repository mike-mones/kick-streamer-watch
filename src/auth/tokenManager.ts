import { type Credentials } from "../server/credentials.js";
import type { TokenEndpointResponse } from "../types.js";
import { getCredentialStorage } from "./storageProvider.js";

export class KickCredentialsMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KickCredentialsMissingError";
  }
}

const TOKEN_EXPIRY_SKEW_SECONDS = 60;
const WORKER_URL = "https://kick-auth-worker.mikemones2584.workers.dev";

let cachedCredentials: Credentials | undefined;
let cachedTokens: TokenEndpointResponse | undefined;
let refreshInFlight: Promise<TokenEndpointResponse | undefined> | undefined;

export function invalidateCredentialsCache() {
  cachedCredentials = undefined;
  cachedTokens = undefined;
}

export async function logout() {
  invalidateCredentialsCache();
  await getCredentialStorage().delete();
}

export async function getAccessToken(): Promise<string> {
    const { tokens } = await ensureCredentials();
    return assertAccessToken(tokens);
}

export async function refreshCurrentTokens(): Promise<TokenEndpointResponse> {
    const { credentials, tokens } = await ensureCredentials();
    return refreshTokens(credentials, tokens);
}

async function ensureCredentials(): Promise<{
  tokens: TokenEndpointResponse;
  credentials: Credentials;
}> {
  const credentials = await loadCredentials();

  if (!cachedTokens) {
    cachedTokens = credentials.tokens;
  }

  if (!cachedTokens) {
    throw new KickCredentialsMissingError("Kick credentials incomplete. Run the auth helper CLI to generate tokens.");
  }

  if (shouldRefreshToken(cachedTokens) && cachedTokens.refresh_token) {
    cachedTokens = await refreshTokens(credentials, cachedTokens);
  }

  return {
    tokens: cachedTokens,
    credentials,
  };
}

async function loadCredentials(): Promise<Credentials> {
  if (cachedCredentials) {
    return cachedCredentials;
  }

  try {
    cachedCredentials = await getCredentialStorage().load();
    return cachedCredentials;
  } catch (_error) {
    throw new KickCredentialsMissingError(
      "Kick credentials not found. Run `npm run auth` (or the helper script) to generate credentials.json."
    );
  }
}

function assertAccessToken(tokens: TokenEndpointResponse): string {
  if (!tokens.access_token) {
    throw new KickCredentialsMissingError("Kick credentials missing access token. Re-run the auth helper.");
  }

  return tokens.access_token;
}

function shouldRefreshToken(tokens: TokenEndpointResponse): boolean {
  if (!tokens.expires_at) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = typeof tokens.expires_at === "number" ? tokens.expires_at : Number(tokens.expires_at);
  return expiresAt - TOKEN_EXPIRY_SKEW_SECONDS <= now;
}

async function refreshTokens(
  credentials: Credentials,
  currentTokens: TokenEndpointResponse,
): Promise<TokenEndpointResponse> {
  if (!currentTokens.refresh_token) {
    throw new KickCredentialsMissingError("Kick credentials missing refresh token. Re-run the auth helper CLI.");
  }

  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      // Use Worker for refresh
      const response = await fetch(`${WORKER_URL}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: currentTokens.refresh_token }),
      });

      if (!response.ok) {
         throw new Error(`Token refresh failed: ${response.statusText}`);
      }

      const refreshed = await response.json() as TokenEndpointResponse;
      
      const mergedTokens = {
        ...refreshed,
        refresh_token: refreshed.refresh_token ?? currentTokens.refresh_token,
        expires_at: refreshed.expires_at || Math.floor(Date.now() / 1000) + (refreshed.expires_in || 7200),
      } as TokenEndpointResponse;

      cachedTokens = mergedTokens;
      cachedCredentials = {
        ...credentials,
        tokens: mergedTokens,
      };

      await getCredentialStorage().save(cachedCredentials);

      return mergedTokens;
    })();
  }

  try {
    const tokens = await refreshInFlight;
    if (!tokens) {
      throw new KickCredentialsMissingError("Unable to refresh Kick API tokens.");
    }
    return tokens;
  } finally {
    refreshInFlight = undefined;
  }
}
