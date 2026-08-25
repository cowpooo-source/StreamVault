/**
 * Jellyfin API Adapter for browser-side calls
 * Makes direct requests from browser to user's Jellyfin server
 */
export const JellyfinAdapter = {
  async authenticate(baseUrl, username, password) {
    const response = await fetch(`${baseUrl}/Users/AuthenticateByName`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ Username: username, Pw: password }),
    });

    if (!response.ok) {
      throw new Error("Auth failed");
    }

    const data = await response.json();
    return { accessToken: data.AccessToken, userId: data.UserId };
  },

  async getLibrary(
    baseUrl,
    token,
    userId,
    { type = "Movie,Series", startIndex = 0, limit = 50 } = {}
  ) {
    const url = `${baseUrl}/Items?IncludeItemTypes=${type}&startIndex=${startIndex}&limit=${limit}&fields=PrimaryImageAspectRatio,MediaSources`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Emby-Authorization": `MediaBrowser UserId="${userId}",Token="${token}"`,
      },
    });

    const data = await response.json();
    return { items: data.Items || [], total: data.TotalRecordCount };
  },

  async getStreamUrl(baseUrl, token, userId, itemId) {
    const response = await fetch(`${baseUrl}/Videos/${itemId}/main.m3u8`, {
      method: "GET",
      headers: {
        "X-Emby-Authorization": `MediaBrowser UserId="${userId}",Token="${token}"`,
      },
    });

    return { url: response.url };
  },

  async getLiveTVChannels(baseUrl, token, userId) {
    const response = await fetch(`${baseUrl}/LiveTv/Channels`, {
      method: "GET",
      headers: {
        "X-Emby-Authorization": `MediaBrowser UserId="${userId}",Token="${token}"`,
      },
    });

    const data = await response.json();
    return { channels: data.Items || [] };
  },

  async getLiveTVPrograms(baseUrl, token, userId, channelId, startTime, endTime) {
    const url = `${baseUrl}/LiveTv/Programs?ChannelIds=${channelId}&StartTime=${startTime}&EndTime=${endTime}&fields=MediaSources`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "X-Emby-Authorization": `MediaBrowser UserId="${userId}",Token="${token}"`,
      },
    });

    const data = await response.json();
    return { programs: data.Items || [] };
  },
};
