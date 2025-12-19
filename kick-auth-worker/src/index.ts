export interface Env {
	KICK_CLIENT_ID: string;
	KICK_CLIENT_SECRET: string;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// CORS headers
		const corsHeaders = {
			"Access-Control-Allow-Origin": "*",
			"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		};

		if (request.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders });
		}

		try {
			if (path === "/auth-params" && request.method === "GET") {
				return new Response(
					JSON.stringify({
						clientId: env.KICK_CLIENT_ID,
						authEndpoint: "https://id.kick.com/oauth/authorize",
						tokenEndpoint: "https://id.kick.com/oauth/token",
						scope: "channel:read user:read",
					}),
					{
						headers: { "Content-Type": "application/json", ...corsHeaders },
					}
				);
			}

			if (path === "/token" && request.method === "POST") {
				const body = await request.json() as any;
				const { code, redirect_uri, code_verifier } = body;

				if (!code || !redirect_uri || !code_verifier) {
					return new Response("Missing required parameters", { status: 400, headers: corsHeaders });
				}

				const params = new URLSearchParams();
				params.append("grant_type", "authorization_code");
				params.append("client_id", env.KICK_CLIENT_ID);
				params.append("client_secret", env.KICK_CLIENT_SECRET);
				params.append("code", code);
				params.append("redirect_uri", redirect_uri);
				params.append("code_verifier", code_verifier);

				const tokenResponse = await fetch("https://id.kick.com/oauth/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: params,
				});

				const data = await tokenResponse.json();
				return new Response(JSON.stringify(data), {
					status: tokenResponse.status,
					headers: { "Content-Type": "application/json", ...corsHeaders },
				});
			}

			if (path === "/refresh" && request.method === "POST") {
				const body = await request.json() as any;
				const { refresh_token } = body;

				if (!refresh_token) {
					return new Response("Missing refresh_token", { status: 400, headers: corsHeaders });
				}

				const params = new URLSearchParams();
				params.append("grant_type", "refresh_token");
				params.append("client_id", env.KICK_CLIENT_ID);
				params.append("client_secret", env.KICK_CLIENT_SECRET);
				params.append("refresh_token", refresh_token);

				const tokenResponse = await fetch("https://id.kick.com/oauth/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: params,
				});

				const data = await tokenResponse.json();
				return new Response(JSON.stringify(data), {
					status: tokenResponse.status,
					headers: { "Content-Type": "application/json", ...corsHeaders },
				});
			}

			if (path.startsWith("/proxy/channel/") && request.method === "GET") {
				const slug = path.split("/").pop();
				if (!slug) {
					return new Response("Missing slug", { status: 400, headers: corsHeaders });
				}

				const kickResponse = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
					headers: {
						"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
						"Accept": "application/json",
					}
				});

				if (!kickResponse.ok) {
					return new Response(`Kick API Error: ${kickResponse.status}`, { status: kickResponse.status, headers: corsHeaders });
				}

				const data = await kickResponse.json();
				return new Response(JSON.stringify(data), {
					headers: { "Content-Type": "application/json", ...corsHeaders },
				});
			}

			return new Response("Not Found", { status: 404, headers: corsHeaders });
		} catch (err: any) {
			return new Response(`Internal Server Error: ${err.message}`, { status: 500, headers: corsHeaders });
		}
	},
};
