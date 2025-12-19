import streamDeck from "@elgato/streamdeck";
import { LiveStatusAction } from "./actions/live-status-action.js";
import { setCredentialStorage } from "./auth/storageProvider.js";
import { StreamDeckCredentialStorage } from "./auth/streamDeckStorage.js";

// Optionally enable debug logging.
// Note: The Stream Deck SDK logger expects a string log level (e.g. "info"),
// so we intentionally use the string literal here instead of an enum type.
streamDeck.logger.setLevel("info");

// Configure storage for plugin environment
setCredentialStorage(new StreamDeckCredentialStorage());

// Register our custom actions
streamDeck.actions.registerAction(new LiveStatusAction());

// Connect to the Stream Deck
streamDeck.connect();