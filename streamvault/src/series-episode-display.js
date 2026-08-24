export function toSeriesEpisodeDisplay(episodes, isXtream = false) {
  return (Array.isArray(episodes) ? episodes : []).map((episode, index) => {
    const value = episode && typeof episode === "object" ? episode : { num: episode };
    const num = value.num ?? value.episode_num ?? value.series_number ?? value.id ?? index + 1;
    const title = typeof value.title === "string" && value.title.trim() ? value.title : `Episode ${num}`;
    return {
      num: isXtream ? (value.num || value.id || index + 1) : num,
      label: title,
    };
  });
}
