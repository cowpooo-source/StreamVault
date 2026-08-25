export function classifyStreamUrl(url, type = "live") {
  const value = String(url || "");
  const [path, query = ""] = value.toLowerCase().split("?");
  const extension = path.split("/").pop()?.split(".").pop() || "";
  const params = new URLSearchParams(query);

  if (path.endsWith(".m3u8")) return "hls";
  if (path.endsWith(".ts") || params.get("extension") === "ts") return "ts";
  if (["mp4", "mkv", "avi", "mov", "webm", "mp3", "aac"].includes(extension)) return "file";
  if (params.get("extension") === "mp4") return "file";
  if (type === "live" || path.includes("/live/")) return "ts";
  return "unknown";
}
