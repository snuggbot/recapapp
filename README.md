# Stream Recap

Public source snapshot for the Stream Recap project.

Stream Recap turns Twitch and Kick broadcasts into searchable, timestamped
recaps. The optional NoPixel profile adds canonical participant names, event
types, and Reddit research configuration.

## Reddit access

Reddit research is **disabled by default**. Enable it only after Reddit grants
Data API access and the required credentials are configured locally:

```env
REDDIT_RESEARCH_ENABLED=true
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_USER_AGENT=StreamRecap/1.0 by your_reddit_username
REDDIT_ALLOW_PUBLIC_SEARCH=false
```

The NoPixel profile is configured for the following public communities:

- r/GTARP
- r/LivestreamFail
- r/xqcow

Reddit posts are treated as unverified research leads. Recap events must still
be checked against transcript, VOD, and screenshot evidence. The application
does not post, comment, vote, message users, moderate communities, access
private data, or profile Reddit users.

## Local development

```bash
npm ci
npm run dev
```

For the server/API workflow:

```bash
npm start
```

Create a local `.env` file from `.env.example`. Never commit credentials or
private generated job data.

## Public review scope

This repository is a sanitized source snapshot for API-access review. It does
not include environment files, transcription-job history, generated frame
archives, or runtime dependencies.

Project information page:

- https://itsnugg.xyz/stream-recap
