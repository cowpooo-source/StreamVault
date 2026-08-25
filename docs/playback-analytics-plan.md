# Playback Analytics Plan

## Goal

Track how much playable media each user watches per hour and per day, then use that data for summaries, limits, and recommendations.

This should be separate from watch history. Watch history answers "what should I continue watching?" Playback analytics answers "how much did this user actually watch?"

## Phase 1: Data Model

Create a playback session model.

Core fields:

```txt
session_id
user_id or guest_id
connection_id
item_id
item_type: live | vod | series | catchup
item_name
group_name
started_at
last_seen_at
ended_at
watched_seconds
media_duration
position
completed
device_id
```

Add summary storage after raw sessions are reliable.

```txt
user_id
bucket_start
bucket_type: hour | day
live_seconds
vod_seconds
series_seconds
catchup_seconds
total_seconds
updated_at
```

## Phase 2: Backend API

Add playback-specific endpoints instead of overloading `/api/track`.

Recommended endpoints:

```txt
POST /api/playback/session
POST /api/playback/heartbeat
POST /api/playback/end
GET  /api/playback/summary?range=today|week|month
```

Implementation target:

- Start in `stalker-proxy`, because the frontend already posts analytics there via `/api/track`.
- Mirror the schema in `streamvault-worker/migrations` if the Cloudflare Worker becomes the primary backend.

## Phase 3: Client Tracking

Add tracking around `Player.jsx`.

Client behavior:

- Create a `sessionId` when playback starts.
- Send a heartbeat every 30 to 60 seconds while media is actually playing.
- Send a final update on pause, stop, source change, player close, or page unload.
- Use `navigator.sendBeacon` for unload where possible.
- Queue failed heartbeats locally and retry later.

Avoid counting:

- Buffering time.
- Paused time.
- Duplicate heartbeat intervals.
- Replayed intervals for the same session.

## Phase 4: Server Aggregation

Start by storing raw session and heartbeat rows.

Then aggregate:

- Hourly totals per user.
- Daily totals per user.
- Totals by content type.
- Top categories/groups.
- Peak watch hours.
- Most watched item types.

Aggregation options:

- Update summaries on each heartbeat. This is simple but causes more writes.
- Aggregate periodically. This is cleaner for D1/Worker deployments.
- Query raw sessions on demand for the MVP.

## Phase 5: UI

Add a small Watch Time section in Settings or the admin analytics dashboard.

Initial metrics:

```txt
Today: 2h 35m
This week: 14h 10m
Live TV: 70%
Movies: 20%
Series: 10%
Most watched category: Sports
Peak watch hour: 8 PM
```

Keep this out of the main player at first so playback UI stays focused.

## Phase 6: Suggestions

Use playback analytics to drive suggestions:

- Continue unfinished VOD and Series items.
- Recommend categories watched most this week.
- Prioritize favorite Live TV channels near the user's usual watch hour.
- Suggest shorter movies or episodes if the user usually watches under 45 minutes.
- Warn or throttle if guest/free users hit daily watch limits.
- Estimate bandwidth from watch time when bitrate is known or sampled.

## MVP Scope

Build this first:

1. Add a `playback_sessions` table.
2. Add `POST /api/playback/heartbeat`.
3. Send client heartbeat from `Player.jsx` every 60 seconds.
4. Add a daily summary endpoint.
5. Show "watched today" and "watched this week" in Settings.

After the MVP is stable, add hourly charts, recommendation scoring, and plan-limit rules.

## Notes

- Do not rely on localStorage as the source of truth for cross-device user reporting.
- LocalStorage is useful only as an offline queue for failed heartbeats.
- Use a `sessionId` and interval timestamps to prevent double counting.
- Keep raw analytics rows long enough to debug aggregation errors.
