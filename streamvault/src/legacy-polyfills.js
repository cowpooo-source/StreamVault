import "fast-text-encoding";
import ResizeObserverPolyfill from "resize-observer-polyfill";

// Legacy browsers need a real global ResizeObserver, not just the ponyfill export.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverPolyfill;
}
