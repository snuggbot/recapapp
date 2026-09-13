# StreamRecap Roadmap

This is a working list of release-readiness work. Prototype behavior can remain file-based while the product and workflow are being validated.

## Release readiness: storage, privacy, and accounts

- [ ] Add authentication and user/project ownership.
- [ ] Move generated project metadata out of `src/data/` into a database.
- [ ] Move screenshots and rendered clips to object storage.
- [ ] Keep downloaded audio/video in temporary worker storage only; delete it after processing.
- [ ] Stop duplicating screenshots between `public/` and `dist/`.
- [ ] Add retention policies by plan (free, creator, pro, studio).
- [ ] Add a complete “delete project and all artifacts” operation.
- [ ] Clean completed and failed transcription jobs after a retention period.
- [ ] Add per-user quotas, concurrency limits, retry limits, and spend limits.
- [ ] Keep provider keys server-side and replace development fallbacks before launch.
- [ ] Document provider data handling, copyright/takedown procedures, and user content deletion.

## Release readiness: shared source caching and deduplication

- [ ] Canonicalize source identity by platform and VOD ID rather than raw URL.
  - Twitch: VOD ID
  - YouTube: video ID
  - Kick: canonical VOD identity
- [ ] Create a shared `source_asset` record for each canonical public source.
- [ ] Cache the expensive shared artifacts:
  - transcript
  - normalized transcript segments
  - event candidates/timeline
  - screenshots/thumbnails
  - source metadata
- [ ] Use a processing-version key so prompt/model/pipeline changes invalidate old results safely.
- [ ] Deduplicate in-flight jobs: if two users request the same source while it is processing, attach both users to one job.
- [ ] Serve completed shared results to later users without repeating transcription or recap generation.
- [ ] Keep user-specific data separate from shared artifacts:
  - bookmarks
  - theme/color
  - edits
  - clip selections
  - private notes
- [ ] Default uploaded/private videos to private cache scope; only share public-source results when permitted.
- [ ] Track cache hits, cache misses, processing cost, and source popularity.
- [ ] Bill expensive processing only on a cache miss; charge separately for user-specific rendering or visual analysis.
- [ ] Add cache invalidation for deleted/unavailable sources and pipeline/model revisions.

## Product quality

- [x] Preserve original transcript segments and source IDs (in-memory segment index used for start/end resolution).
- [x] Have the model return source segment references instead of arbitrary timestamps.
- [x] Validate descriptions against transcript/frame evidence (evidence excerpt + named-entity containment checks; downgrades unsupported events).
- [ ] Persist transcript segment source IDs into saved recaps (currently in-memory only).
- [ ] Remove synthetic coverage events from the trusted workflow (default off; `TRUSTED_MODE=true` skips tail/gap fills — implemented, needs default flip after eval).
- [ ] Distinguish transcript-supported, anchor-supported, approximate, and human-verified results in the UI (server writes `validation`/`endMode`/`startMode`; badges added, dedicated filter panel pending).
- [ ] Add an AI-draft review flow for correcting timestamps and descriptions.
- [x] Add a TRUSTED_MODE environment switch (skips synthetic coverage/tail fills) and surface description-validation badges in the UI.
- [ ] Add clip candidate ranking and user feedback capture.
- [ ] Add an evaluation corpus and accuracy metrics before claiming precision.

## Clip generation and processing

- [ ] Separate analysis, screenshot, and clip-render jobs.
- [ ] Generate screenshots selectively and asynchronously.
- [ ] Render clips only after approval or explicit user request.
- [ ] Checkpoint transcription chunks so retries resume instead of restarting a whole VOD.
- [ ] Add plan-specific limits for analysis minutes, frame count, rendered clip minutes, and storage retention.
- [ ] Add cost telemetry per job: provider usage, CPU time, bytes downloaded, frames, storage, retries, and rendered minutes.

## Release gate

Do not open public self-serve access until authentication, quotas, persistent storage, job deduplication, deletion, and provider spend limits are in place.
