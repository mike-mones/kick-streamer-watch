import streamDeck, {
  action,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent,
  KeyDownEvent,
  KeyUpEvent,
  SendToPluginEvent,
  KeyAction,
  DialAction,
} from "@elgato/streamdeck";
import { checkStreamerStatus, type StatusResult } from "./kickStatus";
import { getProcessedImage, generateCollageSvg } from "../utils/imageUtils.js";
import { wrapText } from "../utils/textUtils.js";
import { invalidateCredentialsCache, logout } from "./kickOfficialApi.js";
import { startAuthFlow } from "../auth/authManager.js";

type LiveStatusSettings = {
  channel?: string;
};

type LoginPayload = {
  action: string;
};

type ActionState = {
  channels: string[];
  pollTimer?: NodeJS.Timeout;
  lastStatus: "live" | "offline" | "error" | "unknown" | "not_found";
  alertEndTime: number;
  keyDownTime: number;
  alertTimer?: NodeJS.Timeout;
  lastResult?: StatusResult;
  alertToggleState: boolean;
  // For multi-channel collage
  multiResults?: StatusResult[];
  alertingChannels: Set<string>;
};

@action({ UUID: "com.kick-streamer-watch.live-status" })
export class LiveStatusAction extends SingletonAction<LiveStatusSettings> {
  private states = new Map<string, ActionState>();

  private getState(context: string): ActionState {
    let state = this.states.get(context);
    if (!state) {
      state = {
        channels: [],
        lastStatus: "unknown",
        alertEndTime: 0,
        keyDownTime: 0,
        alertToggleState: false,
        alertingChannels: new Set(),
      };
      this.states.set(context, state);
    }
    return state;
  }

  override async onSendToPlugin(ev: SendToPluginEvent<LoginPayload, LiveStatusSettings>): Promise<void> {
    if (ev.payload.action === "login") {
      streamDeck.logger.info("Starting auth flow...");
      try {
        await startAuthFlow();
        invalidateCredentialsCache();
        streamDeck.logger.info("Auth flow completed.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        streamDeck.logger.error(`Auth flow failed: ${msg}`);
      }
    } else if (ev.payload.action === "logout") {
      streamDeck.logger.info("Logging out...");
      try {
        await logout();
        streamDeck.logger.info("Logged out.");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        streamDeck.logger.error(`Logout failed: ${msg}`);
      }
    }
  }

  override async onWillAppear(ev: WillAppearEvent<LiveStatusSettings>): Promise<void> {
    streamDeck.logger.debug(`[LiveStatus] onWillAppear: ${ev.action.id} settings: ${JSON.stringify(ev.payload.settings)}`);
    await this.configureChannel(ev.payload.settings.channel, ev);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LiveStatusSettings>): Promise<void> {
    streamDeck.logger.debug(`[LiveStatus] onDidReceiveSettings: ${ev.action.id} settings: ${JSON.stringify(ev.payload.settings)}`);
    await this.configureChannel(ev.payload.settings.channel, ev);
  }

  override async onWillDisappear(ev: WillDisappearEvent): Promise<void> {
    streamDeck.logger.debug(`[LiveStatus] onWillDisappear: ${ev.action.id}`);
    const state = this.states.get(ev.action.id);
    if (state) {
      this.clearTimers(state);
      this.states.delete(ev.action.id);
    }
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    streamDeck.logger.debug(`[LiveStatus] onKeyDown: ${ev.action.id}`);
    const state = this.getState(ev.action.id);
    state.keyDownTime = Date.now();
  }

  override async onKeyUp(ev: KeyUpEvent<LiveStatusSettings>): Promise<void> {
    streamDeck.logger.debug(`[LiveStatus] onKeyUp: ${ev.action.id}`);
    const state = this.getState(ev.action.id);
    
    // Open Stream(s) if Live
    if (state.channels.length === 1) {
        if (state.lastResult?.isLive && state.lastResult.displayName) {
            await streamDeck.system.openUrl(`https://kick.com/${state.lastResult.displayName}`);
        }
    } else if (state.channels.length > 1 && state.multiResults) {
        const liveChannels = state.multiResults.filter(r => r.isLive && r.displayName);
        for (const channel of liveChannels) {
            if (channel.displayName) {
                // Add a small delay between opening multiple streams to avoid popup blocking and user shock
                await new Promise((resolve) => setTimeout(resolve, 500));
                await streamDeck.system.openUrl(`https://kick.com/${channel.displayName}`);
            }
        }
    }
  }

  private async configureChannel(
    channelValue: string | undefined,
    ev: WillAppearEvent<LiveStatusSettings> | DidReceiveSettingsEvent<LiveStatusSettings>,
  ): Promise<void> {
    const context = ev.action.id;
    const state = this.getState(context);
    
    const channels = (channelValue ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
      .slice(0, 4); // Enforce max 4 channels

    if (channels.length === 0) {
      state.channels = [];
      this.clearTimers(state);
      await ev.action.setTitle("No Channel");
      await ev.action.setImage("imgs/actions/red.png");
      return;
    }

    // Check if channels changed (simple length check or join check)
    if (channels.join(",") === state.channels.join(",") && state.pollTimer) {
      return;
    }

    state.channels = channels;
    await this.refresh(context, ev.action);
    this.startPolling(context, ev.action);
  }

  private startPolling(context: string, actionObj: KeyAction<LiveStatusSettings> | DialAction<LiveStatusSettings>) {
    const state = this.getState(context);
    if (state.pollTimer) clearInterval(state.pollTimer);

    state.pollTimer = setInterval(() => {
      this.refresh(context, actionObj).catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        streamDeck.logger.error(`Error refreshing ${state.channels.join(",")}: ${msg}`);
      });
    }, 60000); // Poll every 1 minute for better responsiveness
  }

  private clearTimers(state: ActionState) {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = undefined;
    }
    if (state.alertTimer) {
      clearInterval(state.alertTimer);
      state.alertTimer = undefined;
    }
  }

  private async refresh(context: string, actionObj: KeyAction<LiveStatusSettings> | DialAction<LiveStatusSettings>): Promise<void> {
    const state = this.getState(context);
    if (state.channels.length === 0) return;

    try {
      let result: StatusResult;
      const oldMultiResults = state.multiResults;

      if (state.channels.length === 1) {
        // Single channel mode
        result = await checkStreamerStatus(state.channels[0]);
        state.multiResults = [result];
      } else {
        // Multi channel mode
        const allResults = await Promise.all(
          state.channels.map(async (channel) => {
            try {
              return await checkStreamerStatus(channel);
            } catch (_e: unknown) {
              return { isLive: false, status: "error", displayName: channel } as StatusResult;
            }
          })
        );
        
        // Filter out non-existent channels
        const validResults = allResults.filter(r => r.status !== "not_found");

        if (validResults.length === 0 && allResults.length > 0) {
             // All channels are invalid - do not clear existing state.channels
             await actionObj.setImage("imgs/actions/red.png");
             await actionObj.setTitle("Not Found");
             return;
        }

        // IMPORTANT INVARIANT:
        // Do NOT mutate state.channels in this block (e.g. by removing invalid channels).
        //
        // Elsewhere (notably in render()), the code infers "single-channel" vs "multi-channel"
        // behavior from state.channels: if there is exactly one channel, the single-channel
        // rendering path is used; if there are multiple channels, the multi-channel/collage
        // path is used.
        //
        // In multi-channel mode we build a *synthetic* aggregated StatusResult from
        // validResults. If we were to shrink state.channels here so that only one valid
        // channel remains, render() would see a single channel in state.channels but still
        // receive this synthetic multi-channel result and treat it as if it were a normal
        // single-channel result. That mismatch breaks assumptions in the single-channel
        // rendering code (titles, images, and status are no longer per-channel).
        //
        // If you need to change how invalid channels are handled long-term, update both this
        // code and the single-/multi-channel branching logic in render() together so they
        // stay consistent.
        //
        // state.channels = validChannels;

        state.multiResults = validResults;

        // For collage mode, we construct a synthetic result
        const anyLive = validResults.some(r => r.isLive);
        
        // Collect images for collage
        // Use a transparent placeholder if image is missing to maintain count/layout
        const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="; // Black pixel
        
        const collageItems = validResults.map(r => ({ 
            image: r.rawBase64Image || placeholder, 
            isLive: r.isLive 
        }));
        
        // For multi-channel, we pass the names to be rendered on the SVG itself
        // Only show names of LIVE streamers
        const liveResults = validResults.filter(r => r.isLive);
        let names = liveResults.length > 0 
            ? liveResults.map(r => r.displayName).join("\n") 
            : "";
        
        // Special case: If we only have 1 valid result in a multi-channel setup (because others are invalid),
        // we might want to show its name even if offline, because it looks like a single tile.
        if (validResults.length === 1 && names === "") {
             names = validResults[0].displayName || "";
        }

        const collageSvg = generateCollageSvg(collageItems, { title: names });

        result = {
            isLive: anyLive,
            status: anyLive ? "live" : "offline",
            displayName: names, // Used for alerting logic, but not for display title anymore
            base64Image: collageSvg,
            // Use first live channel for other metadata, or first channel
            viewerCount: validResults.reduce((acc, r) => acc + (r.viewerCount || 0), 0),
            category: validResults.find(r => r.isLive)?.category || validResults[0]?.category
        };
      }
      
      // Check for Offline -> Live transition
      // This handles both single-channel transitions and multi-channel per-streamer transitions
      const newAlertingChannels = new Set<string>();
      
      if (oldMultiResults && state.multiResults) {
          // Prefer matching by index (and mapping back to the original channel slug)
          // when the arrays are aligned, and only fall back to displayName matching
          // when we cannot safely rely on indices.
          const indicesAligned =
            oldMultiResults.length === state.multiResults.length &&
            state.channels.length === state.multiResults.length;
          
          state.multiResults.forEach((newR, index) => {
              let oldR: StatusResult | undefined;
              let stableIdentifier: string | undefined;

              if (indicesAligned) {
                  // When everything is aligned, use the same index for both the old
                  // result and the original channel slug as the stable identifier.
                  oldR = oldMultiResults[index];
                  stableIdentifier = state.channels[index];
              } else {
                  // Fallback: try to find the previous result by displayName.
                  oldR = oldMultiResults.find(o => o.displayName === newR.displayName);
                  // We may not be able to reliably map back to a slug here, so we
                  // fall back to displayName as the best available identifier.
                  stableIdentifier = newR.displayName;
              }

              if (oldR && !oldR.isLive && newR.isLive && stableIdentifier) {
                  newAlertingChannels.add(stableIdentifier);
              }
          });
      } else if (state.channels.length === 1 && state.lastStatus === "offline" && result.status === "live") {
          newAlertingChannels.add(state.channels[0]);
      }

      if (newAlertingChannels.size > 0) {
          state.alertingChannels = newAlertingChannels;
          this.startAlert(state, context, actionObj);
      }

      state.lastStatus = result.status;
      state.lastResult = result;

      // Only render if not alerting (alert loop handles rendering)
      if (!state.alertTimer) {
        await this.render(result, context, actionObj);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      streamDeck.logger.error(`Error checking status for ${state.channels.join(",")}: ${msg}`);
      await actionObj.setImage("imgs/actions/red.png");
      await actionObj.setTitle(`ERROR`);
    }
  }

  private startAlert(state: ActionState, context: string, actionObj: KeyAction<LiveStatusSettings> | DialAction<LiveStatusSettings>) {
    if (state.alertTimer) clearInterval(state.alertTimer);
    
    state.alertEndTime = Date.now() + 60000; // 1 minute alert
    state.alertToggleState = true;

    state.alertTimer = setInterval(async () => {
      if (Date.now() > state.alertEndTime) {
        if (state.alertTimer) clearInterval(state.alertTimer);
        state.alertTimer = undefined;
        if (state.lastResult) await this.render(state.lastResult, context, actionObj);
        return;
      }

      state.alertToggleState = !state.alertToggleState;
      if (state.lastResult) {
        await this.render(state.lastResult, context, actionObj, true);
      }
    }, 1000); // Toggle every second
  }

  private async render(
    result: StatusResult,
    context: string,
    actionObj: KeyAction<LiveStatusSettings> | DialAction<LiveStatusSettings>,
    isAlerting = false
  ) {
    const state = this.getState(context);
    
    // Determine Image
    let imageSource = result.base64Image;
    let title = "";

    if (state.channels.length > 1) {
        // Multi-channel title logic
        // We now bake the text into the image (collage), so we clear the title here
        title = "";
    } else {
        // Single channel logic
        const displayName = result.displayName ?? (state.channels.length > 0 ? state.channels[0] : "Unknown");

        if (result.status === "error" || !result.displayName) {
            title = `${state.channels[0] || "Unknown"}\nNot Found`;
            await actionObj.setTitle(title);
            await actionObj.setImage("imgs/actions/red.png");
            return;
        }

        if (result.status !== "live") {
            const statusText = result.status === "not_found" ? "NOT FOUND" : result.status.toUpperCase();
            title = `${displayName}\n${statusText}`;
        } else {
            // Single Streamer & Live -> Show Category
            // We now bake this into the image for better control (smaller category text)
            // So we clear the title here
            title = "";
            
            // Re-generate image with text overlay
            if (result.rawBase64Image) {
                const category = result.category || "Live";
                imageSource = getProcessedImage(result.rawBase64Image, true, {
                    title: displayName,
                    subtitle: wrapText(category, 15) // Slightly wider wrap for smaller font
                });
            }
        }
    }

    await actionObj.setTitle(title);
    
    if (isAlerting && state.alertToggleState) {
        // Flash effect: Show alternate image or just color
        if (state.channels.length > 1 && state.multiResults) {
             // Re-generate collage with flash
             const placeholder = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
             const collageItems = state.multiResults.map((r) => ({
                 image: r.rawBase64Image || placeholder,
                 isLive: r.isLive,
                 isFlashing: r.displayName ? state.alertingChannels?.has(r.displayName) : false
             }));
             
             // Pass the same title (names) to the flashing collage
             const liveResults = state.multiResults.filter(r => r.isLive);
             const names = liveResults.length > 0 ? liveResults.map(r => r.displayName).join("\n") : "";
             
             imageSource = generateCollageSvg(collageItems, { title: names });
        } else {
             // Single channel flash logic
             imageSource = "imgs/actions/green.png";
        }
    } else if (!imageSource) {
        imageSource = result.isLive ? "imgs/actions/green.png" : "imgs/actions/red.png";
    }

    await actionObj.setImage(imageSource);
  }
}