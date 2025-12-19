import * as fs from "fs/promises";
import * as path from "path";
import {
  fetchChannelStatus,
  KickCredentialsMissingError,
  type KickChannelStatus,
} from "./kickOfficialApi.js";
import { getLocalProfileImage, getProcessedImage } from "../utils/imageUtils.js";

export type StatusResult = {
  isLive: boolean;
  status: "live" | "offline" | "error" | "not_found";
  displayName?: string;
  thumbnailUrl?: string;
  base64Image?: string;
  rawBase64Image?: string;
  viewerCount?: number;
  title?: string;
  category?: string;
};

export async function checkStreamerStatus(username: string): Promise<StatusResult> {
  const channel = username.trim();

  if (!channel) {
    return {
      isLive: false,
      status: "error",
    };
  }

  try {
    const channelStatus = await fetchChannelStatus(channel);

    if (!channelStatus) {
      return {
        isLive: false,
        status: "not_found",
        displayName: channel,
      };
    }

    return await buildStatusResult(channel, channelStatus);
  } catch (error: unknown) {
    if (error instanceof KickCredentialsMissingError) {
      console.error(`[KICK_STATUS] Credentials missing: ${error.message}`);
    } else if (error instanceof Error) {
      console.error(`[KICK_STATUS] Failed to fetch status for ${channel}: ${error.message}\n${error.stack}`);
    } else {
      console.error(`[KICK_STATUS] Failed to fetch status for ${channel}:`, error);
    }

    return {
      isLive: false,
      status: "error",
      displayName: channel,
    };
  }
}

async function buildStatusResult(slug: string, channelStatus: KickChannelStatus): Promise<StatusResult> {
  const { isLive, displayName, profileImageUrl, viewerCount, liveStatusText, category } = channelStatus;

  const localImagePath = profileImageUrl ? await getLocalProfileImage(slug, profileImageUrl) : undefined;
  
  let rawBase64Image: string | undefined;
  if (localImagePath) {
      try {
          const fileBuffer = await fs.readFile(localImagePath);
          const ext = path.extname(localImagePath).substring(1);
          const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
          rawBase64Image = `data:${mime};base64,${fileBuffer.toString('base64')}`;
      } catch (e) {
          console.warn(`Failed to read local image ${localImagePath}`, e);
      }
  }

  const displayImage = rawBase64Image
    ? getProcessedImage(rawBase64Image, isLive)
    : undefined;

  return {
    isLive,
    status: isLive ? "live" : "offline",
    displayName,
    thumbnailUrl: displayImage ?? profileImageUrl,
    base64Image: displayImage,
    rawBase64Image,
    viewerCount,
    title: liveStatusText,
    category,
  };
}
