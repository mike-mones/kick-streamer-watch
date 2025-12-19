import { getAccessToken, refreshCurrentTokens, KickCredentialsMissingError, invalidateCredentialsCache, logout } from "../auth/tokenManager.js";

export { KickCredentialsMissingError, invalidateCredentialsCache, logout };

export type KickChannelStatus = {
  isLive: boolean;
  displayName: string;
  profileImageUrl?: string;
  liveStatusText?: string;
  viewerCount?: number;
  category?: string;
};

const API_BASE_URL = "https://api.kick.com/public/v1/";
const WORKER_URL = "https://kick-auth-worker.mikemones2584.workers.dev";

const webInfoCache = new Map<string, { info: { profileImageUrl?: string; username?: string }; timestamp: number }>();
const WEB_INFO_CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function fetchChannelStatus(slug: string): Promise<KickChannelStatus | undefined> {
  const normalizedSlug = slug.trim().toLowerCase();
  if (!normalizedSlug) {
    return undefined;
  }

  // Optimization: Fetch API first. Only fetch web info if absolutely necessary (missing image).
  const payload = await performAuthorizedRequest(
      new URL(`channels?slug=${encodeURIComponent(normalizedSlug)}`, API_BASE_URL)
  ).then((res) => res.json() as Promise<KickChannelResponse>);

  if (process.env.KICK_DEBUG === "1") {
    console.info("Kick API payload:", JSON.stringify(payload, undefined, 2));
  }

  const entry = payload.data?.[0];

  if (!entry) {
    return undefined;
  }

  const stream = entry.stream ?? undefined;

  const isLive = stream?.is_live === true;
  const liveStatusText =
    entry.stream_title || stream?.session_title || stream?.session_status || (isLive ? "live" : undefined);

  // Try to get category/game
  const category = (entry.category?.name || stream?.category?.name) ?? undefined;

  let profileImageUrl =
    coalesceImageUrl(entry.user?.profile_picture) ||
    coalesceImageUrl(stream?.thumbnail) ||
    coalesceImageUrl(stream?.thumbnail_url) ||
    coalesceImageUrl(entry.banner_picture);

  let displayName = entry.user?.name ?? entry.slug ?? normalizedSlug;

  // Fallback: If no image found in API OR no display name found, try the web worker proxy
  // The API often returns lowercase slug as name for offline users, or missing profile pics.
  // We want the proper capitalized username.
  // Also, if the API returned a banner image but no profile picture, we want to try to get the real profile picture from the web proxy.
  const isNameMissing = !entry.user?.name;
  const apiHasProfilePic = !!coalesceImageUrl(entry.user?.profile_picture);

  // Only consider it a "bad name" if it's missing. 
  // If it matches the slug but is lowercase, that might just be their name, 
  // but usually Kick names are capitalized. We'll stick to fetching if it looks like a raw slug.
  const isRawSlugName = entry.user?.name === normalizedSlug;

  if ((profileImageUrl == null) || isNameMissing || isRawSlugName || !apiHasProfilePic) {
      const webInfo = await fetchWebChannelInfo(normalizedSlug);
      if (webInfo) {
          if (webInfo.profileImageUrl && ((profileImageUrl == null) || !apiHasProfilePic)) {
              profileImageUrl = webInfo.profileImageUrl;
          }
          // Always prefer web username if API gave us nothing or just the slug
          if (webInfo.username) {
               // If API name is missing, or if API name equals slug (lowercase), prefer web username (Capitalized)
               if (isNameMissing || isRawSlugName) {
                   displayName = webInfo.username;
               }
          }
      }
  }

  return {
    isLive,
    displayName,
    profileImageUrl,
    liveStatusText,
    viewerCount: typeof stream?.viewer_count === "number" ? stream.viewer_count : undefined,
    category,
  };
}

function coalesceImageUrl(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (value && typeof value === "object" && "url" in value && typeof (value as { url?: unknown }).url === "string") {
    return (value as { url: string }).url;
  }

  return undefined;
}

async function performAuthorizedRequest(url: URL): Promise<Response> {
  let accessToken = await getAccessToken();

  let response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 401) {
    // Try one refresh
    try {
        await refreshCurrentTokens();
        accessToken = await getAccessToken();
        
        response = await fetch(url, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        });
    } catch (e) {
        console.error("[KICK_API] Token refresh failed during 401 retry", e);
        throw e;
    }
  }

  if (response.status === 401) {
    console.error("[KICK_API] 401 Unauthorized");
    throw new KickCredentialsMissingError("Kick API request unauthorized. Re-run the credential helper to refresh tokens.");
  }

  if (!response.ok) {
    console.error(`[KICK_API] Request failed: ${response.status} ${response.statusText}`);
    throw new Error(`Kick API request failed with status ${response.status}`);
  }

  return response;
}

async function fetchWebChannelInfo(slug: string): Promise<{ profileImageUrl?: string; username?: string } | undefined> {
  const now = Date.now();
  const cached = webInfoCache.get(slug);
  if (
    cached &&
    cached.timestamp <= now &&
    (now - cached.timestamp) <= WEB_INFO_CACHE_TTL
  ) {
      return cached.info;
  }

  try {
    // Use the worker proxy to bypass Cloudflare protections on the V2 API
    const response = await fetch(`${WORKER_URL}/proxy/channel/${encodeURIComponent(slug)}`);

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as KickWebChannelResponse;
    const info = {
        profileImageUrl: coalesceImageUrl(payload.user?.profile_pic),
        username: payload.user?.username ?? undefined
    };
    
    webInfoCache.set(slug, { info, timestamp: now });
    return info;
  } catch (error) {
    console.warn(`Failed to fetch web channel info for ${slug}:`, error);
    return undefined;
  }
}

type KickChannelResponse = {
  data?: KickChannelEntry[];
};

type KickChannelEntry = {
  slug?: string | null;
  channel_description?: string | null;
  banner_picture?: string | { url?: string | null } | string | null;
  stream?: KickStream | null;
  stream_title?: string | null;
  user?: { name?: string | null; profile_picture?: string | { url?: string | null } | null };
  category?: { name?: string | null };
};

type KickStream = {
  url?: string | null;
  key?: string | null;
  is_live?: boolean;
  is_mature?: boolean;
  language?: string | null;
  start_time?: string | null;
  viewer_count?: number | null;
  session_title?: string | null;
  session_status?: string | null;
  thumbnail?: string | { url?: string | null } | null;
  thumbnail_url?: string | { url?: string | null } | null;
  category?: { name?: string | null };
};

type KickWebChannelResponse = {
  user?: {
    profile_pic?: string | { url?: string | null } | null;
    username?: string | null;
  } | null;
};
