# Google Analytics (GA4) Product Analytics Plan

## Objective
Use Google Analytics 4 as a product-analytics layer for the `streamvault` SPA so we can understand user behavior, feature usage, and playback funnels without replacing the existing local `/analytics` dashboard.

## Scope
GA4 will track only product events from the frontend.

In scope:
- SPA navigation and feature usage
- Playback starts and playback errors
- Connection setup and validation outcomes
- Feedback submission counts and categories
- EPG usage and other engagement events

Out of scope:
- CPU, RAM, disk, bandwidth, and portal latency
- Admin-only operational reporting
- Raw feedback content
- Server-side request logs and health data

The existing `/analytics` dashboard in `stalker-proxy` remains the source of truth for system health and operational metrics.

## Identity Rules
- Use a stable authenticated `user_id` only for signed-in users.
- Do not map guest/session IDs directly to GA4 `user_id`.
- For guests, use an internal pseudonymous client/session identifier for local correlation only.
- If a user later signs in, start using the authenticated `user_id` from that point forward.

## Event Taxonomy
Use a small, consistent event set instead of mirroring every internal log.

Recommended events:
- `play_item`
  - Fired when a user starts Live TV, a movie, or a series episode.
  - Parameters: `content_type`, `content_id`, `content_title`, `provider_type`, `category`, `is_favorite`
- `portal_connect`
  - Fired when a connection is created or validated.
  - Parameters: `provider_type`, `success`, `latency_ms`, `error_code`
- `playback_error`
  - Fired when playback fails or a resolved stream cannot start.
  - Parameters: `content_type`, `error_code`, `provider_type`, `latency_ms`
- `user_feedback`
  - Fired when feedback is submitted.
  - Parameters: `feedback_type`, `has_text`, `source_screen`
- `epg_interaction`
  - Fired when the user opens or filters the TV guide.
  - Parameters: `action`, `screen`, `provider_type`
- `search`
  - Fired when the user performs a search.
  - Parameters: `query_length`, `result_count`, `source_screen`

Keep event names stable and avoid adding new ones unless they support a clear report or funnel.

## Privacy Rules
- Do not send raw feedback text to GA4.
- Do not send passwords, tokens, MAC addresses, portal URLs, stream URLs, or other credentials.
- Truncate or bucket freeform values where possible.
- Keep error details in the local backend if they are useful for debugging.
- Treat GA4 as aggregated product telemetry, not a support database.

## Data Model
Use a small event wrapper in the frontend so GA4 is not called directly from UI code.

Minimum event payload shape:
```txt
event_name
user_id?               // authenticated users only
client_id
screen
content_type
content_id
provider_type
latency_ms
error_code
timestamp
```

Recommended local-only metadata:
- raw feedback message
- full error stack
- portal URL
- MAC address
- playback debug details

## Implementation Plan

### Phase 1: Frontend Event Wrapper
1. Add `VITE_GA_MEASUREMENT_ID` to the frontend environment.
2. Create a single `trackAnalytics(eventName, payload)` helper in `streamvault`.
3. Send the event to GA4 only if GA is enabled.
4. Keep local app tracking intact for any features that already depend on it.

Frontend should call the helper from:
- playback start/resume points
- connection creation and validation flows
- feedback form submission
- EPG interactions
- search actions

### Phase 2: GA4 Configuration
Register only the dimensions and metrics needed for the product reports.

Suggested custom dimensions:
- `provider_type`
- `content_type`
- `source_screen`
- `feedback_type`
- `error_code`

Suggested custom metrics:
- `latency_ms`
- `result_count`

### Phase 3: Reporting
Build a few practical GA4 explorations:
- top content types played
- connection success vs failure rate
- playback error frequency by provider type
- feedback submission trends
- search usage and result quality

Do not attempt to recreate the full `/analytics` dashboard in GA4.

## Existing Local Analytics Remains
Keep these in `stalker-proxy`:
- request and visitor tracking
- portal health and latency
- bandwidth totals
- cache and system metrics
- feedback storage and admin review

GA4 should complement that data, not replace it.

## Verification
1. Confirm the GA tag loads once in the SPA.
2. Confirm events appear in GA4 DebugView and Realtime.
3. Confirm sensitive fields are omitted from outbound events.
4. Confirm the local analytics dashboard still works unchanged.

## Effort Estimate
- Frontend event wrapper: 2-3 hours
- GA4 configuration and validation: 1-2 hours
- Optional backend relay: 1 hour
- Total: 3-6 hours

## Execution Checklist
1. Add `GA_MEASUREMENT_ID` to the frontend environment.
2. Implement a single `trackAnalytics(eventName, payload)` helper in `streamvault`.
3. Wire the helper into playback, connection, feedback, EPG, and search flows.
4. Keep raw feedback and operational metrics in the local backend only.
5. Register the GA4 custom dimensions and metrics needed for reports.
6. Validate events in GA4 DebugView and Realtime.
7. Confirm the local `/analytics` dashboard still works unchanged.
