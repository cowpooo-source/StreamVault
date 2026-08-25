function normalizeCatchupRequest(input = {}) {
  const start = Number(input.start ?? input.utc);
  const end = Number(input.end);
  const duration = Number(input.duration || (Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0));
  return {
    channelId: input.channelId ?? input.channel_id ?? null,
    cmd: input.programCmd || input.cmd || null,
    start: Number.isFinite(start) ? start : null,
    end: Number.isFinite(end) ? end : null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    programId: input.programId ?? input.program_id ?? null,
  };
}

function catchupVariants(input) {
  const value = normalizeCatchupRequest(input);
  const base = { start: value.start, end: value.end };
  const variants = [base];
  if (value.start != null && value.duration != null) variants.push({ utc: value.start, duration: value.duration });
  if (value.programId != null) variants.push({ archive: 1, program_id: value.programId });
  return variants;
}

module.exports = { catchupVariants, normalizeCatchupRequest };
