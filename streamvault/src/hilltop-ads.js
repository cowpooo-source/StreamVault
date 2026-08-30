export const HILLTOP_POPUNDER_SELECTOR = 'script[data-sv-hilltop-popunder="true"]';

export function injectHilltopPopunder({ documentRef = globalThis.document, url } = {}) {
  if (!documentRef?.head || !url) return null;
  if (documentRef.head.querySelector(HILLTOP_POPUNDER_SELECTOR)) return null;

  const script = documentRef.createElement("script");
  script.dataset.svHilltopPopunder = "true";
  script.settings = {};
  script.src = url;
  script.async = true;
  script.referrerPolicy = "no-referrer-when-downgrade";
  documentRef.head.appendChild(script);
  return script;
}
