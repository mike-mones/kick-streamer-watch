import { createServer } from "http";
import * as crypto from "crypto";
import { getCredentialStorage } from "./storageProvider.js";
import streamDeck from "@elgato/streamdeck";

const WORKER_URL = "https://kick-auth-worker.mikemones2584.workers.dev";
const REDIRECT_PORT = 3000;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}`;

export async function startAuthFlow(): Promise<void> {
  // 1. Generate PKCE
  const codeVerifier = base64URLEncode(crypto.randomBytes(32));
  const codeChallenge = base64URLEncode(crypto.createHash("sha256").update(codeVerifier).digest());

  // 2. Get Auth Params from Worker (or hardcode)
  // We'll fetch from worker to be dynamic
  let authParams;
  try {
    const response = await fetch(`${WORKER_URL}/auth-params`);
    authParams = await response.json();
  } catch (e) {
    console.error("Failed to fetch auth params", e);
    return;
  }

  const { clientId, authEndpoint, scope } = authParams;

  // 3. Start Local Server
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "", `http://localhost:${REDIRECT_PORT}`);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`<h1>Login Failed</h1><p>Error: ${error}</p><p>Please check your Redirect URI configuration in the Kick Developer Portal.</p>`);
      server.close();
      return;
    }

    if (code) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Login Successful!</h1><p>You can close this window and return to Stream Deck.</p>");
      server.close();

      // 4. Exchange Code for Token via Worker
      try {
        const tokenResponse = await fetch(`${WORKER_URL}/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code,
            redirect_uri: REDIRECT_URI,
            code_verifier: codeVerifier,
          }),
        });

        if (!tokenResponse.ok) {
          throw new Error(`Token exchange failed: ${tokenResponse.statusText}`);
        }

        const tokens = await tokenResponse.json();
        
        // 5. Save Credentials
        // We pass empty strings for clientId/secret as they are now managed by the worker
        await getCredentialStorage().save({
            serverMetadata: { issuer: "https://id.kick.com/", authorization_endpoint: authEndpoint, token_endpoint: "https://id.kick.com/oauth/token" },
            clientId: "", 
            clientSecret: "", 
            tokens
        });
        
        console.info("Credentials saved successfully.");
      } catch (e) {
        console.error("Failed to exchange token", e);
      }
    } else {
      res.writeHead(400);
      res.end("No code found.");
    }
  });

  server.listen(REDIRECT_PORT, async () => {
    // 6. Open Browser
    const authUrl = new URL(authEndpoint);
    authUrl.searchParams.append("response_type", "code");
    authUrl.searchParams.append("client_id", clientId);
    authUrl.searchParams.append("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.append("scope", scope);
    authUrl.searchParams.append("code_challenge", codeChallenge);
    authUrl.searchParams.append("code_challenge_method", "S256");

    const state = crypto.randomBytes(16).toString("hex");
    authUrl.searchParams.append("state", state);

    console.info(`[AUTH] Opening URL: ${authUrl.toString()}`);
    
    // Use Stream Deck SDK to open URL if available (runtime), otherwise fallback to console (CLI)
    try {
        await streamDeck.system.openUrl(authUrl.toString());
    } catch (_e) {
        // Fallback for CLI / Node.js environments
        try {
            // Only attempt to dynamically import "open" when running under Node.js.
            // This fallback is primarily for local testing/CLI usage where the Stream Deck SDK is not available.
            if (typeof process !== "undefined" && process.release && process.release.name === "node") {
                const openModule = await import("open");
                // Handle both ESM and CommonJS default exports
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const openFn = (openModule as any).default ?? openModule;
                if (typeof openFn === "function") {
                    await openFn(authUrl.toString());
                    return;
                }
            }
        } catch (_openError) {
            // Ignore and fall through to logging the URL.
        }
        // Final fallback: ask the user to open the URL manually.
        console.info("Please open this URL in your browser to login:");
        console.info(authUrl.toString());
    }
  });
}

function base64URLEncode(buffer: Buffer): string {
  return buffer.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
