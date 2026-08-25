/**
 * Normalize Unicode-decorated text to plain ASCII for connection detection.
 */
export function normalizeUnicode(text) {
  return text
    // Mathematical Monospace A-Z (U+1D670-U+1D689) and a-z (U+1D68A-U+1D6A3)
    .replace(/[\u{1D670}-\u{1D689}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D670 + 0x41))
    .replace(/[\u{1D68A}-\u{1D6A3}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D68A + 0x61))
    // Mathematical Bold A-Z (U+1D400-U+1D419) and a-z (U+1D41A-U+1D433)
    .replace(/[\u{1D400}-\u{1D419}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D400 + 0x41))
    .replace(/[\u{1D41A}-\u{1D433}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D41A + 0x61))
    // Mathematical Bold Italic A-Z (U+1D468-U+1D481) and a-z (U+1D482-U+1D49B)
    .replace(/[\u{1D468}-\u{1D481}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D468 + 0x41))
    .replace(/[\u{1D482}-\u{1D49B}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D482 + 0x61))
    // Mathematical Sans-Serif A-Z (U+1D5A0-U+1D5B9) and a-z (U+1D5BA-U+1D5D3)
    .replace(/[\u{1D5A0}-\u{1D5B9}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D5A0 + 0x41))
    .replace(/[\u{1D5BA}-\u{1D5D3}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D5BA + 0x61))
    // Mathematical Sans-Serif Bold A-Z (U+1D5D4-U+1D5ED) and a-z (U+1D5EE-U+1D607)
    .replace(/[\u{1D5D4}-\u{1D5ED}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D5D4 + 0x41))
    .replace(/[\u{1D5EE}-\u{1D607}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D5EE + 0x61))
    // Mathematical Italic A-Z (U+1D434-U+1D44D) and a-z (U+1D44E-U+1D467)
    .replace(/[\u{1D434}-\u{1D44D}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D434 + 0x41))
    .replace(/[\u{1D44E}-\u{1D467}]/gu, c => String.fromCharCode(c.codePointAt(0) - 0x1D44E + 0x61))
    // Normalize arrow separators to colon
    .replace(/[➩➜➔→►⇒⟹]/g, ':')
    // Strip box-drawing characters
    .replace(/[╠╣║╗╔╚╝╬╩╦├┤│┐┘└┌┬┴┼─═]/g, '')
    // Strip enclosed alphanumerics (regional/circled letters used as decorators)
    .replace(/[\u{1F150}-\u{1F169}\u{1F170}-\u{1F18F}\u{1F190}-\u{1F1AC}]/gu, '')
    // Strip keycap digit sequences (e.g., 1️⃣) and decorators like ❖
    .replace(/[\d]️?⃣/gu, '')
    .replace(/[❖]/g, '');
}

/**
 * Detect connections (Stalker, Xtream, M3U) from raw text.
 * Returns an array of detected connection objects.
 */
export function detectFromText(text) {
  text = normalizeUnicode(text);
  const results = [];

  const portalPattern = /https?:\/\/[^\s"'<>]+\/(?:stalker_portal\/)?c\/?/gi;
  const macPattern = /([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}/g;

  const lines = text.split("\n");
  let blocks = [], cur = [];
  const portalTestRe = /https?:\/\/[^\s"'<>]+\/(?:stalker_portal\/)?c\/?/i;
  for (const line of lines) {
    if (portalTestRe.test(line) && cur.length > 0) { blocks.push(cur.join("\n")); cur = []; }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join("\n"));
  if (blocks.length <= 1) blocks = [text];

  const usedMacs = new Set();
  for (const block of blocks) {
    const bp = block.match(portalPattern) || [];
    portalPattern.lastIndex = 0;
    const bm = block.match(macPattern) || [];
    macPattern.lastIndex = 0;

    const serialMatch = block.match(/(?:seri[ae]l(?:\s*(?:number|num|#))?|s\/n|sn)\s*(?:=>|[:=\s])\s*([A-Za-z0-9_-]+)/i);
    const serial = serialMatch ? serialMatch[1] : "";

    const deviceId2Match = block.match(/(?:device[\s_.-]*id[\s_.-]*2|deviceid2|device_id_2)\s*(?:=>|[:=\s])\s*([A-Za-z0-9_-]+)/i);
    let deviceId2 = deviceId2Match ? deviceId2Match[1] : "";

    const deviceIdLine = block.match(/(?:device[\s_.-]*id|deviceid|device_id)(?![\s_.-]*2)\s*(?:=>|[:=\s])\s*(.+)/i);
    let deviceId = "";
    if (deviceIdLine) {
      const tokens = deviceIdLine[1].trim().split(/\s+/);
      deviceId = tokens.reduce((best, t) => t.replace(/[^A-Za-z0-9]/g, "").length > best.length ? t.replace(/[^A-Za-z0-9]/g, "") : best, "");
    }

    if (deviceId && !deviceId2) deviceId2 = deviceId;

    if (bp.length && bm.length) {
      const portal = bp[0].replace(/\/+$/, "");
      const mac = bm[0];
      if (!usedMacs.has(mac)) {
        usedMacs.add(mac);
        results.push({ type: "stalker", server: portal, mac, serial, deviceId, deviceId2, label: `Stalker · ${mac.slice(-5)}` });
      }
    } else if (bm.length) {
      bm.forEach(mac => { if (!usedMacs.has(mac)) { usedMacs.add(mac); results.push({ type: "stalker", server: "", mac, serial, deviceId, deviceId2, label: `MAC · ${mac}` }); } });
    }
  }

  const xtreamPattern = /https?:\/\/[^\s"'<>:]+:\d+\/get\.php\?username=([^&]+)&password=([^&\s]+)/gi;
  let xm;
  while ((xm = xtreamPattern.exec(text)) !== null) {
    const url = new URL(xm[0]);
    results.push({ type: "xtream", server: `${url.protocol}//${url.host}`, user: xm[1], pass: xm[2], label: `Xtream · ${xm[1]}` });
  }

  const xtreamApi = /https?:\/\/[^\s"'<>:]+:\d+\/player_api\.php\?username=([^&]+)&password=([^&\s]+)/gi;
  while ((xm = xtreamApi.exec(text)) !== null) {
    const url = new URL(xm[0]);
    if (!results.find(r => r.type === "xtream" && r.server === `${url.protocol}//${url.host}` && r.user === xm[1])) {
      results.push({ type: "xtream", server: `${url.protocol}//${url.host}`, user: xm[1], pass: xm[2], label: `Xtream · ${xm[1]}` });
    }
  }

  const bareXtream = /https?:\/\/([^\s"'<>:]+:\d+)\/live\/([^/\s]+)\/([^/\s]+)/gi;
  while ((xm = bareXtream.exec(text)) !== null) {
    const server = `http://${xm[1]}`;
    if (!results.find(r => r.type === "xtream" && r.user === xm[2])) {
      results.push({ type: "xtream", server, user: xm[2], pass: xm[3], label: `Xtream · ${xm[2]}` });
    }
  }

  const hostMatch = text.match(/(?:host|server|url|portal)\s*(?:=>|[:=])\s*(https?:\/\/[^\s,;]+)/gi);
  const userMatch = text.match(/(?:username|user|login)\s*(?:=>|[:=])\s*([^\s,;]+)/gi);
  const passMatch = text.match(/(?:password|pass)\s*(?:=>|[:=])\s*([^\s,;]+)/gi);
  if (hostMatch && userMatch && passMatch) {
    const hosts = hostMatch.map(m => m.replace(/^[^:=]*[=:]\s*/i, "").trim());
    const users = userMatch.map(m => m.replace(/^[^:=]*[=:]\s*/i, "").trim());
    const passes = passMatch.map(m => m.replace(/^[^:=]*[=:]\s*/i, "").trim());
    const count = Math.min(hosts.length, users.length, passes.length);
    for (let i = 0; i < count; i++) {
      const server = hosts[i].replace(/\/+$/, "");
      if (!results.find(r => r.type === "xtream" && r.server === server && r.user === users[i])) {
        results.push({ type: "xtream", server, user: users[i], pass: passes[i], label: `Xtream · ${users[i]}` });
      }
    }
  }

  const m3uPattern = /https?:\/\/[^\s"'<>]+\.m3u8?(?:\?[^\s"'<>]*)?/gi;
  const m3us = text.match(m3uPattern) || [];
  m3us.forEach(url => {
    if (!results.find(r => r.type === "m3u" && r.url === url)) {
      results.push({ type: "m3u", url, label: `M3U · ${url.split("/").pop()?.slice(0, 20)}` });
    }
  });

  const m3uGet = /https?:\/\/[^\s"'<>]+\/get\.php\?[^\s"'<>]*/gi;
  const m3uGets = text.match(m3uGet) || [];
  m3uGets.forEach(url => {
    if (!results.find(r => r.url === url)) {
      results.push({ type: "m3u", url, label: `M3U · get.php` });
    }
  });

  return results;
}