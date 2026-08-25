# Manual release checklist

Use this checklist after the automated suite passes. It covers workflows that still require human judgment before media production release.

## Release identity

- [ ] Release commit and tag recorded
- [ ] Environment name and deployed checkout recorded
- [ ] Database backup path and restore test recorded
- [ ] Rollback commit, environment backup, and Nginx backup recorded

## Visual and UX checks

- [ ] Marketing homepage looks correct on desktop and mobile
- [ ] Login and Turnstile look correct
- [ ] Setup screen connection forms look correct
- [ ] Marketing CTA opens https://media.portalheaven.stream/app
- [ ] Legacy notice links to media and shows the retirement date

## Account and provider checks

- [ ] One real Xtream connection loads
- [ ] One real Stalker connection loads
- [ ] One M3U connection loads
- [ ] Existing migrated user retains expected connections and account role
- [ ] New registration receives the free role
- [ ] Free and guest limits are enforced
- [ ] Ads are absent for regular, pro, and admin accounts

## Playback checks

- [ ] One live stream starts and remains stable
- [ ] One VOD item starts and seeks
- [ ] Audio/subtitle menu looks correct when tracks exist
- [ ] Direct playback does not use /stream unless fallback is explicitly required

## Navigation and routing checks

- [ ] Disconnect returns to https://media.portalheaven.stream/app
- [ ] Switch connection returns to https://media.portalheaven.stream/app
- [ ] Logout returns to https://media.portalheaven.stream/app
- [ ] Legacy host remains isolated from media database writes

## Error and operations checks

- [ ] No unexpected browser console errors
- [ ] No unexpected 401, 403, 429, 456, or 502 responses
- [ ] CPU and memory remain stable during concurrent playback
- [ ] Monitoring and alerting are working
- [ ] Rollback procedure has been rehearsed

## Test record

~~~text
Commit:
Environment:
Browser:
Tester:
Date:
Result:
Notes:
~~~
