import { mergeJellyfinEPG } from "../../epg.js";

/**
 * JellyfinEPGAdapter - maps Jellyfin LiveTV data into TimelineGrid shape.
 * Thin wrapper around mergeJellyfinEPG.
 */
export default function JellyfinEPGAdapter({ channels, programs }) {
  return mergeJellyfinEPG(channels, programs);
}
