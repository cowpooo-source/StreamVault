// VAST ad parsing and handling utilities
import { fetchTextWithTimeout, vastProxyUrl, resolveUrl, mergeTrackers, parseVastTime } from "./utils.js";

export function collectVastTrackers(root) {
  const trackers = {};
  const push = (event, url) => {
    if (!event || !url) return;
    (trackers[event] ||= []).push(url);
  };
  root.querySelectorAll("Impression").forEach((node) => push("impression", node.textContent?.trim()));
  root.querySelectorAll("TrackingEvents Tracking").forEach((node) => push((node.getAttribute("event") || "").toLowerCase(), node.textContent?.trim()));
  return trackers;
}

export async function fetchVastAd(vastUrl, videoEl, depth = 0, inheritedTrackers = {}) {
  if (!vastUrl || depth > 2) return null;
  try {
    const VAST_FETCH_TIMEOUT_MS = 3500;
    // Keep this below Chrome's user-gesture autoplay window.
    let xml = await fetchTextWithTimeout(vastUrl, VAST_FETCH_TIMEOUT_MS);
    if (!xml) xml = await fetchTextWithTimeout(vastProxyUrl(vastUrl), VAST_FETCH_TIMEOUT_MS);
    if (!xml) return null;
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) {
      const fallbackXml = await fetchTextWithTimeout(vastProxyUrl(vastUrl), VAST_FETCH_TIMEOUT_MS);
      if (!fallbackXml || fallbackXml === xml) return null;
      const fallbackDoc = new DOMParser().parseFromString(fallbackXml, "application/xml");
      if (fallbackDoc.querySelector("parsererror")) return null;
      return parseVastDocument(fallbackDoc, vastUrl, videoEl, depth, inheritedTrackers);
    }

    return parseVastDocument(doc, vastUrl, videoEl, depth, inheritedTrackers);
  } catch {
    return null;
  }
}

export function parseVastDocument(doc, vastUrl, videoEl, depth, inheritedTrackers) {
  const wrapper = doc.querySelector("Wrapper");
  if (wrapper) {
    const nextUrl = resolveUrl(wrapper.querySelector("VASTAdTagURI")?.textContent, vastUrl);
    if (!nextUrl) return null;
    const wrapperTrackers = collectVastTrackers(wrapper);
    return fetchVastAd(nextUrl, videoEl, depth + 1, mergeTrackers(inheritedTrackers, wrapperTrackers));
  }

  const inline = doc.querySelector("InLine");
  const linear = inline?.querySelector("Linear");
  if (!inline || !linear) return null;

  const mediaFiles = [...linear.querySelectorAll("MediaFile")]
    .map((node) => ({
      url: node.textContent?.trim(),
      type: node.getAttribute("type") || "",
    }))
    .filter((file) => file.url);

  if (!mediaFiles.length) return null;

  const media = mediaFiles.find((file) => file.type.startsWith("video/") && (!videoEl?.canPlayType || videoEl.canPlayType(file.type))) ||
    mediaFiles.find((file) => file.type.startsWith("video/")) ||
    mediaFiles[0];

  const trackers = mergeTrackers(inheritedTrackers, collectVastTrackers(inline));
  return {
    title: inline.querySelector("AdTitle")?.textContent?.trim() || "Sponsored Ad",
    mediaUrl: resolveUrl(media.url, vastUrl),
    mediaType: media.type,
    clickThrough: resolveUrl(inline.querySelector("VideoClicks > ClickThrough")?.textContent, vastUrl),
    duration: parseVastTime(linear.querySelector("Duration")?.textContent),
    skipOffset: linear.getAttribute("skipoffset") ? parseVastTime(linear.getAttribute("skipoffset")) : null,
    trackers,
  };
}
