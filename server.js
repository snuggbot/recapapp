import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawn } from 'child_process';
import http from 'http';
import { fileURLToPath } from 'url';
import { collectRedditEvidence, purgeRedditCacheForStream, searchCommunityThreads } from './lib/redditResearch.js';
import { fetchCharacterDossier, getStreamLoreDossiers, augmentProfileWithDossiers, formatLorePromptDossier } from './lib/fandomResearch.js';

// ---- Minimal .env loader (zero dependencies) ----
const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
try {
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && m[1] && m[2] && !(m[1] in process.env)) {
        let val = m[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        process.env[m[1]] = val;
      }
    }
  }
} catch {}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));

// ---- Owner-only guard ----
// Every read/browse endpoint stays public. Anything that mutates data or costs
// money (add stream / sync / delete) requires the owner key from .env.
// Guests can browse the whole site but can never trigger paid AI processing.
const OWNER_KEY = process.env.OWNER_KEY || '';
const requireOwner = (req, res, next) => {
  // Open mode: with no OWNER_KEY configured, everyone is effectively the owner.
  // Set OWNER_KEY in .env to re-enable the guest lock at any time.
  if (!OWNER_KEY) return next();
  const provided = String(req.get('x-owner-key') || req.query.key || '');
  if (!provided || provided !== OWNER_KEY) {
    return res.status(401).json({ error: 'This action is owner-only. Guests can browse, but not edit.' });
  }
  next();
};

const SRC_DATA_DIR = path.join(__dirname, 'src', 'data');
const DATA_DIR = path.join(__dirname, 'data');
for (const d of [DATA_DIR, SRC_DATA_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

const POV_CONFIG_FILE = path.join(SRC_DATA_DIR, 'povConfig.json');
const PROFILES_DIR = path.join(__dirname, 'src', 'profiles');

function loadProfile(profileId = 'generic') {
  const safeId = String(profileId || 'generic').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'generic';
  const filePath = path.join(PROFILES_DIR, `${safeId}.json`);
  try {
    const profile = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return profile?.id ? profile : JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, 'generic.json'), 'utf-8'));
  } catch {
    return { id: 'generic', label: 'Generic stream recap', version: 1, aliases: {}, eventTypes: [], importanceSignals: [], subreddits: [], promptRules: [] };
  }
}

// fetch with automatic timeout so a dead network call can never hang the request
async function fetchT(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Native HTTP avoids undici's five-minute headers timeout for the internal
// background generation request, which can legitimately wait hours for ffmpeg
// and local transcription to finish.
function postInternalGenerate(body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      hostname: '127.0.0.1',
      port: Number(PORT) || 3002,
      path: '/api/generate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        const status = response.statusCode || 500;
        resolve({ ok: status >= 200 && status < 300, status, text: async () => text });
      });
      response.on('error', reject);
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Internal generation request timed out after ${Math.round(timeoutMs / 60000)} minutes`));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

// ---------- Model / LLM ----------
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const RECAP_MODEL = process.env.RECAP_MODEL || 'openai/gpt-4o-mini';
const VISION_VALIDATION_MODEL = process.env.VISION_VALIDATION_MODEL || 'openai/gpt-4o';
const VISION_VALIDATION_ENABLED = String(process.env.VISION_VALIDATION_ENABLED || 'true').toLowerCase() !== 'false';
const VISION_VALIDATION_MAX_EVENTS = Math.max(0, Math.min(50, Number(process.env.VISION_VALIDATION_MAX_EVENTS || 12) || 12));

function getOpenRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const authFile = process.env.PI_AUTH_FILE || path.join(os.homedir(), '.pi', 'agent', 'auth.json');
    const auth = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
    if (auth.openrouter?.key) return auth.openrouter.key;
  } catch {}
  return null;
}

const EVENT_CATEGORIES = ['general','gameplay','story','moment','drama','social','music','tech','sports','chat','other'];
const VALID_CATEGORIES = new Set([...EVENT_CATEGORIES, 'lore', 'crime', 'joke']);
const GENERIC_VIDEO_NAMES = new Set(['live', 'watch', 'shorts', 'short', 'embed', 'video', 'videos']);

const GENERATE_SYSTEM_PROMPT = `You are a careful stream recap writer. Given stream metadata, VOD chapters, and/or raw notes, produce a structured timestamped recap of the broadcast.

Rules:
- Output ONLY valid JSON. No markdown fences, no commentary.
- Chronological events, approximately TARGET_EVENT_COUNT of them, each with. TARGET_EVENT_COUNT is calculated from stream duration and evidence density; hit it without padding or duplicating nearby moments.
  - "title": short summary (<=60 chars)
  - "description": one concise sentence, 8-18 words, <=140 chars; lead with the action or outcome and omit filler, setup, and repeated names.
  - "seconds": integer offset into the stream/VOD (>= 0)
  - Optional "startSegmentId": the exact [seg-xxxx] id of the FIRST transcript segment that belongs to this moment. When provided, the server resolves the precise start time from that segment's timestamp instead of trusting a guessed number. Prefer startSegmentId over seconds whenever you can map the moment to transcript lines.
  - "endSeconds": integer offset when the moment ends (>= seconds). When you know a natural boundary for the moment, provide it; when unsure, end it shortly after the described action/reaction settles (typically 15-180 seconds after start). Never exceed the known duration.
  - Optional "endSegmentId": the exact [seg-xxxx] id of the LAST transcript segment that belongs to this moment. When provided, the server resolves the precise end time from that segment's timestamp instead of trusting a guessed number. Prefer endSegmentId over endSeconds whenever you can map the moment to transcript lines.
  - "category": one of ${JSON.stringify(EVENT_CATEGORIES)}
  - Optional "participants": an array of canonical person/character names explicitly supported by the source. Omit it when no participant is supported rather than guessing.
  - Optional "economy": for moments with crypto, cash, or vehicle purchases/trades: {"asset":"string","action":"buy|sell|payout|fine|trade","amount":"string or null","price":"string or null"}
  - Optional "policeIncident": for police chases, stops, or crime encounters: {"outcome":"escaped|arrested|hospitalized|citation","officers":["..."],"charges":["..."],"fine":"string or null"}
  - "isMajor": true only for the standout moments (at most ~25% of events)
- Timestamps: use ONLY the CONFIRMED_TIMESTAMPS values when they are given — they are real clock offsets derived from chapters, clips, or notes. When no CONFIRMED_TIMESTAMPS are given, the offsets are approximate: write believable, IRREGULAR timestamps with varied natural gaps (never uniform or round marks such as 00:05:00, 00:10:00 — use e.g. 00:04:17, 01:12:38). Never exceed the known duration. If rough notes state offsets, preserve them.
- When a TIMED_TRANSCRIPT is provided, use it as the primary factual source. Every event must be supported by the transcript near its timestamp. Do not invent products, guests, gameplay, giveaways, chat reactions, quotes, or outcomes that are not supported. Do not use generic filler such as "the chat explodes" unless the source actually supports it.
- When COMMUNITY_HIGHLIGHT_SIGNALS are provided, treat them as crowd-sourced indicators of the stream's most important scenes, climaxes, and drama. Search the TIMED_TRANSCRIPT or CHAPTERS to locate where these community moments occurred, include them in the recap, and flag them as "isMajor": true.
- When a FOCUS_FILTER is provided, apply it to event selection. In strict mode, omit events that do not satisfy the filter; in discovery mode, prioritize matches but retain strongly supported major moments.
- Never interpret a casual "good night", "bye", or farewell to chat as the end of the stream. Only use "stream ends", "final moments", "winding down", or "farewell" when the event is within the final 5% of the known duration AND surrounding evidence clearly indicates the broadcast is ending.
- For each event with transcript support, include "evidence": a short verbatim phrase or faithful excerpt from the transcript (<=180 chars) and "confidence": "high" or "medium". Never fabricate a quote.
- The top level must be exactly:
{"title":"<recap title>","summary":"<2-3 sentence overview>","days":{"1":{"dayNumber":1,"title":"<day title>","summary":"<overview>","events":[{...}]}}}`;

function sanitizeCategory(raw) {
  const c = String(raw || '').toLowerCase().trim();
  return VALID_CATEGORIES.has(c) ? c : 'general';
}

function formatTimestamp(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function calculateTargetEventCount(context = {}) {
  const durationSeconds = Number(context.lengthSeconds || 0);
  if (!durationSeconds) return 12;
  // Roughly one meaningful moment per 20 minutes, with a small evidence-density
  // boost for streams that have many independent clips/chapters. This replaces
  // the old model-driven tendency to stop around 20 events on every VOD length.
  const durationBaseline = Math.ceil(durationSeconds / (20 * 60));
  const evidenceBoost = Math.min(6, Math.floor((context.chapters?.length || 0) / 10));
  return Math.max(8, Math.min(48, durationBaseline + evidenceBoost));
}

function parseJsonLoose(text) {
  if (!text) return null;
  let clean = text.trim();
  const fence = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) clean = fence[1].trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function callLLM(systemPrompt, userPrompt, timeoutMs = 120000, options = {}) {
  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    throw new Error('No OpenRouter API key configured. Set OPENROUTER_API_KEY (or run pi once to populate ~/.pi/agent/auth.json).');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const model = options.model || RECAP_MODEL;
    const body = {
      model,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens || 6000,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: options.userContent ?? userPrompt }
      ]
    };
    if (model.startsWith('openai/') || model.startsWith('anthropic/')) {
      body.response_format = { type: 'json_object' };
    }

    const res = await fetchT(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`LLM error (${res.status}): ${json?.error?.message || JSON.stringify(json).slice(0, 300)}`);
    }
    const content = json?.choices?.[0]?.message?.content || '';
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Stream metadata fetchers ----------

const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function twitchGql(query, variables) {
  const res = await fetchT('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: {
      'Client-Id': TWITCH_CLIENT_ID,
      'User-Agent': UA,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  if (!res.ok) throw new Error(`Twitch GQL ${res.status}`);
  return res.json();
}

async function twitchFetchVideos(login) {
  const q = `query($login: String!) { user(login: $login) { id displayName videos(first: 6, type: ARCHIVE) { edges { node { id title createdAt lengthSeconds } } } } }`;
  const json = await twitchGql(q, { login });
  const user = json?.data?.user;
  const edges = user?.videos?.edges || [];
  return {
    id: user?.id,
    displayName: user?.displayName || login,
    videos: edges.map(e => e.node).filter(Boolean)
  };
}

async function twitchFetchVideoMeta(videoId) {
  try {
    const q = `query ($id: ID!) { video(id: $id) { id title lengthSeconds createdAt owner { id displayName login } } }`;
    const json = await twitchGql(q, { id: String(videoId) });
    const video = json?.data?.video;
    if (!video) return null;
    return { videoId, title: video.title || '', lengthSeconds: video.lengthSeconds || 0, createdAt: video.createdAt || '', owner: video.owner };
  } catch {
    return null;
  }
}

// Optional Twitch app token: unlocks REAL timestamp evidence (community highlight clips carry vod_offset).
// Set TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET to enable. If absent, this degrades gracefully to no clips.
let cachedTwitchToken = null;
let cachedTwitchTokenExp = 0;
async function getTwitchAppToken() {
  const cid = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (!cid || !secret) return null;
  if (cachedTwitchToken && Date.now() < cachedTwitchTokenExp) return cachedTwitchToken;
  try {
    const body = new URLSearchParams({ client_id: cid, client_secret: secret, grant_type: 'client_credentials' }).toString();
    const res = await fetchT('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) return null;
    const d = await res.json();
    cachedTwitchToken = d.access_token || null;
    cachedTwitchTokenExp = Date.now() + ((d.expires_in || 3600) * 1000) - 60000;
    return cachedTwitchToken;
  } catch {
    return null;
  }
}

async function fetchTwitchClips(broadcasterId, videoId, startedAt, endedAt, limit = 60) {
  const token = await getTwitchAppToken();
  if (!token) return [];
  try {
    const url = new URL('https://api.twitch.tv/helix/clips');
    if (broadcasterId) url.searchParams.set('broadcaster_id', broadcasterId);
    else if (videoId) url.searchParams.set('video_id', videoId);
    url.searchParams.set('first', String(Math.min(limit, 100)));
    // Clips default to most-viewed; bound by the VOD's time window to get THIS stream's clips.
    if (startedAt) url.searchParams.set('started_at', startedAt);
    if (endedAt) url.searchParams.set('ended_at', endedAt);
    const res = await fetchT(url, { headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}`, 'User-Agent': UA } });
    if (!res.ok) return [];
    const body = await res.json();
    const clips = (body.data || [])
      .filter(c => !videoId || String(c.video_id || '') === String(videoId))
      .map(c => ({ title: String(c.title || 'Highlight').slice(0, 120), seconds: Math.max(0, Math.floor(Number(c.vod_offset) || 0)) }))
      .filter(c => c.seconds > 0)
      .sort((a, b) => a.seconds - b.seconds);
    // TIME-BUCKET sampling: keep at most `limit` clips spread evenly across the
    // WHOLE stream (not the clip list), so a front-loaded clip set still yields
    // anchors in every hour of a long broadcast.
    if (clips.length > 1) {
      const maxKeep = Math.min(limit, 34);
      if (clips.length <= maxKeep) return clips;
      const span = clips[clips.length - 1].seconds - clips[0].seconds;
      const sampled = [];
      const seen = new Set();
      if (span > 0) {
        for (let b = 0; b < maxKeep; b++) {
          const target = clips[0].seconds + span * (b / (maxKeep - 1));
          let best = clips[0], bestD = Infinity;
          for (const c of clips) {
            const d = Math.abs(c.seconds - target);
            if (d < bestD) { bestD = d; best = c; }
          }
          if (!seen.has(best.seconds)) {
            seen.add(best.seconds);
            sampled.push(best);
          }
        }
      }
      if (sampled.length < 2) return clips.slice(0, maxKeep);
      return sampled.sort((a, b) => a.seconds - b.seconds);
    }
    return clips.slice(0, Math.min(limit, 34));
  } catch {
    return [];
  }
}

// Chat-velocity spikes: poll recent chat during the stream; speed bursts = moments worth timestamping.
// Requires the Twitch app token; otherwise returns [].
async function fetchChatSpikeSeconds(broadcasterId, durationSeconds, vodStartAt, limit = 16) {
  const token = await getTwitchAppToken();
  if (!token || !broadcasterId) return [];
  try {
    const span = Math.max(durationSeconds || 0, 0);
    if (span <= 0) return [];
    const nowMs = Date.now();
    const vodStartMs = vodStartAt ? Date.parse(vodStartAt) : (nowMs - span * 1000);
    if (isNaN(vodStartMs)) return [];
    const numWindows = Math.min(14, Math.max(4, Math.ceil(span / 1500)));
    const chunkSec = span / numWindows;
    // Fetch windows in PARALLEL with a tight timeout so this never serializes into minutes.
    const windows = Array.from({ length: numWindows }, (_, i) => {
      const t0 = vodStartMs + i * chunkSec * 1000;
      const t1 = Math.min(t0 + chunkSec * 1000, vodStartMs + span * 1000);
      const url = `https://api.twitch.tv/helix/chat/messages?broadcaster_id=${broadcasterId}&first=100&started_at=${encodeURIComponent(new Date(t0).toISOString())}&ended_at=${encodeURIComponent(new Date(t1).toISOString())}`;
      return fetchT(url, { headers: { 'Client-Id': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}`, 'User-Agent': UA } }, 12000)
        .then(res => (res.ok ? res.json() : null))
        .then(body => (body?.data || []).map(msg => {
          const sentAt = new Date(msg.timestamp || 0).getTime();
          if (!sentAt) return null;
          return Math.max(0, Math.min(span, Math.floor((sentAt - vodStartMs) / 1000)));
        }).filter(Boolean))
        .catch(() => []);
    });
    const points = (await Promise.all(windows)).flat();
    // cluster: 90s buckets with >= 3 messages = a spike; dedupe & clamp
    const bucket = {};
    points.forEach(s => { const b = Math.floor(s / 90); bucket[b] = (bucket[b] || 0) + 1; });
    const spikes = Object.entries(bucket)
      .filter(([, count]) => count >= 3)
      .map(([b]) => ({ seconds: Math.min(Math.floor(b * 90) + 45, span - 1), title: 'Chat activity spike' }))
      .sort((a, b) => a.seconds - b.seconds)
      .slice(0, limit);
    return spikes;
  } catch {
    return [];
  }
}

async function youtubeFetch(videoId) {
  try {
    const oembed = await (await fetchT(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { headers: { 'User-Agent': UA } })).json();
    let channel = oembed.author_name || '';
    let lengthSeconds = 0;
    let createdAt = '';
    // oEmbed does not include duration or upload date. yt-dlp does, and is
    // already required for the screenshot pipeline, so use it as the source
    // of truth for full-stream coverage and the visible stream date.
    try {
      const metaResult = await runKill('yt-dlp', ['--dump-single-json', '--skip-download', '--no-warnings', '--no-playlist', `https://www.youtube.com/watch?v=${videoId}`], 45000);
      if (metaResult.code === 0) {
        const meta = JSON.parse(metaResult.stdout || '{}');
        lengthSeconds = Number(meta.duration) || 0;
        const uploadDate = String(meta.upload_date || '');
        if (/^\d{8}$/.test(uploadDate)) {
          createdAt = `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00Z`;
        }
        channel = meta.channel || meta.uploader || channel;
      }
    } catch {}
    const chapters = [];
    try {
      const page = await (await fetchT(`https://www.youtube.com/watch?v=${videoId}`, { headers: { 'User-Agent': UA } })).text();
      // description-based chapter markers (also covers most VODs)
      const descMatch = page.match(/"shortDescription":\s*"((?:\\.|[^"\\])*)"/);
      if (descMatch) {
        const desc = descMatch[1].replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\//g, '/');
        const lines = desc.split('\n');
        for (const line of lines) {
          const m = line.match(/^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(.+)$/);
          if (m) {
            const secs = (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
            chapters.push({ seconds: secs, title: m[4].trim() });
          }
        }
      }
    } catch {}
    const transcript = await fetchYouTubeTranscript(videoId);
    return { videoId, title: oembed.title || '', channel, lengthSeconds, createdAt, chapters, transcript };
  } catch {
    return null;
  }
}

function decodeCaptionText(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseVttTranscript(text) {
  const lines = String(text || '').split(/\r?\n/);
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)\s+-->\s+(\d{2}:\d{2}:\d{2}(?:\.\d{3})?)/);
    if (!match) continue;
    const parseTime = (value) => {
      const parts = value.replace(',', '.').split(':');
      return Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]);
    };
    const start = parseTime(match[1]);
    const end = parseTime(match[2]);
    const words = [];
    for (let j = i + 1; j < lines.length && lines[j].trim(); j++) words.push(lines[j].trim());
    const textValue = decodeCaptionText(words.join(' '));
    if (textValue && (!segments.length || segments[segments.length - 1].text !== textValue || start > segments[segments.length - 1].end + 2)) {
      segments.push({ start, end, text: textValue });
    }
  }
  return segments;
}

// Compress a long timed transcript into compact windows while preserving coverage
// across the entire VOD. This avoids feeding only the first few minutes to the LLM.
function compressTranscriptSegments(segments, bucketSeconds = 30) {
  const buckets = new Map();
  for (const segment of segments || []) {
    const bucket = Math.floor(Number(segment.start || 0) / bucketSeconds);
    const existing = buckets.get(bucket) || [];
    if (segment.text && existing[existing.length - 1] !== segment.text) existing.push(segment.text);
    buckets.set(bucket, existing);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucket, texts]) => `  - ${formatTimestamp(bucket * bucketSeconds)} — ${texts.join(' ')}`);
}

// Merge raw transcript segments (Whisper/VTT) into compact lines that keep precise
// per-line start/end times, so the model can reference exact boundaries by id.
function mergeTranscriptSegments(segments, maxSpanSeconds = 20, maxChars = 400) {
  const merged = [];
  let current = null;
  const pushCurrent = () => { if (current && current.text) merged.push(current); current = null; };
  for (const raw of segments || []) {
    const seg = {
      start: Number(raw.start) || 0,
      end: Number(raw.end) || ((Number(raw.start) || 0) + 5),
      text: decodeCaptionText(raw.text || '')
    };
    if (!seg.text) continue;
    if (!current) { current = { ...seg }; continue; }
    const span = Math.max(0, seg.end - current.start);
    const chars = current.text.length + seg.text.length + 1;
    if (span > maxSpanSeconds || chars > maxChars) pushCurrent();
    if (!current) { current = { ...seg }; continue; }
    current.text = `${current.text} ${seg.text}`;
    current.end = seg.end;
  }
  pushCurrent();
  return merged;
}

// Build labeled transcript lines like "[seg-0042] 00:12:00→00:12:14 ..." plus an
// id→{start,end,text} index used to resolve exact end boundaries after generation.
function buildSegmentLines(segments, maxChars = 240000) {
  const merged = mergeTranscriptSegments(segments);
  const lines = [];
  const index = [];
  let chars = 0;
  for (let i = 0; i < merged.length; i++) {
    const seg = merged[i];
    const id = `seg-${String(i + 1).padStart(4, '0')}`;
    const line = `  [${id}] ${formatTimestamp(seg.start)}→${formatTimestamp(seg.end)} ${String(seg.text).trim()}`;
    if (chars + line.length > maxChars) break;
    lines.push(line);
    chars += line.length;
    index.push({ id, start: seg.start, end: seg.end, text: String(seg.text).trim() });
  }
  return { lines, index };
}

async function fetchYouTubeTranscript(videoId) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamrecap-captions-'));
  try {
    const sourceUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const result = await runKill('yt-dlp', [
      '--skip-download',
      '--write-auto-subs',
      '--sub-langs', 'en,en-US,en.*',
      '--sub-format', 'vtt',
      '--no-warnings',
      '--no-playlist',
      '--output', path.join(tempDir, '%(id)s.%(ext)s'),
      sourceUrl
    ], 60000);
    if (result.code !== 0) return [];
    const vttFile = fs.readdirSync(tempDir).find(file => file.endsWith('.vtt'));
    if (!vttFile) return [];
    return parseVttTranscript(fs.readFileSync(path.join(tempDir, vttFile), 'utf8'));
  } catch {
    return [];
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

async function kickFetch(slug) {
  try {
    const res = await fetchT(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
    if (res.ok) {
      const data = await res.json();
      return { channel: data.user_name || data.slug || slug, displayName: data.user_name || slug, exists: true };
    }
  } catch {}
  return { channel: slug, displayName: slug, exists: false };
}

// ---------- Channel resolution (registry + public lookups) ----------

// Curated NoPixel V creators registry
const CHANNEL_REGISTRY = [
  { name: 'xqc', displayName: 'xQc (Jean Paul)', character: 'Jean Paul (X)', role: 'The Gambler & Bank Buster', color: 'amber', platforms: ['twitch', 'kick', 'youtube'] },
  { name: 'buddha', displayName: 'Buddha (Lang Buddha)', character: 'Lang Buddha', role: 'Emperor of Los Santos / Crime Boss', color: 'rose', platforms: ['twitch', 'kick', 'youtube'] },
  { name: 'roflgator', displayName: 'Roflgator (Robert)', character: 'Robert Spumoni', role: 'Burger Shot Manager', color: 'orange', platforms: ['twitch', 'kick'] },
  { name: 'anthonyz', displayName: 'AnthonyZ (Tony Corleone)', character: 'Tony Corleone', role: 'The Drift King / Getaway Driver', color: 'red', platforms: ['twitch', 'kick', 'youtube'] },
  { name: 'omie', displayName: 'Omie (Marty Banks)', character: 'Marty Banks', role: 'Hacker & Crime Boss', color: 'sky', platforms: ['twitch', 'kick', 'youtube'] },
  { name: 'summit1g', displayName: 'Summit1g (Charles Johnson)', character: 'Charles Johnson', role: 'Racer & Street Legend', color: 'indigo', platforms: ['twitch', 'kick', 'youtube'] },
  { name: 'fuslie', displayName: 'Fuslie (April Fooze)', character: 'April Fooze', role: 'Pop Star & Socialite', color: 'pink', platforms: ['youtube', 'twitch'] },
  { name: 'valkyrae', displayName: 'Valkyrae (Ray Mond)', character: 'Ray Mond', role: 'Criminal & Outlaw', color: 'purple', platforms: ['youtube', 'twitch'] },
  { name: 'chatterbox', displayName: 'Chatterbox', character: 'Chatterbox', role: 'The Clown King', color: 'yellow', platforms: ['twitch', 'kick'] },
  { name: 'kyle', displayName: 'Kyle (Kyle Pred)', character: 'Kyle Pred', role: 'Corrupt Sheriff', color: 'blue', platforms: ['twitch', 'kick'] },
  { name: 'sykkuno', displayName: 'Sykkuno (Yuno Sykk)', character: 'Yuno Sykk', role: 'Master Hacker & Safe Buster', color: 'emerald', platforms: ['youtube', 'twitch'] },
  { name: 'blaustoise', displayName: 'Blaustoise (Mickey)', character: 'Mickey Haverford', role: 'The Lawyer & Mayor', color: 'teal', platforms: ['twitch', 'kick', 'youtube'] },
  { name: 'sayeedblack', displayName: 'Sayeed (Speedy)', character: 'Speedy', role: 'Vagos El Jefe / Weapons Dealer', color: 'lime', platforms: ['twitch', 'kick'] }
];

function aggregateAllCharacters() {
  const config = loadPovConfig();
  const charMap = new Map();

  for (const reg of CHANNEL_REGISTRY) {
    const key = (reg.character || reg.name).toLowerCase();
    charMap.set(key, {
      id: key.replace(/[^a-z0-9]/g, '-'),
      name: reg.character || reg.name,
      streamer: reg.name,
      displayName: reg.displayName,
      role: reg.role || '',
      color: reg.color || 'zinc',
      platforms: reg.platforms || [],
      momentCount: 0,
      streams: [],
      hasPOV: (config.povs || []).some(p => p.id === reg.name)
    });
  }

  for (const pov of (config.povs || [])) {
    const data = getDaysData(pov.id) || {};
    for (const [, day] of Object.entries(data.days || {})) {
      for (const ev of (day.events || [])) {
        for (const p of (ev.participants || [])) {
          const pKey = p.toLowerCase();
          let matched = null;
          for (const [k, c] of charMap.entries()) {
            if (pKey.includes(k) || k.includes(pKey) || p.toLowerCase().includes(c.name.toLowerCase())) {
              matched = c;
              break;
            }
          }
          if (!matched) {
            matched = {
              id: pKey.replace(/[^a-z0-9]/g, '-'),
              name: p,
              streamer: '',
              displayName: p,
              role: '',
              color: 'zinc',
              platforms: [],
              momentCount: 0,
              streams: [],
              hasPOV: (config.povs || []).some(povItem => povItem.id === pKey)
            };
            charMap.set(pKey, matched);
          }
          matched.momentCount++;
          if (!matched.streams.includes(pov.id)) {
            matched.streams.push(pov.id);
          }
        }
      }
    }
  }

  return Array.from(charMap.values()).sort((a, b) => b.momentCount - a.momentCount);
}

function getMomentsForCharacter(charName) {
  const config = loadPovConfig();
  const nameLower = String(charName || '').toLowerCase().trim();
  const results = [];

  for (const pov of (config.povs || [])) {
    const data = getDaysData(pov.id) || {};
    for (const [dayNum, day] of Object.entries(data.days || {})) {
      for (const ev of (day.events || [])) {
        const parts = (ev.participants || []).map(p => p.toLowerCase());
        const text = `${ev.title || ''} ${ev.description || ''}`.toLowerCase();
        const matches = parts.some(p => p.includes(nameLower) || nameLower.includes(p)) || text.includes(nameLower);
        if (matches) {
          results.push({
            streamId: pov.id,
            streamName: pov.name,
            dayNumber: dayNum,
            streamDate: day.streamDate || '',
            eventId: ev.id,
            timestamp: ev.timestamp,
            seconds: ev.seconds,
            title: ev.title,
            description: ev.description,
            isMajor: Boolean(ev.isMajor),
            category: ev.category,
            image: ev.image,
            participants: ev.participants || [],
            crossPov: ev.crossPov || null
          });
        }
      }
    }
  }

  return results.sort((a, b) => a.streamId.localeCompare(b.streamId) || (Number(a.dayNumber) - Number(b.dayNumber)) || (a.seconds - b.seconds));
}

function registrySuggestions(q) {
  const query = String(q || '').toLowerCase().trim();
  if (!query) return CHANNEL_REGISTRY;
  return CHANNEL_REGISTRY
    .filter(c => c.name.includes(query) || c.displayName.toLowerCase().includes(query))
    .slice(0, 12);
}

// Resolve a channel name to platform + latest broadcast using public, unauthenticated lookups.
async function resolveChannel(name) {
  const slug = String(name || '').toLowerCase().trim().replace(/^@/, '').replace(/[^a-z0-9_]/g, '');
  if (!slug) return null;

  const result = { slug, displayName: slug, platforms: [], latest: null, errors: [] };

  // Twitch: profile + latest VOD
  try {
    const info = await twitchFetchVideos(slug);
    if (info.displayName && info.displayName.toLowerCase() !== slug.toLowerCase() || info.videos.length) {
      result.displayName = info.displayName || slug;
      result.platforms.push('twitch');
      result.broadcasterId = info.id || null;
      if (info.videos[0]) {
        const v = info.videos[0];
        result.latest = { platform: 'twitch', title: v.title || 'Latest broadcast', lengthSeconds: v.lengthSeconds || 0, id: v.id, url: `https://www.twitch.tv/videos/${v.id}`, createdAt: v.createdAt || '' };
      }
      // Recent archive VODs for the UI picker (newest first).
      result.recentVods = (info.videos || []).map(v => ({
        platform: 'twitch', id: v.id,
        title: v.title || 'broadcast',
        lengthSeconds: v.lengthSeconds || 0,
        createdAt: v.createdAt || '',
        url: `https://www.twitch.tv/videos/${v.id}`
      }));
    }
  } catch {}

  // Kick
  try {
    const k = await kickFetch(slug);
    if (k.exists) {
      result.displayName = k.displayName || slug;
      result.platforms.push('kick');
    }
  } catch {}

  // YouTube (handle existence only; no public data API key)
  if (!result.platforms.includes('youtube')) {
    try {
      const res = await fetchT(`https://www.youtube.com/@${encodeURIComponent(slug)}`, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        redirect: 'follow'
      });
      if (res.ok) {
        const html = await res.text();
        const titleMatch = html.match(/<title>([^<]{1,120})<\/title>/i);
        const ogTitle = html.match(/property="og:title" content="([^"]+)"/i);
        const t = (ogTitle?.[1] || titleMatch?.[1] || '').replace(/\s*-\s*YouTube.*/i, '').trim();
        if (t && t.toLowerCase() !== 'pictures') {
          result.displayName = t;
          result.platforms.push('youtube');
        }
      }
    } catch {}
  }

  return result;
}

// Kick's VOD page embeds the signed HLS playlist even when yt-dlp's Kick
// metadata extractor returns 404. Prefer the VOD-specific stream.kick.com URL;
// the live-video.net URL on the page may point at the current live channel.
async function resolveKickPlaybackUrl(vodUrl) {
  try {
    // Kick's WAF returns 403 to Node fetch's TLS fingerprint but serves the
    // same page to curl. Keep this command fixed/allowlisted in runKill.
    const page = await runKill('curl', ['-LfsS', '--max-time', '30', '-A', UA, '-H', 'Accept: text/html,application/xhtml+xml', vodUrl], 40000);
    if (page.code !== 0 || !page.stdout) return null;
    const html = page.stdout;
    const matches = [...html.matchAll(/https?:\/\/[^"'\\\s]+\.m3u8[^"'\\\s]*/g)]
      .map(match => match[0]
        .replaceAll('\\\\/', '/')
        .replace(/:\[$\\]+$/, '')
        .replace(/[\\\\]+$/, ''))
      .filter(Boolean);
    return matches.find(url => url.includes('stream.kick.com') && url.includes('/media/hls/master.m3u8'))
      || matches.find(url => url.includes('/media/hls/master.m3u8'))
      || null;
  } catch {
    return null;
  }
}

async function probeMediaDuration(sourceUrl) {
  if (!sourceUrl) return 0;
  try {
    const probe = await runKill('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', sourceUrl], 45000);
    const duration = Number.parseFloat(String(probe.stdout || '').trim());
    return Number.isFinite(duration) ? Math.floor(duration) : 0;
  } catch {
    return 0;
  }
}

async function buildContext(req) {
  const { url, notes, name, platform } = req;
  const context = {
    platform: platform?.toLowerCase() || null,
    channelName: null,
    streamName: name ? String(name).trim() : '',
    url: url?.trim() || '',
    notes: notes?.trim() || '',
    title: '',
    lengthSeconds: 0,
    chapters: []
  };

  if (context.url) {
    const v = context.url.toLowerCase();
    try {
      if (v.includes('twitch.tv')) {
        context.platform = 'twitch';
        const videoMatch = context.url.match(/twitch\.tv\/videos\/(\d+)/i);
        const userMatch = context.url.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i);
        if (videoMatch) {
          const meta = await twitchFetchVideoMeta(videoMatch[1]);
          if (meta) {
            context.title = meta.title;
            context.lengthSeconds = meta.lengthSeconds || 0;
            context.latestVodId = meta.videoId;
            context.twitchBroadcasterId = meta.owner?.id || null;
            context.vodStartAt = meta.createdAt || '';
            context.channelName = meta.owner?.displayName || meta.owner?.login || 'Unknown';
          } else {
            context.channelName = 'Unknown';
          }
        } else if (userMatch && userMatch[1] !== 'videos') {
          const info = await twitchFetchVideos(userMatch[1]);
          context.channelName = info.displayName;
          context.twitchBroadcasterId = info.id || null;
          const latest = info.videos[0];
          if (latest) {
            context.title = latest.title;
            context.lengthSeconds = latest.lengthSeconds || 0;
            context.latestVodId = latest.id;
            const m = await twitchFetchVideoMeta(latest.id);
            if (m && m.title) context.title = m.title;
          }
        } else {
          context.channelName = 'Unknown';
        }
      } else if (v.includes('kick.com') || v.includes('.m3u8')) {
        context.platform = 'kick';
        const slugMatch = context.url.match(/kick\.com\/([a-zA-Z0-9_]+)/i);
        const slug = slugMatch && slugMatch[1] && slugMatch[1] !== 'video' ? slugMatch[1] : (name || 'kick');
        if (slug && slug !== 'kick') {
          try {
            const info = await kickFetch(slug);
            context.channelName = info.displayName || slug;
          } catch {}
        }
        if (v.includes('.m3u8')) {
          context.transcriptionSourceUrl = context.url;
        } else {
          context.transcriptionSourceUrl = await resolveKickPlaybackUrl(context.url);
        }
        if (context.transcriptionSourceUrl) {
          const kickDate = context.transcriptionSourceUrl.match(/\/(\d{4})\/(\d{1,2})\/(\d{1,2})\//);
          if (kickDate) {
            context.vodStartAt = `${kickDate[1]}-${String(kickDate[2]).padStart(2, '0')}-${String(kickDate[3]).padStart(2, '0')}`;
          }
          context.lengthSeconds = await probeMediaDuration(context.transcriptionSourceUrl);
        }
      } else if (v.includes('youtube.com') || v.includes('youtu.be')) {
        context.platform = 'youtube';
        let videoId = null;
        const watchMatch = context.url.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
        const youtuBeMatch = context.url.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
        const embedMatch = context.url.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{6,})/);
        if (watchMatch) videoId = watchMatch[1];
        else if (youtuBeMatch) videoId = youtuBeMatch[1];
        else if (embedMatch) videoId = embedMatch[1];
        if (videoId) {
          const meta = await youtubeFetch(videoId);
          if (meta) {
            context.title = meta.title;
            context.channelName = meta.channel;
            context.lengthSeconds = meta.lengthSeconds || 0;
            context.vodStartAt = meta.createdAt || '';
            context.chapters = meta.chapters || [];
            context.transcript = meta.transcript || [];
          }
        }
        if (!context.channelName || GENERIC_VIDEO_NAMES.has(String(context.channelName).toLowerCase())) {
          const handleMatch = context.url.match(/youtube\.com\/@([a-zA-Z0-9_]+)/i);
          context.channelName = handleMatch ? handleMatch[1] : '';
        }
      }
    } catch {
      // metadata fetch failed — fall through; notes may still carry the recap
    }
  }

  if (!context.channelName && context.notes && name) context.channelName = String(name).trim();
  return context;
}

// ---------- Screenshot capture (yt-dlp + ffmpeg) ----------

const PUBLIC_FRAMES_DIR = path.join(__dirname, 'public', 'images', 'frames');
const DIST_FRAMES_DIR = path.join(__dirname, 'dist', 'images', 'frames');

function ensureFrameDirs() {
  for (const dir of [PUBLIC_FRAMES_DIR, DIST_FRAMES_DIR]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }
}

// Spawn with a hard kill: SIGTERM is ignored by ffmpeg on HLS, so on timeout
// we SIGKILL the whole process group and never leak a stuck child.
function spawnAllowedProcess(name, args, options) {
  if (name === 'yt-dlp') return spawn('/usr/local/bin/yt-dlp', args, options);
  if (name === 'ffmpeg') return spawn('/usr/bin/ffmpeg', args, options);
  if (name === 'ffprobe') return spawn('/usr/bin/ffprobe', args, options);
  if (name === 'curl') return spawn('/usr/bin/curl', args, options);
  return null;
}

function runKill(cmd, args, timeoutMs = 25000) {
  if (!['yt-dlp', 'ffmpeg', 'ffprobe', 'curl'].includes(cmd)) return Promise.resolve({ code: 1, stdout: '', stderr: 'unsupported process' });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnAllowedProcess(cmd, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (!child) return resolve({ code: 1, stdout: '', stderr: 'unsupported process' });
    } catch {
      return resolve({ code: 1, stdout: '', stderr: 'spawn failed' });
    }
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', () => resolve({ code: 1, stdout: out, stderr: err }));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: out, stderr: err });
    });
  });
}

function transcriptionSourceUrl(context) {
  if (context.platform === 'twitch' && context.latestVodId) return `https://www.twitch.tv/videos/${context.latestVodId}`;
  if (context.platform === 'kick') return context.transcriptionSourceUrl || context.url || null;
  if (context.url && context.platform === 'youtube') return context.url;
  return null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseRetryAfterMs(message, retryAfterHeader) {
  // Prefer a proper Retry-After HTTP header (seconds) when the provider sends one.
  const headerSeconds = Number(String(retryAfterHeader || '').trim());
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) return headerSeconds * 1000;
  const value = String(message || '');
  const match = value.match(/try again in\s+(?:(\d+)m)?\s*([\d.]+)s/i);
  if (!match) return 0;
  return (Number(match[1] || 0) * 60 + Number(match[2] || 0)) * 1000;
}

function parseWhisperTimestamp(value) {
  if (Number.isFinite(Number(value))) return Number(value);
  const match = String(value || '').trim().match(/^(\d+):(\d{2}):(\d{2})(?:[,.](\d{3}))?$/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] || '000'}`);
}

function parseLocalTranscription(data, protocol, offsetSeconds) {
  const entries = protocol === 'whisper-cpp'
    ? (Array.isArray(data) ? data : data?.transcription || data?.segments || [])
    : (data?.segments || []);
  return entries.map(segment => {
    const directStart = Number(segment.start);
    const offsetStart = Number(segment.offsets?.from) / 1000;
    const directEnd = Number(segment.end);
    const offsetEnd = Number(segment.offsets?.to) / 1000;
    const tickStart = Number(segment.t0) / 100;
    const tickEnd = Number(segment.t1) / 100;
    const start = Number.isFinite(directStart)
      ? directStart
      : Number.isFinite(offsetStart)
        ? offsetStart
        : Number.isFinite(tickStart)
          ? tickStart
          : parseWhisperTimestamp(segment.timestamps?.from);
    const end = Number.isFinite(directEnd)
      ? directEnd
      : Number.isFinite(offsetEnd)
        ? offsetEnd
        : Number.isFinite(tickEnd)
          ? tickEnd
          : parseWhisperTimestamp(segment.timestamps?.to);
    return {
      start: offsetSeconds + start,
      end: offsetSeconds + (end || start),
      text: decodeCaptionText(segment.text || '')
    };
  }).filter(segment => segment.text);
}

async function transcribeChunkOpenAICompatible(filePath, offsetSeconds, provider) {
  const isGroq = provider === 'groq';
  const isLocal = provider === 'local';
  const localProtocol = String(process.env.LOCAL_WHISPER_PROTOCOL || 'openai').toLowerCase();
  const isWhisperCpp = isLocal && localProtocol === 'whisper-cpp';
  const apiKey = isGroq ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY;
  if (!isLocal && !apiKey) return [];
  const endpoint = isGroq
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : isLocal
      ? `${String(process.env.LOCAL_WHISPER_BASE_URL || '').replace(/\/$/, '')}${isWhisperCpp ? '/inference' : '/v1/audio/transcriptions'}`
      : 'https://api.openai.com/v1/audio/transcriptions';
  if (isLocal && !endpoint.startsWith('http')) return [];
  const requestTimeoutMs = isLocal
    ? Math.max(180000, Number(process.env.LOCAL_WHISPER_TIMEOUT_MS || 1800000) || 1800000)
    : 180000;
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(filePath)], { type: 'audio/mpeg' }), path.basename(filePath));
      form.append('model', isGroq ? (process.env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo') : isLocal
        ? (process.env.LOCAL_WHISPER_MODEL || 'whisper-large-v3-turbo')
        : (process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1'));
      form.append('response_format', 'verbose_json');
      if (isWhisperCpp) {
        form.append('language', process.env.LOCAL_WHISPER_LANGUAGE || 'en');
        form.append('temperature', '0');
      } else if (!isGroq && !isLocal) {
        form.append('timestamp_granularities[]', 'segment');
      }
      const headers = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetchT(endpoint, {
        method: 'POST',
        headers,
        body: form
      }, requestTimeoutMs);
      if (res.ok) {
        const data = await res.json();
        return parseLocalTranscription(data, isLocal ? localProtocol : 'openai', offsetSeconds);
      }
      const errorText = await res.text().catch(() => '');
      lastError = new Error(`${provider} returned HTTP ${res.status}${errorText ? `: ${errorText.slice(0, 300)}` : ''}`);
      console.error(`[Transcription] ${provider} chunk attempt ${attempt + 1} failed (${res.status}): ${errorText.slice(0, 300)}`);
      if (res.status === 429) {
        // Groq answers spend-cap hits with a 429 carrying usage-limit wording — treat
        // that as "budget exhausted" (terminal) rather than a transient rate limit.
        if (/usage limit|monthly|spend|cap|quota/i.test(errorText)) {
          const budgetError = new Error(`Transcription provider spend cap reached: ${errorText.slice(0, 300)}`);
          budgetError.code = 'TRANSCRIPTION_BUDGET_EXHAUSTED';
          throw budgetError;
        }
        // Transient rate limit: honor Retry-After / the Groq message, back off, and
        // retry WITHIN this chunk. Paid tier still 429s on bursts; waiting it out
        // beats killing the whole job. Only last-resort throws park the job.
        const retryAfterMs = parseRetryAfterMs(errorText, res.headers.get('retry-after'));
        if (attempt < 2) {
          await sleep(Math.min(30000, Math.max(retryAfterMs, 5000)));
          continue;
        }
        const rateError = new Error(`Transcription provider rate limit: ${errorText.slice(0, 500)}`);
        rateError.code = 'TRANSCRIPTION_RATE_LIMIT';
        rateError.retryAfterMs = retryAfterMs || 30000;
        throw rateError;
      }
      if (res.status === 402) {
        const budgetError = new Error('Groq monthly spend cap reached. Raise GROQ_MONTHLY_CAP_DOLLARS or increase the limit in your Groq console.');
        budgetError.code = 'TRANSCRIPTION_BUDGET_EXHAUSTED';
        throw budgetError;
      }
      if (res.status < 500) break;
    } catch (error) {
      if (error.code === 'TRANSCRIPTION_RATE_LIMIT') throw error;
      lastError = error;
      console.error(`[Transcription] ${provider} chunk attempt ${attempt + 1} error: ${error.message}`);
    }
    await sleep(2000 * (attempt + 1));
  }
  if (isLocal && lastError) {
    const detail = lastError.name === 'AbortError'
      ? `request timed out after ${Math.round(requestTimeoutMs / 60000)} minutes`
      : lastError.message;
    throw new Error(`Local whisper transcription failed after 3 attempts: ${detail}`);
  }
  return [];
}

async function transcribeChunkDeepgram(filePath, offsetSeconds) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return [];
  const res = await fetchT('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&utterances=true', {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/mpeg' },
    body: fs.readFileSync(filePath)
  }, 180000);
  if (!res.ok) return [];
  const data = await res.json();
  const utterances = data.results?.utterances || [];
  if (utterances.length) return utterances.map(segment => ({
    start: offsetSeconds + Number(segment.start || 0),
    end: offsetSeconds + Number(segment.end || segment.start || 0),
    text: decodeCaptionText(segment.transcript || '')
  })).filter(segment => segment.text);
  const alt = data.results?.channels?.[0]?.alternatives?.[0];
  return alt?.transcript ? [{ start: offsetSeconds, end: offsetSeconds, text: decodeCaptionText(alt.transcript) }] : [];
}

async function transcribeExternalStream(context, allowLong = false, onProgress = () => {}, options = {}) {
  const provider = String(process.env.TRANSCRIPTION_PROVIDER || '').toLowerCase();
  const batchMode = !!options.batch && provider === 'groq';
  const maxSyncSeconds = Number(process.env.MAX_SYNC_TRANSCRIPTION_SECONDS || 1800);
  // Long VOD transcription belongs in a background job. Do not hold the
  // browser request open while downloading several hours of audio.
  if (!allowLong && context.lengthSeconds > maxSyncSeconds) return [];
  if (!['openai', 'groq', 'deepgram', 'local'].includes(provider)) return [];
  if (provider === 'openai' && !process.env.OPENAI_API_KEY) return [];
  if (provider === 'groq' && !process.env.GROQ_API_KEY) return [];
  if (provider === 'deepgram' && !process.env.DEEPGRAM_API_KEY) return [];
  if (provider === 'local' && !process.env.LOCAL_WHISPER_BASE_URL) return [];
  if (isStreamLive(context)) return [];

  const sourceUrl = transcriptionSourceUrl(context);
  if (!sourceUrl) return [];
  if (context.platform === 'kick' && !context.transcriptionSourceUrl) {
    const sourceError = new Error('Could not resolve a playable Kick VOD playlist. The recap was not transcribed.');
    sourceError.code = 'TRANSCRIPTION_SOURCE_UNAVAILABLE';
    throw sourceError;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamrecap-audio-'));
  const longDownloadTimeoutMs = Math.max(
    20 * 60 * 1000,
    Number(process.env.TRANSCRIPTION_DOWNLOAD_TIMEOUT_MS || 2 * 60 * 60 * 1000) || 2 * 60 * 60 * 1000
  );
  try {
    onProgress(5, 'Downloading VOD audio');
    let inputPath = null;
    if (context.platform === 'kick' && context.transcriptionSourceUrl) {
      inputPath = path.join(tempDir, 'source.mp3');
      const download = await runKill('ffmpeg', ['-y', '-i', context.transcriptionSourceUrl, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', inputPath], allowLong ? longDownloadTimeoutMs : 10 * 60 * 1000);
      if (download.code !== 0) {
        const detail = String(download.stderr || '').trim().slice(-500);
        console.error(`[Transcription] Kick HLS audio download failed: ${detail}`);
        const downloadError = new Error(`Kick audio download failed${detail ? `: ${detail}` : '.'}`);
        downloadError.code = 'TRANSCRIPTION_DOWNLOAD_FAILED';
        throw downloadError;
      }
    } else {
      const download = await runKill('yt-dlp', ['-f', 'worstaudio/bestaudio', '--no-playlist', '--no-warnings', '-o', path.join(tempDir, 'source.%(ext)s'), sourceUrl], allowLong ? longDownloadTimeoutMs : 90000);
      if (download.code !== 0) {
        const detail = String(download.stderr || '').trim().slice(-500);
        console.error(`[Transcription] yt-dlp download failed: ${detail}`);
        const downloadError = new Error(`VOD audio download failed${detail ? `: ${detail}` : '.'}`);
        downloadError.code = 'TRANSCRIPTION_DOWNLOAD_FAILED';
        throw downloadError;
      }
      const input = fs.readdirSync(tempDir).find(file => file.startsWith('source.'));
      if (!input) {
        const downloadError = new Error('VOD downloader completed without producing an audio file.');
        downloadError.code = 'TRANSCRIPTION_DOWNLOAD_FAILED';
        throw downloadError;
      }
      inputPath = path.join(tempDir, input);
    }
    if (!context.lengthSeconds) context.lengthSeconds = await probeMediaDuration(inputPath);
    onProgress(25, 'Splitting audio into chunks');
    const segmentPattern = path.join(tempDir, 'chunk_%03d.mp3');
    const split = await runKill('ffmpeg', ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', '-f', 'segment', '-segment_time', '600', '-reset_timestamps', '1', segmentPattern], allowLong ? 20 * 60 * 1000 : 600000);
    if (split.code !== 0) {
      const detail = String(split.stderr || '').trim().slice(-500);
      console.error(`[Transcription] ffmpeg audio split failed: ${detail}`);
      const splitError = new Error(`Audio chunking failed${detail ? `: ${detail}` : '.'}`);
      splitError.code = 'TRANSCRIPTION_SPLIT_FAILED';
      throw splitError;
    }
    const chunks = fs.readdirSync(tempDir).filter(file => /^chunk_\d+\.mp3$/.test(file)).sort();
    console.error(`[Transcription] ${provider}: ${chunks.length} audio chunks queued`);

    // ---- Batch mode: submit ALL chunks as one JSONL batch at half price ----
    if (batchMode) {
      const baseUrl = groqBatchBaseUrl();
      if (!baseUrl) {
        throw new Error('Batch transcription requires GROQ_BATCH_BASE_URL - set it to your public tunnel URL (e.g. https://xxx.trycloudflare.com) so Groq can fetch the audio chunks.');
      }
      const model = batchModelName();
      const jobToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const jobDir = path.join(BATCH_AUDIO_DIR, jobToken);
      fs.mkdirSync(jobDir, { recursive: true });
      for (const file of chunks) fs.copyFileSync(path.join(tempDir, file), path.join(jobDir, file));
      const jsonl = chunks.map((file, i) => JSON.stringify({
        custom_id: `chunk-${String(i).padStart(3, '0')}`,
        method: 'POST',
        url: '/v1/audio/transcriptions',
        body: {
          model,
          url: `${baseUrl}/batch-audio/${jobToken}/${file}`,
          response_format: 'verbose_json',
          timestamp_granularities: ['segment']
        }
      })).join('\n');
      fs.writeFileSync(path.join(jobDir, 'batch.jsonl'), jsonl);
      onProgress(40, `Uploading ${chunks.length}-chunk batch file to Groq`);
      const fileId = await uploadGroqBatchFile(path.join(jobDir, 'batch.jsonl'));
      onProgress(55, 'Submitting batch job (24h window)');
      const created = await createGroqBatch(fileId);
      if (!created?.id) throw new Error('Groq batch submission returned no batch id.');
      console.error(`[Batch] submitted ${created.id} with ${chunks.length} chunks (${jobToken})`);
      context.batchInfo = {
        batchId: created.id,
        expiresAt: created.expires_at || null,
        jobToken,
        audioSeconds: Math.max(0, Math.floor(Number(context.lengthSeconds) || 0))
      };
      context.transcriptSource = null;
      onProgress(60, 'Batch submitted - Groq processing (up to 24h)');
      return [];
    }

    const allSegments = [];
    // Paid tiers give Groq the rate headroom to transcribe several chunks at once.
    // A small worker pool cuts long-VOD wall-clock ~3x without changing cost
    // (same audio hours billed). 429s still back off per-chunk via retries below.
    const configuredConcurrency = Math.max(1, Math.min(6, Number(process.env.TRANSCRIPTION_CONCURRENCY || 3) || 3));
    // faster-whisper-server runs one model process; concurrent uploads make it
    // queue requests until our HTTP timeout and can leave the whole job failed.
    const concurrency = provider === 'local' ? 1 : configuredConcurrency;
    const tasks = chunks.map((file, i) => ({ file, offset: i * 600 }));
    let nextTask = 0;
    let completedTasks = 0;
    onProgress(35, `Transcribing ${tasks.length} audio chunks (${Math.min(concurrency, tasks.length)} in parallel)`);
    const runWorker = async () => {
      while (nextTask < tasks.length) {
        const { file, offset } = tasks[nextTask++];
        const filePath = path.join(tempDir, file);
        const segments = provider === 'openai' || provider === 'groq' || provider === 'local'
          ? await transcribeChunkOpenAICompatible(filePath, offset, provider)
          : await transcribeChunkDeepgram(filePath, offset);
        allSegments.push(...segments);
        completedTasks++;
        onProgress(35 + Math.round((completedTasks / Math.max(tasks.length, 1)) * 60), `Transcribing chunk ${completedTasks} of ${tasks.length} (${Math.min(concurrency, tasks.length)} parallel)`);
        console.error(`[Transcription] ${provider}: chunk ${completedTasks}/${tasks.length} -> ${segments.length} segments`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => runWorker()));
    onProgress(100, 'Transcript complete');
    context.transcriptSource = provider;
    console.error(`[Transcription] ${provider}: total segments ${allSegments.length}`);
    return allSegments.sort((a, b) => a.start - b.start);
  } catch (error) {
    console.error(`[Transcription] ${provider} failed: ${error.message}`);
    throw error;
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

// Resolve a direct playable HLS/media URL for a platform VOD via yt-dlp.
async function resolveDirectStreamUrl(context) {
  if (context.transcriptionSourceUrl) return context.transcriptionSourceUrl;
  let sourceUrl = null;
  if (context.platform === 'twitch') {
    sourceUrl = context.latestVodId ? `https://www.twitch.tv/videos/${context.latestVodId}` : (context.url.includes('twitch.tv') ? context.url : null);
  } else if (context.platform === 'youtube') {
    sourceUrl = context.url.includes('youtube.com') || context.url.includes('youtu.be') ? context.url : null;
  } else if (context.platform === 'kick') {
    sourceUrl = context.url.includes('kick.com') ? context.url : null;
  }
  if (!sourceUrl) return null;
  try {
    const r = await runKill('yt-dlp', ['-g', '--no-playlist', '--no-warnings', '-f', 'bv*+ba/b', sourceUrl], 45000);
    if (r.code !== 0) return null;
    const lines = (r.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
    return lines[0] || null;
  } catch {
    return null;
  }
}

// Capture a single frame at `seconds` into `outFile`.
async function captureFrameSeconds(streamUrl, seconds, outFile) {
  try {
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(Math.max(0, Math.floor(seconds))), '-i', streamUrl, '-frames:v', '1', '-q:v', '4', '-vf', 'scale=960:-2', outFile];
    const r = await runKill('ffmpeg', args, 25000);
    return r.code === 0 && fs.existsSync(outFile) && fs.statSync(outFile).size > 2000;
  } catch {
    return false;
  }
}

// A VOD is treated as still-live when createdAt + duration lands near "now" —
// i.e. ffmpeg would be seeking into a live DVR HLS (unreliable) instead of an archived file.
function isStreamLive(context) {
  if (!context.vodStartAt || !context.lengthSeconds) return false;
  const startMs = Date.parse(context.vodStartAt);
  if (isNaN(startMs)) return false;
  const endMs = startMs + (context.lengthSeconds + 15 * 60) * 1000; // 15-min grace
  return Date.now() < endMs;
}

function selectFrameTargets(events, maxFrames = 28) {
  const eligible = (events || [])
    .filter(event => Number(event.seconds) >= 5)
    .sort((a, b) => a.seconds - b.seconds);
  const limit = Math.max(0, Math.floor(Number(maxFrames) || 0));
  if (eligible.length <= limit) return eligible;
  if (!limit) return [];

  // Keep every major event when possible, then spend the remaining frame budget
  // on moments distributed across the full timeline rather than the first 28.
  const selected = new Set();
  const majors = eligible.filter(event => event.isMajor);
  const majorTargets = majors.length <= limit
    ? majors
    : pickEvenlyAcrossTimeline(majors, limit);
  majorTargets.forEach(event => selected.add(event));

  const remaining = limit - selected.size;
  if (remaining > 0) {
    const candidates = eligible.filter(event => !selected.has(event));
    pickEvenlyAcrossTimeline(candidates, remaining).forEach(event => selected.add(event));
  }

  return eligible.filter(event => selected.has(event));
}

function pickEvenlyAcrossTimeline(events, count) {
  if (!events.length || count <= 0) return [];
  if (events.length <= count) return [...events];
  const first = events[0].seconds;
  const last = events[events.length - 1].seconds;
  const span = Math.max(0, last - first);
  const selected = new Set();

  for (let i = 0; i < count; i++) {
    const target = span
      ? first + (span * (i + 0.5)) / count
      : first;
    let closest = null;
    let closestDistance = Infinity;
    for (const event of events) {
      if (selected.has(event)) continue;
      const distance = Math.abs(event.seconds - target);
      if (distance < closestDistance) {
        closest = event;
        closestDistance = distance;
      }
    }
    if (closest) selected.add(closest);
  }

  return events.filter(event => selected.has(event));
}

// Populate optional preview frames for selected recap events. Timestamps remain
// useful without images; frame capture is capped and spread across the timeline.
// Runs with small concurrency so we don't burn CPU; skips failures (placeholder still shows).
async function attachEventFrames(recap, context, streamId, options = {}) {
  // If the broadcast is likely STILL LIVE, seeking into a live DVR HLS stream
  // yields corrupt packets / hangs — instead capture frames once it's archived.
  if (isStreamLive(context)) return 0;
  const days = Object.values(recap.days || {});
  const allEvents = days.flatMap(d => (d.events || []));
  const maxFrames = Math.max(0, Math.min(100, Number(process.env.MAX_EVENT_FRAMES || 100)));
  const frameBudgetMs = Math.max(90000, Number(process.env.FRAME_CAPTURE_BUDGET_MS || 600000) || 600000);
  const requiredEvents = (options.requiredEvents || []).filter(event => allEvents.includes(event));
  const selected = new Set(requiredEvents);
  const ordinaryTargets = selectFrameTargets(allEvents, maxFrames);
  const targets = [
    ...requiredEvents,
    ...ordinaryTargets.filter(event => !selected.has(event)).slice(0, Math.max(0, maxFrames - selected.size))
  ].filter((event, index, list) => list.indexOf(event) === index);
  const missingTargets = targets.filter(event => {
    if (!event.image || !String(event.image).startsWith('/images/frames/')) return true;
    return !fs.existsSync(path.join(PUBLIC_FRAMES_DIR, path.basename(event.image)));
  });
  if (!missingTargets.length) return 0;

  const directUrl = await resolveDirectStreamUrl(context);
  if (!directUrl) return 0;
  ensureFrameDirs();

  let capturedCount = 0;
  const concurrency = 2;
  let idx = 0;
  const budgetStart = Date.now();
  const workers = [];
  for (let w = 0; w < concurrency; w++) {
    workers.push((async () => {
      while (idx < missingTargets.length) {
        if (Date.now() - budgetStart > frameBudgetMs) break; // bounded budget so frame capture cannot hang generation
        const ev = missingTargets[idx++];
        const safeTs = formatTimestamp(ev.seconds).replace(/:/g, '');
        const fname = `${streamId}_evt_${String(ev.seconds).padStart(6, '0')}_${safeTs}.jpg`;
        const pubPath = path.join(PUBLIC_FRAMES_DIR, fname);
        const distPath = path.join(DIST_FRAMES_DIR, fname);
        const ok = await captureFrameSeconds(directUrl, ev.seconds, pubPath);
        if (ok) {
          try { fs.copyFileSync(pubPath, distPath); } catch {}
          ev.image = `/images/frames/${fname}`;
          ev.imageCaption = `Stream snapshot @ ${ev.timestamp}`;
          capturedCount++;
        }
      }
    })());
  }
  await Promise.all(workers);
  return capturedCount;
}

// ---------- Schema normalization ----------

// Deterministically derive an end time for events that lack one. Falls back to
// the next event's start (minus a small gap) or a bounded window so ranges stay
// useful for clip export without inventing massive durations.
function deriveEventEnds(events, maxSec = 0) {
  const list = [...(events || [])].sort((a, b) => a.seconds - b.seconds);
  for (let i = 0; i < list.length; i++) {
    const event = list[i];
    const start = Number(event.seconds) || 0;
    let end = null;
    if (event.endSeconds !== undefined && event.endSeconds !== null) {
      end = Math.max(0, Number(event.endSeconds) || 0);
    }
    const nextStart = list[i + 1]?.seconds;
    const fallback = nextStart === undefined
      ? start + 120
      : Math.min(start + 120, Math.max(start + 1, nextStart - 5));
    if (!end || end <= start) end = fallback;
    if (nextStart !== undefined && end > nextStart - 2) end = Math.max(start + 1, nextStart - 2);
    if (maxSec > 0) end = Math.min(end, Math.max(start + 1, maxSec));
    const minEnd = Math.min(maxSec > 0 ? maxSec : Infinity, start + 180);
    if (end > start + 300) end = Math.min(end, minEnd);
    event.endSeconds = Math.max(start + 1, Math.floor(end));
    event.endTimestamp = formatTimestamp(event.endSeconds);
    event.durationSeconds = event.endSeconds - start;
    if (!event.endMode) event.endMode = 'derived';
  }
  return events;
}

function normalizeParticipants(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 12))];
}

function normalizeEconomy(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const asset = String(raw.asset || '').trim();
  if (!asset) return null;
  const validActions = ['buy', 'sell', 'trade', 'payout', 'fine', 'fee', 'rent'];
  const action = validActions.includes(String(raw.action).toLowerCase()) ? String(raw.action).toLowerCase() : 'trade';
  return {
    asset: asset.slice(0, 50),
    action,
    ...(raw.amount ? { amount: String(raw.amount).slice(0, 30) } : {}),
    ...(raw.price ? { price: String(raw.price).slice(0, 30) } : {}),
    verification: raw.verification === 'screen-verified' ? 'screen-verified' : 'spoken-claim'
  };
}

function normalizePoliceIncident(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const validOutcomes = ['escaped', 'arrested', 'hospitalized', 'citation'];
  const outcome = validOutcomes.includes(String(raw.outcome).toLowerCase()) ? String(raw.outcome).toLowerCase() : 'escaped';
  return {
    outcome,
    ...(Array.isArray(raw.officers) && raw.officers.length ? { officers: raw.officers.map(o => String(o).slice(0, 40)).slice(0, 4) } : {}),
    ...(Array.isArray(raw.charges) && raw.charges.length ? { charges: raw.charges.map(c => String(c).slice(0, 50)).slice(0, 5) } : {}),
    ...(raw.fine ? { fine: String(raw.fine).slice(0, 30) } : {}),
    ...(raw.jailMonths ? { jailMonths: Math.max(0, parseInt(raw.jailMonths, 10) || 0) } : {})
  };
}

async function generateStoryArcs(dayTitle, events) {
  if (!Array.isArray(events) || events.length < 6) return [];
  const eventSummaries = events.map(e => ({
    id: e.id,
    timestamp: e.timestamp,
    title: e.title,
    category: e.category,
    participants: e.participants || []
  }));

  const systemPrompt = 'You are an episodic narrative arc analyzer for livestreams. Output strictly valid JSON.';
  const userPrompt = [
    `Given these chronological stream moments from ${dayTitle}, identify 2 to 4 overarching story arcs or heist sequences that took place during the broadcast.`,
    'Each arc connects 2 or more related moments into a coherent narrative thread (e.g. initiation, heist preparation, police evasion, criminal partnership).',
    'Return ONLY JSON in this exact shape:',
    '{"arcs":[{"id":"slug-id","title":"Arc Title","summary":"1 concise sentence describing the arc","eventIds":["evt-001","evt-002"]}]}'
  ].join('\n') + '\n\n' + JSON.stringify(eventSummaries.slice(0, 100));

  try {
    const raw = parseJsonLoose(await callLLM(systemPrompt, userPrompt, 45000));
    const arcs = Array.isArray(raw?.arcs) ? raw.arcs : [];
    return arcs.map(a => ({
      id: String(a.id || a.title || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40),
      title: String(a.title || 'Story Arc').slice(0, 80),
      summary: String(a.summary || '').slice(0, 240),
      eventIds: Array.isArray(a.eventIds) ? a.eventIds.map(String) : []
    })).filter(a => a.id && a.eventIds.length >= 2);
  } catch (err) {
    console.error('[StoryArcs] Arc synthesis skipped:', err.message);
    return [];
  }
}

async function enrichRecapWithStoryArcs(recap) {
  for (const [dayKey, day] of Object.entries(recap.days || {})) {
    if (!day.storyArcs?.length && Array.isArray(day.events) && day.events.length >= 6) {
      const arcs = await generateStoryArcs(day.title || `Day ${dayKey}`, day.events);
      if (arcs.length) {
        day.storyArcs = arcs;
        const arcMap = new Map();
        for (const arc of arcs) {
          for (const eid of arc.eventIds) {
            arcMap.set(eid, { id: arc.id, title: arc.title });
          }
        }
        for (const ev of day.events) {
          if (arcMap.has(ev.id)) {
            ev.arcId = arcMap.get(ev.id).id;
            ev.arcTitle = arcMap.get(ev.id).title;
          }
        }
      }
    }
  }
}

function normalizeRecap(raw, context, streamId) {
  if (!raw) throw new Error('AI returned an unparseable response. Try again or add more notes.');
  const sourceKey = context?.latestVodId
    ? `${context.platform || 'vod'}:${context.latestVodId}`
    : context?.url
      ? String(context.url).split('?')[0]
      : '';
  const timestampsApproximate = !((context && context.evidence) || []).length;
  const sources = (context && context.evidence) || [];
  const daysRaw = raw.days || {};
  const dayKeys = Object.keys(daysRaw).sort((a, b) => a - b);
  if (!dayKeys.length) {
    // tolerate flat events array
    if (Array.isArray(raw.events)) {
      daysRaw['1'] = { dayNumber: 1, events: raw.events };
      dayKeys.push('1');
    } else {
      throw new Error('AI response missing recap days. Try again.');
    }
  }

  const days = {};
  const vodUrls = sanitizeChannelUrls(context);
  dayKeys.forEach((key, di) => {
    const day = daysRaw[key] || {};
    const events = Array.isArray(day.events) ? day.events : [];
    const maxSec = context?.lengthSeconds || 0;

    // First pass: parse + clamp negative, keep raw seconds aside for overflow folding.
    const parsed = events.map((ev) => ({
      rawSeconds: Math.max(0, parseInt(ev.seconds, 10) || 0),
      rawStartSegmentId: ev.startSegmentId ? String(ev.startSegmentId).trim() : null,
      rawEndSeconds: ev.endSeconds !== undefined && ev.endSeconds !== null
        ? Math.max(0, parseInt(ev.endSeconds, 10) || 0)
        : null,
      rawEndSegmentId: ev.endSegmentId ? String(ev.endSegmentId).trim() : null,
      isMajor: !!ev.isMajor,
      title: String(ev.title || ev.description || '').slice(0, 120),
      description: String(ev.description || ev.title || '').slice(0, 180),
      evidence: String(ev.evidence || '').slice(0, 220),
      confidence: String(ev.confidence || '').toLowerCase(),
      category: sanitizeCategory(ev.category),
      participants: normalizeParticipants(ev.participants || ev.characters),
      redditUrl: ev.redditUrl || null,
      redditTitle: ev.redditTitle || null,
      economy: normalizeEconomy(ev.economy),
      policeIncident: normalizePoliceIncident(ev.policeIncident),
      arcId: ev.arcId || null,
      arcTitle: ev.arcTitle || null
    }));

    // Match external community/Reddit threads to events when available
    if (context?.redditResearch?.posts?.length) {
      for (const p of parsed) {
        if (!p.redditUrl) {
          const words = `${p.title} ${p.description}`.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length >= 4);
          const matched = context.redditResearch.posts.find(post => {
            const postTitle = (post.title || '').toLowerCase();
            return words.filter(w => postTitle.includes(w)).length >= 2;
          });
          if (matched) {
            p.redditUrl = matched.permalink;
            p.redditTitle = matched.title;
          }
        }
      }
    }

    // Fold any overflow past the stream length back INTO the uncovered tail, evenly
    // spaced, instead of clamping them all onto the final second (which produced
    // duplicate timestamps).
    if (maxSec > 0) {
      const inBounds = parsed.filter(p => p.rawSeconds <= maxSec);
      const overflow = parsed.filter(p => p.rawSeconds > maxSec);
      if (overflow.length) {
        const lastValid = inBounds.reduce((m, p) => Math.max(m, p.rawSeconds), 0);
        const zoneStart = Math.min(lastValid, maxSec - 1);
        const zoneSpan = Math.max(0.001, maxSec - zoneStart);
        overflow.forEach((p, i) => {
          p.rawSeconds = Math.floor(zoneStart + (zoneSpan * (i + 1)) / (overflow.length + 1));
        });
      }
    }

    // Deduplicate exact-second collisions forward by 1s so timestamps stay distinct.
    const sortedRaw = parsed.map(p => p.rawSeconds).sort((a, b) => a - b);
    for (let i = 1; i < sortedRaw.length; i++) {
      if (sortedRaw[i] <= sortedRaw[i - 1]) sortedRaw[i] = sortedRaw[i - 1] + 1;
    }
    parsed.forEach((p, i) => { p.rawSeconds = maxSec > 0 ? Math.min(sortedRaw[i], maxSec) : sortedRaw[i]; });

    const normalized = parsed
      .map((p, i) => {
        const segIndex = context?._segmentIndex || [];
        const startSeg = p.rawStartSegmentId ? segIndex.find((s) => s.id === p.rawStartSegmentId) || null : null;
        const seconds = startSeg && startSeg.start >= 0 && (!maxSec || startSeg.start <= maxSec)
          ? Math.floor(startSeg.start)
          : p.rawSeconds;
        const startMode = startSeg && startSeg.start >= 0 && (!maxSec || startSeg.start <= maxSec) ? 'segment' : null;
        const rawEnd = p.rawEndSeconds;
        // Resolve the end boundary from a referenced transcript segment when the
        // model provided one; otherwise clamp the model's numeric end; deriveEventEnds
        // fills the remaining events deterministically after sorting/filtering.
        let endSeconds = null;
        let endMode = null;
        const endSeg = p.rawEndSegmentId ? segIndex.find((s) => s.id === p.rawEndSegmentId) || null : null;
        if (endSeg && endSeg.end > seconds && (!maxSec || endSeg.end <= maxSec)) {
          endSeconds = Math.floor(endSeg.end);
          endMode = 'segment';
        } else if (rawEnd && rawEnd > seconds) {
          endSeconds = maxSec > 0 ? Math.min(rawEnd, maxSec) : rawEnd;
          endMode = 'model';
        }
        return {
          id: `${streamId}-evt-${String(i + 1).padStart(3, '0')}`,
          timestamp: formatTimestamp(seconds),
          seconds,
          ...(startMode ? { startMode } : {}),
          ...(endSeconds === null ? {} : { endSeconds, endTimestamp: formatTimestamp(endSeconds), endMode }),
          isMajor: p.isMajor,
          title: p.title || `Moment ${i + 1}`,
          description: p.description,
          evidence: String(p.evidence || '').slice(0, 220),
          confidence: String(p.confidence || '').toLowerCase(),
          category: p.category,
          tags: [p.category],
          ...(p.participants.length ? { participants: p.participants } : {}),
          ...(p.redditUrl ? { redditUrl: p.redditUrl, redditTitle: p.redditTitle } : {}),
          ...(p.economy ? { economy: p.economy } : {}),
          ...(p.policeIncident ? { policeIncident: p.policeIncident } : {}),
          ...(p.arcId ? { arcId: p.arcId, arcTitle: p.arcTitle } : {}),
          image: null,
          ...(vodUrls.twitchVod ? { twitchUrl: `${vodUrls.twitchVod}?t=${seconds}s` } : {}),
          ...(vodUrls.kickVod ? { kickUrl: withKickTimestamp(vodUrls.kickVod, seconds) } : {}),
          ...(vodUrls.youtubeUrl ? { youtubeUrl: `${vodUrls.youtubeUrl}${vodUrls.youtubeUrl.includes('?') ? '&' : '?'}t=${seconds}s` } : {})
        };
      })
      .sort((a, b) => a.seconds - b.seconds)
      // Avoid fake-looking one-second clusters from an uncertain LLM response.
      .filter((event, index, all) => index === 0 || event.seconds - all[index - 1].seconds >= 15);

    // Fill in deterministic end times where the model did not supply one.
    deriveEventEnds(normalized, maxSec);

    const eventsCount = normalized.length;
    if (!eventsCount) throw new Error('AI returned a recap with no moments. Try again.');

    const dayTitle = String(day.title || (dayKeys.length > 1 ? `Day ${di + 1}` : 'Stream Recap')).slice(0, 120);

    // Stream date: use the VOD creation date when known, else the day's updated stamp.
    const streamDate = (context?.vodStartAt || context?.vodCreatedAt || day.updated || '').toString().slice(0, 10);
    const topRedditPost = context?.redditResearch?.posts?.[0];
    const dayRedditUrl = day.redditUrl || topRedditPost?.permalink || null;
    const dayRedditTitle = day.redditTitle || topRedditPost?.title || null;

    const dayRecord = {
      dayNumber: di + 1,
      title: dayTitle,
      ...(sourceKey ? { sourceKey } : {}),
      streamDate,
      summary: String(day.summary || raw.summary || '').slice(0, 600),
      updated: new Date().toISOString(),
      isLive: false,
      timestampsApproximate,
      sources,
      eventsCount,
      events: normalized,
      ...(day.storyArcs?.length ? { storyArcs: day.storyArcs } : {})
    };
    if (dayRedditUrl) {
      dayRecord.redditUrl = dayRedditUrl;
      dayRecord.redditTitle = dayRedditTitle;
    }
    days[String(di + 1)] = dayRecord;
  });

  return {
    title: String(raw.title || days[Object.keys(days)[0]]?.title || '').slice(0, 150),
    summary: String(raw.summary || '').slice(0, 600),
    timestampsApproximate,
    sources,
    ...(sourceKey ? { sourceKey } : {}),
    ...(context?.filters ? { filters: context.filters } : {}),
    ...(context?.profileId ? { profile: context.profileId } : {}),
    ...(context?.redditResearch ? { redditResearch: context.redditResearch } : {}),
    days
  };
}

function enforceEvidenceOnlyRecap(recap, context) {
  if (context.transcript?.length || context.notes) return;
  const anchors = context.chapters || [];
  for (const day of Object.values(recap.days || {})) {
    for (const event of day.events || []) {
      let nearest = null;
      let nearestDistance = Infinity;
      for (const anchor of anchors) {
        const distance = Math.abs(Number(anchor.seconds || 0) - event.seconds);
        if (distance < nearestDistance) { nearest = anchor; nearestDistance = distance; }
      }
      if (nearest && nearestDistance <= 180) {
        event.title = String(nearest.title || 'Timestamp marker').slice(0, 120);
        event.evidence = String(nearest.title || '').slice(0, 220);
        event.description = context.transcriptionPending
          ? 'Community timestamp marker. Detailed caption will be added after VOD transcription completes.'
          : 'Timestamp marker from the available stream evidence; detailed caption is not verified.';
        event.confidence = 'low';
      } else {
        event.title = 'Unverified timestamp';
        event.description = context.transcriptionPending
          ? 'Caption pending VOD transcription.'
          : 'No reliable narrative evidence was available for this timestamp.';
        event.evidence = '';
        event.confidence = 'low';
      }
    }
    day.timestampsApproximate = true;
    day.sources = [...new Set([...(day.sources || []), context.transcriptionPending ? 'transcription-pending' : 'unverified'])];
  }
  recap.timestampsApproximate = true;
  recap.sources = [...new Set([...(recap.sources || []), context.transcriptionPending ? 'transcription-pending' : 'unverified'])];
}

// small helpers for evidence validation
export function normText(value) {
  return decodeCaptionText(value).toLowerCase();
}

// Extract probable named entities (Capitalized tokens, 2+ words, excluding stop words)
// from a short description so we can check they actually appear in the cited window.
function extractNamedEntities(text, max = 12) {
  const raw = String(text || '');
  const stopwords = new Set(['the', 'this', 'that', 'they', 'their', 'there', 'then', 'here', 'hers', 'his', 'him', 'her', 'and', 'with', 'for', 'are', 'you', 'your', 'our', 'why', 'what', 'when', 'how', 'who', 'which', 'where', 'was', 'were', 'will', 'would', 'could', 'should', 'have', 'has', 'had', 'i', 'we', 's', 't', 'm', 'it', 'its', 'at', 'by', 'on', 'in', 'of', 'to', 'from', 'as', 'or', 'an']);
  const candidates = [];
  const tokens = raw.split(/[^A-Za-z0-9']+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].length >= 2 && tokens[i][0] === tokens[i][0].toUpperCase() && tokens[i][0] !== tokens[i][0].toLowerCase()) {
      let phrase = tokens[i];
      let j = i + 1;
      while (j < tokens.length && tokens[j].length >= 2 && tokens[j][0] === tokens[j][0].toUpperCase() && tokens[j][0] !== tokens[j][0].toLowerCase()) {
        phrase += ' ' + tokens[j]; j++;
      }
      if (!stopwords.has(tokens[i].toLowerCase())) candidates.push(phrase);
      i = j;
    } else i++;
  }
  return candidates.slice(0, max);
}

// Deterministic, zero-token validation of every event against the timed transcript.
// - Evidence excerpt must fuzzy-match a segment within ~±30s of the event start.
// - Any capitalized entity in the description should appear in that same window.
// - Unsupported or contradicted events are downgraded (confidence 'low', checkable
//   validation flags set) rather than deleted, so drafts stay auditable.
function validateEventsAgainstEvidence(recap, context) {
  const segments = context.transcript || [];
  const notes = String(context.notes || '').trim();
  if (!segments.length && !notes) return;
  const index = (segments || []).map((seg) => ({ start: seg.start, end: seg.end, text: normText(seg.text || '') }));
  const windowSeconds = 35;

  for (const day of Object.values(recap.days || {})) {
    for (const event of day.events || []) {
      const start = Number(event.seconds) || 0;
      const window = index.filter((seg) => seg.start >= start - windowSeconds && seg.start <= start + windowSeconds);
      const windowText = window.map((seg) => seg.text).join(' ');
      const fullText = index.map((seg) => seg.text).join(' ');
      const evidence = normText(event.evidence || '');
      const claimed = Boolean(evidence.length > 3) || Boolean(event.evidence);
      let evidenceMatch = false;
      let evidenceNear = false;
      if (evidence) {
        const sig = evidence.slice(0, 40);
        const near = windowText.includes(sig);
        const anywhere = fullText.includes(sig);
        evidenceNear = anywhere && !near;
        evidenceMatch = near || anywhere;
      }
      const entities = extractNamedEntities(event.description || '');
      let missingEntities = 0;
      const entityHits = [];
      for (const ent of entities) {
        const hit = windowText.includes(ent.toLowerCase());
        if (hit) entityHits.push(ent);
        else missingEntities++;
      }
      const contained = claimed && evidenceMatch;
      let validation = 'unsupported';
      if (notes && !segments.length) {
        validation = 'notes';
      } else if (contained && evidenceNear) {
        validation = 'needs-review';
      } else if (contained && !evidenceNear && evidenceMatch) {
        validation = 'supported';
      } else if (contained && !evidenceMatch) {
        validation = 'unmatched';
      } else if (!claimed) {
        validation = 'no-evidence';
      }
      if ((validation === 'supported' || validation === 'needs-review') && missingEntities > Math.max(1, entities.length / 2)) {
        validation = entities.length ? 'entity-gap' : validation;
      }
      event.validation = validation;
      if (window.length) {
        event.evidenceWindow = { firstStart: window[0].start, lastEnd: window.at(-1).end, segmentCount: window.length };
      }
      if (validation === 'needs-review' || validation === 'unmatched' || validation === 'entity-gap') {
        event.confidence = 'low';
        event.needsReview = true;
      } else if (validation !== 'supported' && validation !== 'notes') {
        event.confidence = 'medium';
      }
    }
  }
}

function shouldRunVisionValidation(event) {
  const validation = String(event.validation || '').toLowerCase();
  return event.needsReview === true
    || String(event.confidence || '').toLowerCase() === 'low'
    || ['unsupported', 'no-evidence', 'unmatched', 'entity-gap', 'needs-review'].includes(validation);
}

function selectVisionCandidates(recap, context) {
  // Do not spend on provisional placeholder events before a queued transcript
  // finishes. Vision is most useful when the event already has a real claim to
  // check against the frame.
  if (context?.transcriptionPending || (!context?.transcript?.length && !String(context?.notes || '').trim())) return [];
  const frameBudget = Math.max(0, Math.min(100, Number(process.env.MAX_EVENT_FRAMES || 28) || 28));
  const limit = Math.min(VISION_VALIDATION_MAX_EVENTS, frameBudget);
  const events = Object.values(recap.days || {}).flatMap(day => day.events || []);
  return events
    .filter(shouldRunVisionValidation)
    .sort((a, b) => {
      const reviewDelta = Number(b.needsReview === true) - Number(a.needsReview === true);
      if (reviewDelta) return reviewDelta;
      return (Number(a.seconds) || 0) - (Number(b.seconds) || 0);
    })
    .slice(0, limit);
}

function eventImageToDataUrl(event) {
  const image = String(event.image || '');
  if (!image.startsWith('/images/frames/')) return null;
  const filePath = path.join(PUBLIC_FRAMES_DIR, path.basename(image));
  try {
    if (!fs.statSync(filePath).isFile()) return null;
    const bytes = fs.readFileSync(filePath);
    return bytes.length ? `data:image/jpeg;base64,${bytes.toString('base64')}` : null;
  } catch {
    return null;
  }
}

function normalizeVisionDecision(raw) {
  const decision = String(raw?.decision || '').toLowerCase().trim();
  if (!['confirm', 'downgrade', 'review'].includes(decision)) return null;
  return {
    decision,
    reason: String(raw.reason || '').slice(0, 300),
    visualEvidence: String(raw.visualEvidence || '').slice(0, 300),
    screenEconomy: raw.screenEconomy && raw.screenEconomy.visible ? {
      visible: true,
      details: String(raw.screenEconomy.details || '').slice(0, 150)
    } : null
  };
}

async function validateEventWithVision(event, context) {
  const imageUrl = eventImageToDataUrl(event);
  if (!imageUrl) return { status: 'skipped', reason: 'no-image' };

  const systemPrompt = `You are a conservative visual validator for a stream recap.\n\nCompare the screenshot with the event title, description, and transcript evidence. Confirm only what is clearly visible. A screenshot may support the visual setting or action, but it cannot prove an off-screen spoken claim. Treat ambiguous, unreadable, partial, or irrelevant frames as review. Downgrade claims visibly contradicted by the frame.\n\nAlso inspect the in-game screen/HUD for financial or phone UI:\n- If an in-game phone, crypto app (e.g. Octane, Ron), banking app, store register, or cash balance is clearly visible, extract it into screenEconomy: {"visible": true, "details": "short description of visible numbers/asset"}\n\nDo not rewrite or delete the event. Return ONLY JSON in this shape:\n{"decision":"confirm|downgrade|review","reason":"short explanation","visualEvidence":"short description of visible evidence","screenEconomy":{"visible":true|false,"details":"..."}}`;
  const userContent = [
    {
      type: 'text',
      text: JSON.stringify({
        task: 'Validate one recap event against one screenshot.',
        stream: { title: context.title || '', platform: context.platform || '' },
        event: {
          id: event.id,
          timestamp: event.timestamp,
          title: event.title,
          description: event.description,
          evidence: event.evidence,
          validation: event.validation,
          confidence: event.confidence
        }
      })
    },
    { type: 'image_url', image_url: { url: imageUrl } }
  ];

  const raw = parseJsonLoose(await callLLM(
    systemPrompt,
    '',
    Number(process.env.VISION_VALIDATION_TIMEOUT_MS || 60000),
    { model: VISION_VALIDATION_MODEL, maxTokens: 300, temperature: 0, userContent }
  ));
  const decision = normalizeVisionDecision(raw);
  if (!decision) throw new Error('Vision model returned an invalid decision.');
  return { status: 'complete', ...decision };
}

async function validateEventsWithVision(context, candidates) {
  let next = 0;
  const concurrency = Math.min(2, candidates.length);
  const runWorker = async () => {
    while (next < candidates.length) {
      const event = candidates[next++];
      const previousValidation = event.validation || null;
      try {
        const result = await validateEventWithVision(event, context);
        event.visionValidation = {
          ...result,
          model: VISION_VALIDATION_MODEL,
          validatedAt: new Date().toISOString(),
          previousValidation
        };
        if (result.screenEconomy?.visible) {
          if (event.economy) {
            event.economy.verification = 'screen-verified';
          } else {
            event.economy = { action: 'view', verification: 'screen-verified' };
          }
          event.economy.screenDetails = result.screenEconomy.details;
        }
        if (result.decision === 'confirm') {
          event.validation = 'vision-confirmed';
          event.confidence = 'medium';
          event.needsReview = false;
        } else if (result.decision === 'downgrade') {
          event.validation = 'vision-downgraded';
          event.confidence = 'low';
          event.needsReview = true;
        } else {
          event.validation = 'vision-needs-review';
          event.confidence = 'low';
          event.needsReview = true;
        }
      } catch (error) {
        event.visionValidation = {
          status: 'error',
          model: VISION_VALIDATION_MODEL,
          reason: 'Vision validation unavailable.',
          detail: String(error.message || '').slice(0, 240),
          validatedAt: new Date().toISOString(),
          previousValidation
        };
      }
    }
  };
  if (concurrency) await Promise.all(Array.from({ length: concurrency }, runWorker));
}

function sanitizePrematureEndingClaims(recap, context) {
  const duration = Number(context.lengthSeconds || 0);
  if (!duration) return;
  const endingPattern = /\b(stream|show|broadcast)\s+(ends?|concludes?|wraps? up)|winds? down|final (moments?|thoughts?|goodbye)|farewell|bids? farewell|signs? off/i;
  for (const day of Object.values(recap.days || {})) {
    for (const event of day.events || []) {
      if (event.seconds >= duration * 0.95) continue;
      const combined = `${event.title || ''} ${event.description || ''}`;
      if (!endingPattern.test(combined)) continue;
      const evidence = String(event.evidence || '').trim();
      event.confidence = 'low';
      event.title = evidence ? 'Mid-stream interaction' : 'Broadcast moment';
      event.description = evidence
        ? `The transcript or source evidence captures: “${evidence}”`
        : 'A recorded moment from the broadcast; the stream continues afterward.';
    }
  }
}

function withKickTimestamp(url, seconds) {
  const base = String(url || '').replace(/[?&]t=\d+$/, '');
  if (!base) return null;
  const offset = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${base}${base.includes('?') ? '&' : '?'}t=${offset}`;
}

function sanitizeChannelUrls(context) {
  const urls = {};
  if (context.platform === 'twitch') {
    if (context.latestVodId) {
      urls.twitchVod = `https://www.twitch.tv/videos/${context.latestVodId}`;
    } else if (context.url.includes('twitch.tv/videos')) {
      urls.twitchVod = context.url;
    }
  } else if (context.platform === 'youtube') {
    if (context.url.includes('watch') || context.url.includes('youtu.be')) {
      urls.youtubeUrl = context.url;
    }
  } else if (context.platform === 'kick') {
    if (context.url.includes('/videos/')) {
      urls.kickVod = context.url;
    }
  }
  return urls;
}

// ---------- povConfig helpers ----------

const COLOR_PRESETS = {
  amber:   { color: 'amber',   badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/30',    activeBg: 'bg-amber-500 text-black',  glowColor: 'shadow-amber-500/20' },
  rose:    { color: 'rose',    badgeColor: 'bg-rose-500/10 text-rose-400 border-rose-500/30',      activeBg: 'bg-rose-500 text-white',    glowColor: 'shadow-rose-500/20' },
  emerald: { color: 'emerald', badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30', activeBg: 'bg-emerald-500 text-black', glowColor: 'shadow-emerald-500/20' },
  sky:     { color: 'sky',     badgeColor: 'bg-sky-500/10 text-sky-400 border-sky-500/30',          activeBg: 'bg-sky-500 text-black',     glowColor: 'shadow-sky-500/20' },
  purple:  { color: 'purple',  badgeColor: 'bg-purple-500/10 text-purple-400 border-purple-500/30', activeBg: 'bg-purple-500 text-white',  glowColor: 'shadow-purple-500/20' },
  teal:    { color: 'teal',    badgeColor: 'bg-teal-500/10 text-teal-400 border-teal-500/30',       activeBg: 'bg-teal-500 text-black',    glowColor: 'shadow-teal-500/20' }
};

function loadPovConfig() {
  try { return JSON.parse(fs.readFileSync(POV_CONFIG_FILE, 'utf-8')); } catch { return { povs: [], defaultPov: null }; }
}

function savePovConfig(config) {
  fs.writeFileSync(POV_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

function getDaysData(pov = 'xqc') {
  try {
    const safe = sanitizePov(pov);
    const fileName = safe === 'xqc' ? 'daysData.json' : `${safe}DaysData.json`;
    const targetFile = path.join(SRC_DATA_DIR, fileName);
    if (fs.existsSync(targetFile)) {
      return JSON.parse(fs.readFileSync(targetFile, 'utf-8'));
    }
    return null;
  } catch {
    return null;
  }
}

function sanitizePov(value) {
  const cleaned = String(value || 'xqc').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return /^[a-z0-9_][a-z0-9_-]*$/.test(cleaned) ? cleaned : 'xqc';
}

// ---------- Background transcription jobs ----------

const TRANSCRIPTION_JOBS_FILE = path.join(DATA_DIR, 'transcription-jobs.json');
function loadTranscriptionJobs() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TRANSCRIPTION_JOBS_FILE, 'utf8'));
    return new Map(Object.entries(parsed || {}));
  } catch {
    return new Map();
  }
}
function persistTranscriptionJobs() {
  try {
    fs.writeFileSync(TRANSCRIPTION_JOBS_FILE, JSON.stringify(Object.fromEntries(TRANSCRIPTION_JOBS), null, 2));
  } catch {}
}
const TRANSCRIPTION_JOBS = loadTranscriptionJobs();
let activeTranscriptionJobId = null;

// FIFO transcription scheduler — runs jobs one at a time
function scheduleNextTranscription() {
  if (activeTranscriptionJobId) return;
  const now = Date.now();
  const maxRetries = Math.max(0, Number(process.env.TRANSCRIPTION_MAX_RETRIES || 5) || 5);
  const candidates = [...TRANSCRIPTION_JOBS.values()]
    .filter(job => {
      if (job.status === 'queued') return true;
      return job.status === 'rate-limited' && Number(job.retryCount || 0) < maxRetries;
    })
    .sort((a, b) => {
      const aTime = a.queuedAt || Date.parse(a.createdAt) || 0;
      const bTime = b.queuedAt || Date.parse(b.createdAt) || 0;
      return aTime === bTime ? String(a.id).localeCompare(String(b.id)) : aTime - bTime;
    });
  const next = candidates[0];
  if (!next) return;
  if (next.status === 'rate-limited' && next.retryAt) {
    const waitMs = Date.parse(next.retryAt) - now;
    if (waitMs > 0) {
      setTimeout(scheduleNextTranscription, waitMs);
      return;
    }
  }
  activeTranscriptionJobId = next.id;
  const job = TRANSCRIPTION_JOBS.get(next.id);
  if (job) {
    job.status = 'running';
    job.startedAt = job.startedAt || new Date().toISOString();
    job.retryAt = undefined;
    updateTranscriptionJobProgress(job, Math.max(job.progress || 0, 1), 'Preparing transcription');
    persistTranscriptionJobs();
  }
  executeTranscriptionJob(next.id);
}

function transcriptionQueuePosition(jobId) {
  const maxRetries = Math.max(0, Number(process.env.TRANSCRIPTION_MAX_RETRIES || 5) || 5);
  const queued = [...TRANSCRIPTION_JOBS.values()]
    .filter(job => (job.status === 'queued' || job.status === 'rate-limited') && Number(job.retryCount || 0) < maxRetries)
    .sort((a, b) => {
      const aTime = a.queuedAt || Date.parse(a.createdAt) || 0;
      const bTime = b.queuedAt || Date.parse(b.createdAt) || 0;
      return aTime === bTime ? String(a.id).localeCompare(String(b.id)) : aTime - bTime;
    });
  const index = queued.findIndex(job => job.id === jobId);
  return index < 0 ? null : index + 1;
}

function exposeTranscriptionJob(job) {
  return { ...job, queuePosition: transcriptionQueuePosition(job.id) };
}

async function executeTranscriptionJob(jobId) {
  const job = TRANSCRIPTION_JOBS.get(jobId);
  if (!job || !job.requestBody) {
    if (job) { job.status = 'failed'; job.error = 'Job missing request body'; persistTranscriptionJobs(); }
    activeTranscriptionJobId = null;
    scheduleNextTranscription();
    return;
  }
  const MAX_RETRIES = Math.max(0, Number(process.env.TRANSCRIPTION_MAX_RETRIES || 5) || 5);
  try {
    const response = await postInternalGenerate(
      { ...job.requestBody, _background: true, _jobId: jobId },
      3 * 60 * 60 * 1000
    );
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('Background generation returned an invalid response'); }
    if (!response.ok || !result.ok) {
      const error = new Error(result.error || 'Background generation failed');
      error.retryAfterMs = result.retryAfterMs;
      if (result.code) error.code = result.code;
      throw error;
    }
    if (result.batch?.batchId) {
      job.mode = 'batch';
      job.batchId = result.batch.batchId;
      job.batchExpiresAt = result.batch.expiresAt || null;
      job.batchJobToken = result.batch.jobToken || null;
      job.batchAudioSeconds = result.batch.audioSeconds || 0;
      job.stage = 'Batch submitted - Groq processing (up to 24h)';
      job.progress = Math.max(job.progress || 0, 60);
      persistTranscriptionJobs();
      console.error('[Batch]', jobId, 'awaiting batch', result.batch.batchId);
      activeTranscriptionJobId = null;
      scheduleNextTranscription();
      pollBatchJob(jobId);
      return;
    }
    job.status = 'completed';
    updateTranscriptionJobProgress(job, 100, 'Complete');
    job.completedAt = new Date().toISOString();
    job.data = result.data;
    persistTranscriptionJobs();
    activeTranscriptionJobId = null;
    scheduleNextTranscription();
  } catch (error) {
    const failedStage = job.stage || 'unknown stage';
    const budgetExhausted = error.code === 'TRANSCRIPTION_BUDGET_EXHAUSTED';
    const rateLimited = !budgetExhausted && Number(error.retryAfterMs || 0) > 0;
    if (rateLimited && (job.retryCount || 0) < MAX_RETRIES) {
      job.retryCount = (job.retryCount || 0) + 1;
      const delayMs = Math.max(5000, Math.min(300000, Number(error.retryAfterMs || 30000)));
      job.status = 'rate-limited';
      job.stage = 'Provider cooldown - auto-retry ' + job.retryCount + '/' + MAX_RETRIES;
      job.error = error.message || 'Transient rate limit';
      job.retryAt = new Date(Date.now() + delayMs).toISOString();
      persistTranscriptionJobs();
      console.error('[Transcription]', jobId, 'rate-limited; parking for', Math.round(delayMs / 1000) + 's (' + job.retryCount + '/' + MAX_RETRIES + ')');
      activeTranscriptionJobId = null;
      scheduleNextTranscription();
      return;
    }
    job.status = budgetExhausted ? 'budget-exhausted' : rateLimited ? 'rate-limited' : 'failed';
    job.stage = budgetExhausted ? 'Groq spend cap reached' : rateLimited ? 'Groq cooldown' : 'Failed';
    job.progress = Math.min(job.progress || 0, 99);
    job.error = (error.message || 'Background transcription failed') + ' (stage: ' + failedStage + ')';
    if (rateLimited) job.retryAt = new Date(Date.now() + error.retryAfterMs).toISOString();
    persistTranscriptionJobs();
    console.error('[Transcription]', jobId, 'failed during', failedStage + ':', error.stack || error.message || error);
    activeTranscriptionJobId = null;
    scheduleNextTranscription();
  }
}

// ---------- Groq monthly spend tracking (estimated) ----------
// Groq exposes no usage/billing API, so we estimate spend from transcribed audio
// hours at the published per-hour rate. Good enough to show a budget bar and to
// warn before jobs start failing at the cap. Not an invoice.
const GROQ_USAGE_FILE = path.join(DATA_DIR, 'groq-usage.json');
const GROQ_MONTHLY_CAP_DOLLARS = Math.max(0, Number(process.env.GROQ_MONTHLY_CAP_DOLLARS || 10) || 0);
// whisper-large-v3(-turbo) bill at $0.40 per audio-hour; distil-whisper is $0.04.
function groqAudioRatePerHour(modelName, isBatch = false) {
  const base = String(modelName || '').toLowerCase().includes('distil') ? 0.04 : 0.40;
  return isBatch ? base / 2 : base;
}
function groqMonthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
function loadGroqUsage() {
  try {
    return JSON.parse(fs.readFileSync(GROQ_USAGE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}
function persistGroqUsage(usage) {
  try { fs.writeFileSync(GROQ_USAGE_FILE, JSON.stringify(usage, null, 2)); } catch {}
}
function recordGroqUsage(audioSeconds, modelName, isBatch = false) {
  const hours = Math.max(0, Number(audioSeconds) || 0) / 3600;
  if (hours <= 0) return;
  const usage = loadGroqUsage();
  const key = groqMonthKey();
  const entry = usage[key] || { audioSeconds: 0, spendDollars: 0 };
  entry.audioSeconds += Math.round(hours * 3600);
  entry.spendDollars = Math.round((entry.spendDollars + hours * groqAudioRatePerHour(modelName, isBatch)) * 1000) / 1000;
  usage[key] = entry;
  persistGroqUsage(usage);
}
function groqUsageSummary() {
  const usage = loadGroqUsage() || {};
  const entry = usage[groqMonthKey()] || { audioSeconds: 0, spendDollars: 0 };
  const spendDollars = Math.round((entry.spendDollars || 0) * 100) / 100;
  const remaining = Math.max(0, Math.round((GROQ_MONTHLY_CAP_DOLLARS - spendDollars) * 100) / 100);
  return {
    provider: String(process.env.TRANSCRIPTION_PROVIDER || '').toLowerCase(),
    month: groqMonthKey(),
    capDollars: GROQ_MONTHLY_CAP_DOLLARS,
    audioSeconds: entry.audioSeconds || 0,
    audioHours: Math.round((entry.audioSeconds || 0) / 360) / 10,
    spendDollars,
    remainingDollars: remaining,
    pct: GROQ_MONTHLY_CAP_DOLLARS > 0 ? Math.min(100, Math.round((spendDollars / GROQ_MONTHLY_CAP_DOLLARS) * 100)) : 0
  };
}

// ---------- Groq Batch API (overnight, -50% cost) ----------
// Pack all audio chunks into one JSONL file; Groq processes them asynchronously
// (24h-7d window) at half the synchronous price. Groq fetches each chunk from a
// PUBLIC url, so batch mode requires GROQ_BATCH_BASE_URL to point at a reachable
// tunnel/domain for this server (e.g. https://xxx.trycloudflare.com).
const GROQ_BATCH_API = 'https://api.groq.com/openai/v1';
const BATCH_AUDIO_DIR = path.join(DATA_DIR, 'batch-audio');
const BATCH_TRANSCRIPT_DIR = path.join(DATA_DIR, 'batch-transcripts');
for (const d of [BATCH_AUDIO_DIR, BATCH_TRANSCRIPT_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}

function groqBatchBaseUrl() {
  return String(process.env.GROQ_BATCH_BASE_URL || '').trim().replace(/\/+$/, '');
}

function batchModelName() {
  const model = String(process.env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo').trim();
  // distil-whisper is NOT offered on the batch API - fail loudly instead of submitting a job that errors.
  if (model.includes('distil')) {
    throw new Error('distil-whisper is not available on Groq batch API. Use GROQ_TRANSCRIPTION_MODEL=whisper-large-v3-turbo for batch mode.');
  }
  return model;
}

async function uploadGroqBatchFile(jsonlPath) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('No GROQ_API_KEY configured for batch transcription.');
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(jsonlPath)], { type: 'application/jsonl' }), 'batch.jsonl');
  form.append('purpose', 'batch');
  const res = await fetchT(`${GROQ_BATCH_API}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  }, 60000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Groq batch file upload failed (${res.status}): ${data?.error?.message || JSON.stringify(data).slice(0, 300)}`);
    err.code = res.status === 402 ? 'TRANSCRIPTION_BUDGET_EXHAUSTED' : undefined;
    throw err;
  }
  return data.id;
}

async function createGroqBatch(inputFileId) {
  const apiKey = process.env.GROQ_API_KEY;
  const res = await fetchT(`${GROQ_BATCH_API}/batches`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input_file_id: inputFileId,
      endpoint: '/v1/audio/transcriptions',
      completion_window: '24h'
    })
  }, 60000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Groq batch submission failed (${res.status}): ${data?.error?.message || JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function groqBatchStatus(batchId) {
  const apiKey = process.env.GROQ_API_KEY;
  const res = await fetchT(`${GROQ_BATCH_API}/batches/${encodeURIComponent(batchId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  }, 30000);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new Error(`Groq batch status failed (${res.status}): ${data?.error?.message || JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function groqBatchResultSegments(outputFileId) {
  const apiKey = process.env.GROQ_API_KEY;
  const res = await fetchT(`${GROQ_BATCH_API}/files/${encodeURIComponent(outputFileId)}/content`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  }, 120000);
  if (!res.ok) throw new Error(`Groq batch results fetch failed (${res.status})`);
  const text = await res.text();
  const segments = [];
  for (const line of text.split(/\r?\n/).filter(l => l.trim())) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    const resp = parsed?.response || {};
    const respBody = resp.body || {};
    // Groq encodes per-request failures as status_code inside response; the
    // top-level "error" field stays null unless the whole batch failed.
    if (resp.status_code && resp.status_code !== 200) {
      console.error(`[Batch] request ${parsed.custom_id} failed (${resp.status_code}): ${respBody.error?.message || JSON.stringify(respBody).slice(0, 200)}`);
      continue;
    }
    if (parsed?.error) {
      console.error(`[Batch] request ${parsed.custom_id} error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
      continue;
    }
    const customId = String(parsed?.custom_id || '');
    const match = customId.match(/^chunk-(\d+)$/);
    const offset = match ? Number(match[1]) * 600 : 0;
    for (const seg of (respBody.segments || [])) {
      const start = offset + Number(seg.start || 0);
      const end = offset + Number(seg.end || seg.start || 0);
      const textValue = decodeCaptionText(seg.text || '');
      if (textValue) segments.push({ start, end, text: textValue });
    }
  }
  return segments.sort((a, b) => a.start - b.start);
}

function writeBatchTranscript(jobId, segments, lengthSeconds) {
  const safeId = String(jobId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const file = `${safeId}.json`;
  fs.writeFileSync(path.join(BATCH_TRANSCRIPT_DIR, file), JSON.stringify({ lengthSeconds: Number(lengthSeconds) || 0, segments }, null, 2));
  return file;
}

function readBatchTranscript(file) {
  if (!/^[a-zA-Z0-9_-]+\.json$/.test(String(file || ''))) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(BATCH_TRANSCRIPT_DIR, file), 'utf8'));
    return Array.isArray(data.segments) ? data : null;
  } catch { return null; }
}

function transcriptionProviderConfigured() {
  const provider = String(process.env.TRANSCRIPTION_PROVIDER || '').toLowerCase();
  return (provider === 'groq' && !!process.env.GROQ_API_KEY)
    || (provider === 'openai' && !!process.env.OPENAI_API_KEY)
    || (provider === 'deepgram' && !!process.env.DEEPGRAM_API_KEY)
    || (provider === 'local' && !!process.env.LOCAL_WHISPER_BASE_URL);
}

function updateTranscriptionJobProgress(job, progress, stage) {
  const nextProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  job.progress = nextProgress;
  job.stage = stage;
  const now = Date.now();

  // The 35-95 range is the measurable chunk-transcription phase. Avoid making
  // a confident estimate while downloading/splitting audio or after completion.
  if (nextProgress >= 35 && nextProgress < 95) {
    if (!job.transcriptionStartedAt) job.transcriptionStartedAt = new Date(now).toISOString();
    const elapsedSeconds = Math.max(0, (now - Date.parse(job.transcriptionStartedAt)) / 1000);
    const phaseDone = Math.max(0.5, nextProgress - 35);
    const phaseRemaining = Math.max(0, 95 - nextProgress);
    if (elapsedSeconds >= 5 && phaseDone >= 2) {
      job.etaSeconds = Math.max(1, Math.ceil((elapsedSeconds * phaseRemaining) / phaseDone + 30));
      job.etaUpdatedAt = new Date(now).toISOString();
    }
  } else if (nextProgress >= 95 && nextProgress < 100) {
    job.etaSeconds = 30;
    job.etaUpdatedAt = new Date(now).toISOString();
  } else if (nextProgress >= 100) {
    job.etaSeconds = 0;
  }
}

function queueLongTranscription(body, streamId, context = null) {
  const jobId = `${streamId}-${Date.now()}`;
  const requestBody = { ...body };
  delete requestBody._background;
  delete requestBody._jobId;
  delete requestBody._transcriptFile;
  TRANSCRIPTION_JOBS.set(jobId, {
    id: jobId, streamId,
    status: 'queued', progress: 0, etaSeconds: null, stage: 'Queued',
    createdAt: new Date().toISOString(),
    queuedAt: Date.now(),
    requestBody,
    vodDate: String(context?.vodStartAt || context?.vodCreatedAt || '').slice(0, 10) || null,
    retryCount: 0
  });
  persistTranscriptionJobs();
  scheduleNextTranscription();
  return jobId;
}

// Recover transcription jobs on server restart
function recoverTranscriptionJobs() {
  for (const [jobId, job] of TRANSCRIPTION_JOBS) {
    if (job.status === 'running') {
      if (job.mode === 'batch' && job.batchId) {
        // Running batch jobs remain for resumePendingBatchJobs
        continue;
      }
      if (job.requestBody) {
        // Requeue running non-batch jobs from start
        job.status = 'queued';
        job.progress = 0;
        job.stage = 'Queued';
        job.startedAt = undefined;
        job.transcriptionStartedAt = undefined;
        job.etaSeconds = null;
        job.retryAt = undefined;
        job.error = undefined;
        console.error('[Recovery]', jobId, 'requeued for fresh start');
      } else {
        // Legacy running job without requestBody — permanently fail
        job.status = 'failed';
        job.stage = 'Failed';
        job.error = 'Server restart interrupted transcription - job cannot be resumed without request body';
        console.error('[Recovery]', jobId, 'no requestBody available, permanently failed');
      }
    }
    // queued stays queued, rate-limited stays rate-limited, failed stays failed
  }
  persistTranscriptionJobs();
}

// ---------- Batch job polling & finalization ----------
// The batch is owned by Groq for up to the completion window; we poll cheaply,
// then reassemble the transcript and re-run generation with the cached file.
const BATCH_POLL_MS = 60000;

async function pollBatchJob(jobId) {
  const job = TRANSCRIPTION_JOBS.get(jobId);
  if (!job || job.status !== 'running' || !job.batchId) return;
  try {
    const status = await groqBatchStatus(job.batchId);
    const counts = status.request_counts || {};
    const total = counts.total || 0;
    const completed = counts.completed || 0;
    if (total > 0) {
      job.progress = Math.min(94, 60 + Math.round((completed / total) * 34));
      job.stage = `Groq batch - ${completed}/${total} chunks transcribed`;
      persistTranscriptionJobs();
    }
    if (status.status === 'completed') {
      await finalizeBatchJob(jobId, status.output_file_id);
      return;
    }
    if (['failed', 'expired', 'cancelled', 'cancelling'].includes(status.status)) {
      job.status = 'failed';
      job.stage = `Batch ${status.status}`;
      job.error = status.error?.message || `Groq batch ${status.status}.`;
      job.progress = Math.min(job.progress || 0, 99);
      persistTranscriptionJobs();
      cleanupBatchArtifacts(job);
      return;
    }
    // still validating / in_progress: keep polling
    setTimeout(() => pollBatchJob(jobId), BATCH_POLL_MS);
  } catch (error) {
    console.error(`[Batch] poll ${jobId} error: ${error.message}`);
    setTimeout(() => pollBatchJob(jobId), BATCH_POLL_MS);
  }
}

async function finalizeBatchJob(jobId, outputFileId) {
  const job = TRANSCRIPTION_JOBS.get(jobId);
  if (!job) return;
  job.stage = 'Downloading batch transcript';
  persistTranscriptionJobs();
  try {
    const segments = await groqBatchResultSegments(outputFileId);
    if (!segments.length) throw new Error('Batch completed but no transcript segments were produced.');
    const transcriptFile = writeBatchTranscript(jobId, segments, job.batchAudioSeconds || 0);
    job.batchTranscriptFile = transcriptFile;
    job.stage = 'Generating recap from transcript';
    job.progress = 95;
    persistTranscriptionJobs();
    const response = await postInternalGenerate(
      { ...(job.requestBody || {}), _background: true, _jobId: jobId, _transcriptFile: transcriptFile },
      3 * 60 * 60 * 1000
    );
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('Background generation returned an invalid response'); }
    if (!response.ok || !result.ok) throw new Error(result.error || 'Background generation failed');
    job.status = 'completed';
    job.progress = 100;
    job.stage = 'Complete';
    job.completedAt = new Date().toISOString();
    job.data = result.data;
    persistTranscriptionJobs();
  } catch (error) {
    job.status = 'failed';
    job.stage = 'Failed';
    job.error = error.message || 'Batch transcription failed';
    job.progress = Math.min(job.progress || 0, 99);
    persistTranscriptionJobs();
    console.error(`[Batch] ${jobId} failed: ${job.error}`);
  } finally {
    cleanupBatchArtifacts(job);
  }
}

function cleanupBatchArtifacts(job) {
  try { if (job?.batchJobToken) fs.rmSync(path.join(BATCH_AUDIO_DIR, job.batchJobToken), { recursive: true, force: true }); } catch {}
  try { if (job?.batchTranscriptFile) fs.rmSync(path.join(BATCH_TRANSCRIPT_DIR, job.batchTranscriptFile), { force: true }); } catch {}
}

function resumePendingBatchJobs() {
  for (const [jobId, job] of TRANSCRIPTION_JOBS) {
    if (job.status === 'running' && job.mode === 'batch' && job.batchId) {
      console.error(`[Batch] resuming poll for ${jobId}`);
      pollBatchJob(jobId);
    }
  }
}

app.get('/api/transcription-jobs', (req, res) => {
  const streamId = req.query.streamId?.toString();
  const jobs = [...TRANSCRIPTION_JOBS.values()]
    .filter(job => !streamId || job.streamId === streamId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const usage = groqUsageSummary();
  res.json({ jobs: jobs.map(job => ({ ...exposeTranscriptionJob(job), usage })) });
});

app.get('/api/transcription-jobs/:id', (req, res) => {
  const job = TRANSCRIPTION_JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Transcription job not found' });
  res.json({ ...exposeTranscriptionJob(job), usage: groqUsageSummary() });
});

app.get('/api/transcription/usage', (_req, res) => {
  res.json(groqUsageSummary());
});

// Serve chunk audio for Groq batch transcription. Only reachable via a public
// tunnel URL (GROQ_BATCH_BASE_URL) - Groq fetches these URLs server-side.
app.get('/batch-audio/:jobToken/:file', (req, res) => {
  const jobToken = String(req.params.jobToken || '');
  const file = String(req.params.file || '');
  if (!/^[a-zA-Z0-9_.-]+$/.test(jobToken) || !/^chunk_\d+\.mp3$/.test(file)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const full = path.join(BATCH_AUDIO_DIR, jobToken, file);
  try {
    if (!fs.statSync(full).isFile()) return res.status(404).json({ error: 'Not found' });
  } catch {
    return res.status(404).json({ error: 'Not found' });
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(full);
});

// ---------- Routes ----------

app.get('/api/health', (_req, res) => {
  const twitchConfigured = !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);
  const transcriptionProvider = String(process.env.TRANSCRIPTION_PROVIDER || '').toLowerCase();
  const transcriptionConfigured = transcriptionProvider === 'groq'
    ? !!process.env.GROQ_API_KEY
    : transcriptionProvider === 'openai'
      ? !!process.env.OPENAI_API_KEY
      : transcriptionProvider === 'deepgram'
        ? !!process.env.DEEPGRAM_API_KEY
        : transcriptionProvider === 'local'
          ? !!process.env.LOCAL_WHISPER_BASE_URL
          : false;
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    name: 'StreamRecap AI Recap API',
    model: RECAP_MODEL,
    llmConfigured: !!getOpenRouterKey(),
    twitchEvidenceEnabled: twitchConfigured,
    transcriptionProvider: transcriptionProvider || null,
    transcriptionConfigured,
    localWhisperProtocol: transcriptionProvider === 'local'
      ? String(process.env.LOCAL_WHISPER_PROTOCOL || 'openai').toLowerCase()
      : null,
    localWhisperModel: transcriptionProvider === 'local'
      ? String(process.env.LOCAL_WHISPER_MODEL || '')
      : null,
    visionValidationEnabled: VISION_VALIDATION_ENABLED,
    visionValidationModel: VISION_VALIDATION_MODEL,
    visionValidationMaxEvents: VISION_VALIDATION_MAX_EVENTS,
    streams: loadPovConfig().povs?.map(p => p.id) || []
  });
});

app.get('/api/povs', (_req, res) => {
  res.json(loadPovConfig());
});

// Library of all generated streams with a home-card preview (first screenshot, counts).
app.get('/api/library', (_req, res) => {
  const config = loadPovConfig();
  const streams = (config.povs || []).map(p => {
    const data = getDaysData(p.id) || {};
    const days = data.days || {};
    const dayKeys = Object.keys(days).sort((a, b) => Number(a) - Number(b));
    const firstDay = dayKeys.length ? days[dayKeys[0]] : {};
    const events = firstDay.events || [];
    const firstEvt = events.find(e => e.image) || events[0] || null;
    const totalEvents = dayKeys.reduce((n, k) => n + ((days[k].events || []).length), 0);
    return {
      id: p.id,
      name: p.name,
      color: p.color || 'amber',
      platform: p.platform || '',
      title: data.title || firstDay.title || p.name,
      updated: firstDay.updated || data.updated || '',
      eventCount: events.length,
      totalEvents,
      dayCount: dayKeys.length,
      timestampsApproximate: !!firstDay?.timestampsApproximate,
      firstImage: firstEvt?.image || null,
      firstTimestamp: firstEvt?.timestamp || null,
      isGenerated: p.sourceLabel === 'AI-generated recap'
    };
  });
  res.json({ streams });
});

// Tell the frontend whether its stored key is valid (read-only check; the key
// itself is only ever compared, never returned).
app.get('/api/auth/check', (req, res) => {
  const provided = String(req.query.key || req.get('x-owner-key') || '');
  // Open mode (no OWNER_KEY) reports owner:true so the frontend shows the editor.
  res.json({ owner: !OWNER_KEY || (provided && provided === OWNER_KEY), configured: !!OWNER_KEY });
});

// Remove a generated stream and its generated recap/media artifacts.
// Seed/demo streams remain protected so testing cannot accidentally erase them.
app.delete('/api/streams/:id', requireOwner, (req, res) => {
  const id = sanitizePov(req.params.id);
  const config = loadPovConfig();
  const stream = (config.povs || []).find(p => p.id === id);
  if (!stream) return res.status(404).json({ error: 'Stream not found.' });

  const nextConfig = { ...config, povs: config.povs.filter(p => p.id !== id) };
  savePovConfig(nextConfig);

  const file = id === 'xqc' ? 'daysData.json' : `${id}DaysData.json`;
  try { fs.rmSync(path.join(SRC_DATA_DIR, file), { force: true }); } catch {}
  purgeRedditCacheForStream(id);
  for (const dir of [path.join(__dirname, 'public', 'images', 'frames'), path.join(__dirname, 'dist', 'images', 'frames')]) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (file.startsWith(`${id}_`)) fs.rmSync(path.join(dir, file), { force: true });
      }
    } catch {}
  }
  res.json({ ok: true, removed: id });
});

// Channel registry for name autocomplete (no API keys needed)
app.get('/api/channels', (req, res) => {
  res.json({ suggestions: registrySuggestions(req.query.q) });
});

// Resolve a bare channel name to platform(s) + latest broadcast metadata
app.get('/api/channel/resolve', async (req, res) => {
  const name = (req.query.q || req.query.name || '').toString();
  try {
    const result = await resolveChannel(name);
    if (!result) {
      return res.status(400).json({ error: 'Provide a channel name to resolve.' });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to resolve channel name.' });
  }
});

// Search community (Reddit) threads on-demand for any moment or topic
app.get('/api/community/search', async (req, res) => {
  const q = String(req.query.q || req.query.query || '').trim();
  if (!q) return res.status(400).json({ error: 'Provide a search query (e.g. ?q=casino+heist)' });
  const subreddits = req.query.subreddits ? String(req.query.subreddits).split(',').map(s => s.trim()).filter(Boolean) : ['GTARP', 'LivestreamFail', 'xqcow'];
  try {
    const results = await searchCommunityThreads(q, subreddits);
    res.json({ ok: true, query: q, subreddits, results });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Search failed' });
  }
});

// Look up character dossier from NoPixel Fandom Wiki (for character hub & preview)
app.get('/api/wiki/character', async (req, res) => {
  const name = String(req.query.name || req.query.q || '').trim();
  if (!name) return res.status(400).json({ error: 'Provide a character or streamer name (e.g. ?name=buddha)' });
  try {
    const character = await fetchCharacterDossier(name);
    if (!character) return res.status(404).json({ error: 'Character dossier not found on NoPixel wiki' });
    res.json({ ok: true, character });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Wiki lookup failed' });
  }
});

// Character Hub: List all characters with their moment counts & dossiers
app.get('/api/characters', (_req, res) => {
  res.json({ characters: aggregateAllCharacters() });
});

// Character Hub: Get specific character dossier and all their timeline moments across streams
app.get('/api/characters/:name', async (req, res) => {
  const name = String(req.params.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Provide a character name.' });
  try {
    const dossier = await fetchCharacterDossier(name);
    const moments = getMomentsForCharacter(name);
    res.json({ ok: true, name, character: dossier, moments });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch character details' });
  }
});

app.patch('/api/streams/:id/events/:eventId/review', requireOwner, (req, res) => {
  const pov = sanitizePov(req.params.id);
  const eventId = String(req.params.eventId || '');
  const decision = String(req.body?.decision || '').toLowerCase();
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'Decision must be approved or rejected.' });
  }

  const data = getDaysData(pov);
  if (!data) return res.status(404).json({ error: `Recap data not found for: ${pov}` });
  let found = null;
  for (const day of Object.values(data.days || {})) {
    const event = (day.events || []).find(item => item.id === eventId);
    if (event) { found = event; break; }
  }
  if (!found) return res.status(404).json({ error: 'Timeline event not found.' });

  found.needsReview = false;
  found.validation = decision === 'approved' ? 'human-confirmed' : 'human-rejected';
  found.humanReview = {
    decision,
    reviewedAt: new Date().toISOString()
  };
  const fileName = pov === 'xqc' ? 'daysData.json' : `${pov}DaysData.json`;
  fs.writeFileSync(path.join(SRC_DATA_DIR, fileName), JSON.stringify(data, null, 2), 'utf-8');
  res.json({ ok: true, event: found });
});

app.post('/api/streams/:id/events/:eventId/frame', requireOwner, async (req, res) => {
  const pov = sanitizePov(req.params.id);
  const eventId = String(req.params.eventId || '');
  const data = getDaysData(pov);
  if (!data) return res.status(404).json({ error: `Recap data not found for: ${pov}` });

  let found = null;
  const requestedDay = String(req.query.day || '');
  const candidateDays = requestedDay && data.days?.[requestedDay]
    ? [data.days[requestedDay]]
    : Object.values(data.days || {});
  for (const day of candidateDays) {
    const event = (day.events || []).find(item => item.id === eventId);
    if (event) { found = event; break; }
  }
  if (!found) return res.status(404).json({ error: 'Timeline event not found.' });
  if (found.image && fs.existsSync(path.join(PUBLIC_FRAMES_DIR, path.basename(found.image)))) {
    return res.json({ ok: true, event: found, cached: true });
  }

  const source = found.kickUrl || found.twitchUrl || found.youtubeUrl;
  if (!source) return res.status(422).json({ error: 'No VOD source is available for this event.' });
  let baseUrl = source;
  try {
    const parsed = new URL(source);
    parsed.searchParams.delete('t');
    baseUrl = parsed.toString();
  } catch {}

  const context = { url: baseUrl, platform: baseUrl.includes('kick.com') ? 'kick' : baseUrl.includes('twitch.tv') ? 'twitch' : 'youtube' };
  if (context.platform === 'kick') context.transcriptionSourceUrl = await resolveKickPlaybackUrl(baseUrl);
  if (context.platform === 'twitch') context.latestVodId = baseUrl.match(/videos\/(\d+)/i)?.[1] || null;
  const directUrl = await resolveDirectStreamUrl(context);
  if (!directUrl) return res.status(502).json({ error: 'Unable to resolve the VOD playback URL for this screenshot.' });

  ensureFrameDirs();
  const safeTs = formatTimestamp(found.seconds).replace(/:/g, '');
  const fileName = `${pov}_evt_${String(found.seconds).padStart(6, '0')}_${safeTs}.jpg`;
  const publicPath = path.join(PUBLIC_FRAMES_DIR, fileName);
  const ok = await captureFrameSeconds(directUrl, found.seconds, publicPath);
  if (!ok) return res.status(504).json({ error: 'The VOD did not return a frame at this timestamp.' });
  try { fs.copyFileSync(publicPath, path.join(DIST_FRAMES_DIR, fileName)); } catch {}

  found.image = `/images/frames/${fileName}`;
  found.imageCaption = `Stream snapshot @ ${found.timestamp}`;
  const fileNameData = pov === 'xqc' ? 'daysData.json' : `${pov}DaysData.json`;
  fs.writeFileSync(path.join(SRC_DATA_DIR, fileNameData), JSON.stringify(data, null, 2), 'utf-8');
  res.json({ ok: true, event: found, cached: false });
});

app.delete('/api/streams/:id/days/:dayNum', requireOwner, (req, res) => {
  const pov = sanitizePov(req.params.id);
  const dayNum = String(req.params.dayNum || '');
  if (!/^\d+$/.test(dayNum)) return res.status(400).json({ error: 'Invalid day number.' });

  const config = loadPovConfig();
  const stream = (config.povs || []).find(item => item.id === pov);
  if (!stream) return res.status(404).json({ error: 'Stream not found.' });

  const data = getDaysData(pov);
  if (!data?.days?.[dayNum]) return res.status(404).json({ error: 'Stream day not found.' });
  const fileName = pov === 'xqc' ? 'daysData.json' : `${pov}DaysData.json`;
  const filePath = path.join(SRC_DATA_DIR, fileName);
  const day = data.days[dayNum];

  // Remove screenshots belonging only to the deleted day.
  for (const event of day.events || []) {
    const image = String(event.image || '');
    if (!image.startsWith('/images/frames/')) continue;
    const frameName = path.basename(image);
    for (const directory of [
      path.join(__dirname, 'public', 'images', 'frames'),
      path.join(__dirname, 'dist', 'images', 'frames')
    ]) {
      try { fs.rmSync(path.join(directory, frameName), { force: true }); } catch {}
    }
  }

  const remaining = Object.entries(data.days)
    .filter(([key]) => key !== dayNum)
    .sort(([a], [b]) => Number(a) - Number(b));
  const nextDays = {};
  remaining.forEach(([, value], index) => {
    nextDays[String(index + 1)] = { ...value, dayNumber: index + 1 };
  });

  if (!remaining.length) {
    try { fs.rmSync(filePath, { force: true }); } catch {}
    savePovConfig({ ...config, povs: (config.povs || []).filter(item => item.id !== pov) });
    return res.json({ ok: true, removedDay: dayNum, removedStream: true, data: null });
  }

  const nextData = { ...data, days: nextDays };
  fs.writeFileSync(filePath, JSON.stringify(nextData, null, 2), 'utf-8');
  res.json({ ok: true, removedDay: dayNum, removedStream: false, data: nextData });
});

app.get('/api/days', (req, res) => {
  const pov = sanitizePov((req.query.pov || 'xqc').toString());
  const data = getDaysData(pov);
  if (data) {
    res.json(data);
  } else {
    res.status(404).json({ error: `Recap data not found for: ${pov} — generate one with the Add Stream button.` });
  }
});

// Light refresh — re-reads the data files (no legacy sync pipeline)
app.post('/api/sync', requireOwner, (req, res) => {
  const pov = sanitizePov((req.query.pov || req.body?.pov || 'xqc').toString());
  const data = getDaysData(pov);
  res.json({ ok: true, cached: true, message: 'Data re-read from disk', data });
});

// Gather real timestamp evidence for a live Twitch recap: community clips + chat-velocity spikes.
// Requires a Twitch app token (the .env credentials); otherwise returns [] and the recap stays approximate.
async function gatherTwitchEvidence(context) {
  if (!context.latestVodId && !context.twitchBroadcasterId) return;
  const startedAt = context.vodStartAt || '';
  const endedAt = startedAt && context.lengthSeconds
    ? new Date(new Date(startedAt).getTime() + (context.lengthSeconds + 3600) * 1000).toISOString()
    : '';
  const clips = await fetchTwitchClips(context.twitchBroadcasterId, context.latestVodId, startedAt, endedAt);
  if (clips.length) {
    context.chapters = clips;
    context.chapterSource = 'twitch-clips';
  }
  const spikes = await fetchChatSpikeSeconds(context.twitchBroadcasterId, context.lengthSeconds, startedAt);
  if (spikes.length) {
    const seen = new Set(context.chapters.map(c => c.seconds));
    for (const s of spikes) {
      if (!seen.has(s.seconds)) { context.chapters.push(s); seen.add(s.seconds); }
    }
    context.chapters.sort((a, b) => a.seconds - b.seconds);
    if (context.chapterSource !== 'twitch-clips') context.chapterSource = 'chat-spikes';
  }
}

// Fill long uncovered sections with explicitly approximate, evenly distributed events.
// This is separate from the evidence-backed pass so we never confuse invented coverage
// with real clips/chapters.
async function fillCoverageGaps(recap, context, streamId) {
  // Never invent narrative captions while a Twitch/Kick transcript is unavailable.
  // The background transcription job will replace this provisional recap later.
  if (!context.transcript?.length && !context.notes) return;
  const duration = Number(context.lengthSeconds || 0);
  if (duration <= 1800) return;

  const maxGap = duration >= 21600 ? 1800 : duration >= 10800 ? 1500 : 900;
  const step = duration >= 21600 ? 1800 : duration >= 10800 ? 1200 : 900;
  const sourceUrls = sanitizeChannelUrls(context);

  for (const day of Object.values(recap.days || {})) {
    const events = [...(day.events || [])].sort((a, b) => a.seconds - b.seconds);
    if (!events.length) continue;

    const gaps = [];
    let cursor = 0;
    for (const event of events) {
      if (event.seconds - cursor > maxGap) gaps.push([cursor, event.seconds]);
      cursor = Math.max(cursor, event.seconds);
    }
    if (duration - cursor > maxGap) gaps.push([cursor, duration]);
    if (!gaps.length) continue;

    const targets = [];
    for (const [start, end] of gaps) {
      for (let t = start + step / 2; t < end; t += step) {
        targets.push(Math.min(Math.floor(t), duration - 1));
      }
    }
    const limitedTargets = [...new Set(targets)].slice(0, 24);
    if (!limitedTargets.length) continue;

    const gapText = gaps.map(([start, end]) => `${formatTimestamp(start)}–${formatTimestamp(end)}`).join(', ');
    const transcriptEvidence = context.transcript?.length
      ? compressTranscriptSegments(context.transcript.filter(segment => gaps.some(([start, end]) => segment.start >= start && segment.start <= end)), 45).slice(0, 180).join('\\n')
      : '';
    const prompt = [
      `This ${context.title || 'stream'} lasts ${formatTimestamp(duration)}.`,
      `Large uncovered sections: ${gapText}.`,
      `Create one concise recap moment for each requested timestamp below: ${limitedTargets.map(formatTimestamp).join(', ')}.`,
      transcriptEvidence ? `TRANSCRIPT EXCERPTS FOR THESE SECTIONS:\\n${transcriptEvidence}` : '',
      'Return ONLY JSON: {"events":[{"title":"...","description":"...","evidence":"short supporting phrase or empty string","confidence":"high|medium|low","category":"general","participants":[],"isMajor":false}]}.',
      'Do not add timestamps; the server will assign the requested timestamps. If there is no transcript evidence for a requested section, use cautious wording and do not invent specific facts, names, products, outcomes, or quotes.'
    ].filter(Boolean).join('\\n');

    const raw = parseJsonLoose(await callLLM(
      'You are filling missing coverage in a stream recap. Write one concise sentence of 8-18 words and <=140 characters. Lead with the action; omit filler and repeated names. Do not invent specific names, products, outcomes, or quotes.',
      prompt,
      60000
    ));
    const additions = Array.isArray(raw?.events) ? raw.events : [];
    if (!additions.length) continue;

    additions.slice(0, limitedTargets.length).forEach((ev, index) => {
      const seconds = limitedTargets[index];
      const category = sanitizeCategory(ev.category);
      day.events.push({
        id: `${streamId}-coverage-${String(index + 1).padStart(3, '0')}`,
        timestamp: formatTimestamp(seconds),
        seconds,
        isMajor: false,
        title: String(ev.title || 'Stream segment').slice(0, 120),
        description: String(ev.description || 'A notable segment from this part of the broadcast.').slice(0, 180),
        evidence: String(ev.evidence || '').slice(0, 220),
        confidence: String(ev.confidence || 'low').toLowerCase(),
        category,
        tags: [category],
        ...(normalizeParticipants(ev.participants || ev.characters).length
          ? { participants: normalizeParticipants(ev.participants || ev.characters) }
          : {}),
        image: null,
        ...(sourceUrls.twitchVod ? { twitchUrl: `${sourceUrls.twitchVod}?t=${seconds}s` } : {}),
        ...(sourceUrls.kickVod ? { kickUrl: withKickTimestamp(sourceUrls.kickVod, seconds) } : {}),
        ...(sourceUrls.youtubeUrl ? { youtubeUrl: `${sourceUrls.youtubeUrl}${sourceUrls.youtubeUrl.includes('?') ? '&' : '?'}t=${seconds}s` } : {})
      });
    });

    day.events.sort((a, b) => a.seconds - b.seconds);
    day.eventsCount = day.events.length;
    if (!context.transcript?.length) {
      day.timestampsApproximate = true;
      recap.timestampsApproximate = true;
    }
    day.sources = [...new Set([...(day.sources || []), 'coverage-fill'])];
    recap.sources = [...new Set([...(recap.sources || []), 'coverage-fill'])];
    console.error(`[Coverage] ${streamId}: filled ${additions.length} events across ${gaps.length} gaps`);
  }
}

// The core AI recap generation endpoint
app.post('/api/generate', requireOwner, async (req, res) => {
  const body = req.body || {};
  const isBackgroundJob = body._background === true;
  let transcriptionJobId = null;

  // Name-only (no URL, no notes): resolve channel -> recap the chosen (or latest) broadcast.
  // body.vodId lets the UI's VOD picker target a specific past stream.
  let context = null;
  const rawName = String(body.name || '').trim().replace(/^@/, '');
  const hasUrl = !!(body.url && String(body.url).trim());
  const hasNotes = !!(body.notes && String(body.notes).trim());

  if (!hasUrl && !hasNotes && rawName) {
    const resolved = await resolveChannel(rawName);
    if (!resolved || !resolved.platforms.length) {
      return res.status(400).json({ error: `Could not find a channel named "${rawName}" on Twitch, Kick, or YouTube. Check the spelling or paste a VOD link / notes instead.` });
    }
    context = (() => {
      const vods = resolved.recentVods || [];
      let chosen = resolved.latest || null;
      if (body.vodId) {
        const match = vods.find(v => String(v.id) === String(body.vodId));
        chosen = match || chosen;
      }
      return {
        platform: chosen?.platform || resolved.platforms[0],
        channelName: resolved.displayName || rawName,
        streamName: rawName,
        url: '',
        notes: '',
        title: chosen?.title || '',
        lengthSeconds: chosen?.lengthSeconds || 0,
        chapters: [],
        latestVodId: chosen?.id,
        twitchBroadcasterId: resolved.broadcasterId || null,
        vodStartAt: chosen?.createdAt || '',
        resolvedLatency: resolved
      };
    })();
    // If a Twitch app token is configured, pull real timestamp evidence (clips + chat spikes).
    if (context.platform === 'twitch') {
      await gatherTwitchEvidence(context);
    }
  } else {
    context = await buildContext(body);
    // Same Twitch evidence hook for URL-provided Twitch VODs.
    if (context.platform === 'twitch' && context.latestVodId) {
      await gatherTwitchEvidence(context);
    }
  }

  const rawFilters = body.filters && typeof body.filters === 'object' ? body.filters : null;
  if (rawFilters?.criteria) {
    context.filters = {
      criteria: String(rawFilters.criteria).slice(0, 1000),
      mode: rawFilters.mode === 'strict' ? 'strict' : 'discovery'
    };
  }

  // For Twitch/Kick completed VODs, optionally acquire a timed speech transcript
  // For Twitch/Kick completed VODs, optionally acquire a timed speech transcript
  // before classifying evidence and prompting the caption writer.
  // - batchWanted + sync request: hand straight to the background job (it owns
  //   submission + polling), so skip transcription here and return a draft recap.
  // - _transcriptFile: a batch job already finished - load the cached transcript.
  const batchWanted = body.batch === true
    && String(process.env.TRANSCRIPTION_PROVIDER || '').toLowerCase() === 'groq'
    && !!process.env.GROQ_API_KEY;
  if (body._transcriptFile) {
    const cached = readBatchTranscript(body._transcriptFile);
    if (cached) {
      context.transcript = cached.segments;
      context.transcriptSource = 'groq-batch';
    } else {
      console.error(`[Batch] transcript file missing or invalid: ${String(body._transcriptFile).slice(0, 80)}`);
    }
  } else if (!(batchWanted && !isBackgroundJob) && !context.transcript?.length && (context.platform === 'twitch' || context.platform === 'kick')) {
    const jobProgress = isBackgroundJob && body._jobId
      ? (progress, stage) => {
          const job = TRANSCRIPTION_JOBS.get(body._jobId);
          if (job) {
            updateTranscriptionJobProgress(job, progress, stage);
            persistTranscriptionJobs();
          }
        }
      : undefined;
    context.transcript = await transcribeExternalStream(context, isBackgroundJob, jobProgress, { batch: batchWanted });
    // Charge tracking: this is the single choke point where Groq audio minutes are
    // actually consumed (sync path for short VODs, background path for long ones).
    if (context.transcriptSource === 'groq' && context.lengthSeconds > 0) {
      const modelName = process.env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo';
      recordGroqUsage(context.lengthSeconds, modelName);
      if (isBackgroundJob && body._jobId) {
        const job = TRANSCRIPTION_JOBS.get(body._jobId);
        if (job) {
          job.audioHours = Math.round((context.lengthSeconds / 3600) * 100) / 100;
          job.estimatedSpendDollars = Math.round((context.lengthSeconds / 3600) * groqAudioRatePerHour(modelName) * 100) / 100;
          persistTranscriptionJobs();
        }
      }
    }
  }

  // Batch-mode billing: half-price rate, charged when the batch transcript lands.
  if (context.transcriptSource === 'groq-batch' && context.lengthSeconds > 0) {
    const modelName = process.env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo';
    recordGroqUsage(context.lengthSeconds, modelName, true);
    if (isBackgroundJob && body._jobId) {
      const job = TRANSCRIPTION_JOBS.get(body._jobId);
      if (job) {
        job.audioHours = Math.round((context.lengthSeconds / 3600) * 100) / 100;
        job.estimatedSpendDollars = Math.round((context.lengthSeconds / 3600) * groqAudioRatePerHour(modelName, true) * 100) / 100;
        persistTranscriptionJobs();
      }
    }
  }

  // Classify timestamp evidence (drives prompt wording + the approximate flag in saved data)
  context.evidence = [];
  if (context.notes) context.evidence.push('notes');
  if (context.transcript?.length) context.evidence.push('transcript');
  if (context.chapters.length) {
    context.evidence.push(context.chapterSource === 'twitch-clips' ? 'twitch-clips' : 'chapters');
  }
  const name = context.channelName || context.name;

  try {
    if (!context.notes && !context.url && !rawName) {
      return res.status(400).json({ error: 'Provide a stream URL, channel name, or paste notes/chat log.' });
    }

    const rawStreamName = String(body.name || '').trim();
    // URL path segments are not channel names. For links such as /live/<id>,
    // /watch, /shorts, or /embed, trust the metadata-resolved channel instead.
    const suppliedStreamName = GENERIC_VIDEO_NAMES.has(rawStreamName.toLowerCase()) ? '' : rawStreamName;
    const resolvedName = GENERIC_VIDEO_NAMES.has(String(name || '').toLowerCase()) ? '' : name;
    let streamName = String(suppliedStreamName || resolvedName || (context.channelName || '')).trim();
    if (!streamName) {
      return res.status(400).json({ error: 'Could not detect a channel name — enter the streamer / channel name.' });
    }
    streamName = streamName.replace(/[[\]]/g, '');

    const config = loadPovConfig();
    let streamId = streamName.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!streamId) streamId = 'stream';
    const existing = (config.povs || []).find(p => p.id === streamId);
    const profileId = String(body.profile || existing?.profile || ((streamId === 'xqc' || streamId === 'buddha') ? 'nopixel' : 'generic'));
    context.profileId = profileId;
    context.profile = loadProfile(profileId);
    if (profileId === 'nopixel') {
      try {
        const dossiers = await getStreamLoreDossiers(streamId, context.profile);
        context.loreDossiers = dossiers;
        context.profile = augmentProfileWithDossiers(context.profile, dossiers);
      } catch (err) {
        console.error('[Fandom] Error fetching dossiers:', err.message);
      }
    }
    context.redditResearch = await collectRedditEvidence({ profile: context.profile, context, streamId });
    const maxSyncSeconds = Number(process.env.MAX_SYNC_TRANSCRIPTION_SECONDS || 1800);
    const batchNeedsJob = batchWanted && !isBackgroundJob && !body._transcriptFile && !context.batchInfo;
    if (batchNeedsJob || (!isBackgroundJob && !context.transcript?.length && !context.batchInfo && context.lengthSeconds > maxSyncSeconds && transcriptionProviderConfigured())) {
      transcriptionJobId = queueLongTranscription(body, streamId, context);
      context.transcriptionPending = true;
    }

    // Build LLM prompt
    const targetEventCount = calculateTargetEventCount(context);
    const lines = [
      `STREAM: ${streamName}`,
      context.platform ? `PLATFORM: ${context.platform}` : '',
      context.title ? `TITLE: ${context.title}` : '',
      context.lengthSeconds ? `DURATION_SECONDS: ${context.lengthSeconds}` : '',
      `TARGET_EVENT_COUNT: ${targetEventCount} (use fewer in quiet sections and more in dense sections; cover the full broadcast)`,
      ''
    ].filter(Boolean);
    if (context.profile && context.profile.id !== 'generic') {
      lines.push(`DOMAIN_PROFILE: ${context.profile.label} (${context.profile.id})`);
      if (context.profile.eventTypes?.length) lines.push(`PROFILE_EVENT_TYPES: ${context.profile.eventTypes.join(', ')}`);
      if (context.profile.importanceSignals?.length) lines.push(`PROFILE_IMPORTANCE_SIGNALS: ${context.profile.importanceSignals.join('; ')}`);
      if (context.profile.aliases && Object.keys(context.profile.aliases).length) {
        lines.push(`PROFILE_ALIASES: ${JSON.stringify(context.profile.aliases)}`);
      }
      lines.push(...(context.profile.promptRules || []).map(rule => `PROFILE_RULE: ${rule}`));
    }
    if (context.loreDossiers?.length) {
      lines.push(...formatLorePromptDossier(context.loreDossiers));
    }
    if (context.redditResearch?.posts?.length) {
      lines.push('COMMUNITY_HIGHLIGHT_SIGNALS (High-priority story beats and moments the community highlighted on Reddit):');
      lines.push('Search the TIMED_TRANSCRIPT for these topics. When found, ensure they are captured in the recap and marked as "isMajor": true.');
      lines.push(JSON.stringify(context.redditResearch.posts.slice(0, 25).map(p => ({
        topic: p.title,
        community: `r/${p.subreddit}`
      }))));
    }
    if (context.filters?.criteria) {
      lines.push(`FOCUS_FILTER (${context.filters.mode}): ${context.filters.criteria}`);
      lines.push(context.filters.mode === 'strict'
        ? 'Every event must satisfy the focus filter. Do not add generic coverage events that do not match it.'
        : 'Prefer events matching the focus filter, but retain other major moments when they are strongly supported.');
    }
    if (context.chapters.length) {
      const header = context.chapterSource === 'twitch-clips'
        ? 'CONFIRMED_TIMESTAMPS (real community highlight clips — build recap moments on these):'
        : 'CHAPTERS (use as timestamp anchors):';
      lines.push(header);
      for (const ch of context.chapters.slice(0, 80)) {
        lines.push(`  - ${formatTimestamp(ch.seconds)} — ${ch.title}`);
      }
      // Positional coverage guard: no matter where the clips sit, the recap must span the whole stream.
      lines.push('');
      lines.push(`The stream is ${formatTimestamp(context.lengthSeconds || 0)} long.`);
      lines.push('Your recap moments MUST cover the ENTIRE broadcast — spread events across every hour, and include at least one moment in the final 15% of the stream.');
    }
    if (context.notes) {
      lines.push('NOTES / CHAT LOG:');
      lines.push(context.notes.slice(0, 24000));
    }
    if (context.transcript?.length) {
      const { lines: segLines, index: segIndex } = buildSegmentLines(context.transcript);
      context._segmentIndex = segIndex;
      lines.push('TIMED_TRANSCRIPT (primary factual source; each line is a timed segment with an [id]):');
      lines.push('Reference the exact segment ids for each event: "startSegmentId" for where it begins and "endSegmentId" for where it ends.');
      lines.push(...segLines);
    }
    if (context.transcript?.length && context.lengthSeconds) {
      lines.push(`The transcript covers a ${formatTimestamp(context.lengthSeconds)} broadcast. Distribute events across the transcript and do not stop at the first topic.`);
    }
    if (!context.chapters.length && !context.notes && !context.transcript?.length) {
      lines.push('NOTE: no exact timestamps exist for this broadcast — your timestamps will be approximate.');
      lines.push('Create natural, irregular offsets with varied gaps (never uniform round numbers).');
      lines.push(`Cover the FULL ${formatTimestamp(context.lengthSeconds || 0)} duration with moments across every hour — do not stop early.`);
    }
    const userPrompt = lines.join('\n');

    const raw = parseJsonLoose(await callLLM(GENERATE_SYSTEM_PROMPT, userPrompt));
    const recap = normalizeRecap(raw, context, streamId);

    // Do not publish unsupported narrative captions while transcript evidence is absent.
    enforceEvidenceOnlyRecap(recap, context);

    // ---- Tail-coverage safety-net ----
    // If the recap's latest moment lands before ~78% of the broadcast, ask the LLM
    // to expand into the uncovered tail, then merge + re-sort so a long stream is
    // never "only the first 15 minutes". (Skipped in trusted mode.)
    const trustedMode = process.env.TRUSTED_MODE === 'true';
    const strictFocus = context.filters?.mode === 'strict';
    context.trustedMode = trustedMode;
    if (trustedMode) context.evidence = [...new Set([...(context.evidence || []), 'trusted-mode'])];
    if (!trustedMode && !strictFocus && context.lengthSeconds > 600) {
      const allEvents = Object.values(recap.days || {}).flatMap(d => (d.events || []));
      const lastSec = allEvents.reduce((m, e) => Math.max(m, e.seconds || 0), 0);
      const covered = lastSec / context.lengthSeconds;
      console.error(`[Coverage] ${streamId}: last=${formatTimestamp(lastSec)} of ${formatTimestamp(context.lengthSeconds)} (${Math.round(covered * 100)}%)`);
      const hasNarrativeEvidence = Boolean(context.transcript?.length || context.notes);
      if (covered < 0.78 && hasNarrativeEvidence) {
        const tailPrompt = [
          `A recap currently ends at ${formatTimestamp(lastSec)} but the stream is ${formatTimestamp(context.lengthSeconds)} long.`,
          'Write 5-8 NEW moments covering ONLY the section AFTER that timestamp, spread across the remaining time.',
          'Return JSON in exactly this shape: {"events":[{"title":"...","description":"...","seconds":123,"category":"general","participants":[],"isMajor":false}]}',
          'Never invent times before the current recap end or beyond the stream duration.'
        ].join('\n');
        const tailRaw = parseJsonLoose(await callLLM(GENERATE_SYSTEM_PROMPT, tailPrompt, 60000));
        const tailEvents = tailRaw?.events;
        if (Array.isArray(tailEvents) && tailEvents.length) {
          const day = recap.days[Object.keys(recap.days || {})[0]];
          if (day && Array.isArray(day.events)) {
            const vod = sanitizeChannelUrls(context).twitchVod;
            const tailSpan = context.lengthSeconds - lastSec;
            let added = 0;
            // Distribute whatever the model returns across the uncovered tail so the
            // response can never exceed the broadcast or clump at one spot.
            const cleaned = tailEvents.map(ev => Math.max(0, parseInt(ev.seconds, 10) || 0)).filter(s => s > lastSec);
            for (let i = 0; i < tailEvents.length; i++) {
              const ev = tailEvents[i];
              // Use the model's offset when it's inside the tail; otherwise spread evenly.
              const sec = (cleaned[i] !== undefined && cleaned[i] <= context.lengthSeconds)
                ? cleaned[i]
                : lastSec + Math.floor((tailSpan * (i + 1)) / (tailEvents.length + 1));
              if (sec <= lastSec || sec > context.lengthSeconds) continue;
              const category = sanitizeCategory(ev.category);
              day.events.push({
                id: `${streamId}-evt-${String(day.events.length + 1).padStart(3, '0')}`,
                timestamp: formatTimestamp(sec),
                seconds: sec,
                endSeconds: Math.min(context.lengthSeconds, sec + 60),
                isMajor: !!ev.isMajor,
                title: String(ev.title || ev.description || `Moment ${day.events.length + 1}`).slice(0, 120),
                description: String(ev.description || ev.title || '').slice(0, 180),
                category,
                tags: [category],
                ...(normalizeParticipants(ev.participants || ev.characters).length
                  ? { participants: normalizeParticipants(ev.participants || ev.characters) }
                  : {}),
                ...(vod ? { twitchUrl: `${vod}?t=${sec}s` } : {})
              });
              added++;
            }
            if (added) {
              day.events.sort((a, b) => a.seconds - b.seconds);
              day.eventsCount = day.events.length;
              console.error(`[Coverage] ${streamId}: extended tail by ${added} events`);
            }
          }
        }
      }
    }

    // Fill large uncovered intervals after the first generation pass.
    // Trusted mode never invents coverage: sparse but defensible wins over complete.
    if (trustedMode || strictFocus) {
      if (strictFocus) recap.sources = [...new Set([...(recap.sources || []), 'focus-filter-strict'])];
      if (trustedMode) recap.sources = [...new Set([...(recap.sources || []), 'trusted-mode'])];
      console.error(`[Coverage] ${streamId}: synthetic coverage disabled${strictFocus ? ' for strict focus filter' : ''}`);
    } else {
      await fillCoverageGaps(recap, context, streamId);
    }

    // Deterministically validate each event against the transcript evidence:
    // evidence excerpt must match a segment near its time, and named entities in
    // the description must be present in that window. Unsupported events get
    // downgraded instead of deleted so the draft stays auditable.
    validateEventsAgainstEvidence(recap, context);

    // Remove unsupported "stream is ending" claims from mid-stream moments.
    sanitizePrematureEndingClaims(recap, context);

    // Re-derive end times after tail + coverage merges so every event (including
    // newly added ones) carries a usable start/end range for clip export.
    for (const day of Object.values(recap.days || {})) deriveEventEnds(day.events, context.lengthSeconds);

    // Attach real screenshot frames from the source VOD where possible. Prioritize
    // low-confidence events so the targeted vision pass has an image to inspect.
    const visionCandidates = VISION_VALIDATION_ENABLED ? selectVisionCandidates(recap, context) : [];
    if (context.latestVodId || context.url) {
      const captured = await attachEventFrames(recap, context, streamId, { requiredEvents: visionCandidates });
      console.error(`[Frames] captured ${captured} frames for ${streamId}`);
    }
    if (visionCandidates.length) {
      await validateEventsWithVision(context, visionCandidates);
      const complete = visionCandidates.filter(event => event.visionValidation?.status === 'complete').length;
      console.error(`[Vision] ${streamId}: validated ${complete}/${visionCandidates.length} targeted events with ${VISION_VALIDATION_MODEL}`);
    }

    // Cluster moments into narrative story arcs
    await enrichRecapWithStoryArcs(recap);

    // Persist days data — merge into an existing stream's days (append the new
    // broadcast as the next day) instead of overwriting, so re-running Add Stream
    // for a channel that already exists keeps its earlier days and screenshots.
    const fileName = streamId === 'xqc' ? 'daysData.json' : `${streamId}DaysData.json`;
    const filePath = path.join(SRC_DATA_DIR, fileName);
    let mergedDays = recap.days || {};
    if (existing && Object.keys(mergedDays).length) {
      let saved = null;
      try { saved = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch {}
      const prevDays = (saved && saved.days) || {};
      const prevKeys = Object.keys(prevDays);
      if (prevKeys.length) {
        const newKeys = Object.keys(mergedDays).sort((a, b) => Number(a) - Number(b));
        const pendingKeys = isBackgroundJob
          ? prevKeys.filter(key => (prevDays[key]?.sources || []).includes('transcription-pending'))
          : [];
        const incomingDay = mergedDays[newKeys[0]] || {};
        const sourceMatch = incomingDay.sourceKey
          ? prevKeys.find(key => prevDays[key]?.sourceKey === incomingDay.sourceKey)
          : null;
        const dateMatch = incomingDay.streamDate
          ? prevKeys.find(key => prevDays[key]?.streamDate === incomingDay.streamDate)
          : null;
        // Re-running the same VOD/date updates that day; a genuinely new date is appended.
        const replaceKey = pendingKeys[pendingKeys.length - 1] || sourceMatch || dateMatch || null;
        const appended = {};
        newKeys.forEach((key, i) => {
          const day = mergedDays[key] || {};
          const targetKey = i === 0 && replaceKey ? replaceKey : String(Math.max(...prevKeys.map(Number).filter(Number.isFinite), 0) + i + 1);
          const dayNum = Number(targetKey);
          const prevTitle = /^Day \d+/.test(String(day.title || ''));
          appended[targetKey] = {
            ...day,
            dayNumber: dayNum,
            title: prevTitle ? `Day ${dayNum}` : (day.title || `Day ${dayNum}`),
            eventsCount: (day.events || []).length
          };
        });
        mergedDays = { ...prevDays, ...appended };
        if (replaceKey) {
          for (const key of pendingKeys) {
            if (key !== replaceKey) delete mergedDays[key];
          }
        }
      }
    }
    fs.writeFileSync(filePath, JSON.stringify({ ...recap, days: mergedDays }, null, 2), 'utf-8');

    // Register / update stream in povConfig (same config object, no redeclare)
    const preset = COLOR_PRESETS[body.color] || COLOR_PRESETS[existing?.color] || pickUnusedColor(config);
    const channelFields = {};
    if (context.platform === 'twitch' || context.url.includes('twitch.tv')) {
      channelFields.twitchChannel = `https://www.twitch.tv/${streamId}`;
    }
    if (context.platform === 'kick' || context.url.includes('kick.com')) {
      channelFields.kickChannel = `https://kick.com/${streamId}`;
    }
    if (context.platform === 'youtube' || context.url.includes('youtube.com')) {
      channelFields.youtubeChannel = context.url.includes('youtube.com') ? context.url.split('?')[0] : `https://www.youtube.com/@${streamId}`;
    }

    const entry = {
      id: streamId,
      name: streamName,
      ...preset,
      platform: context.platform ? `${context.platform[0].toUpperCase()}${context.platform.slice(1)}` : 'Twitch, Kick & YouTube',
      ...channelFields,
      tagline: recap.summary || recap.title ? String(recap.title || recap.summary).slice(0, 120) : `${streamName} — AI recap`,
      sourceLabel: 'AI-generated recap',
      profile: context.profileId || 'generic'
    };

    const povs = [entry, ...(config.povs || []).filter(p => p.id !== streamId)];
    savePovConfig({ ...config, povs, defaultPov: config.defaultPov || streamId });

    res.json({
      ok: true,
      streamId,
      streamName,
      data: recap,
      generated: !existing,
      transcriptionPending: Boolean(transcriptionJobId),
      transcriptionJobId,
      ...(context.batchInfo ? { batch: context.batchInfo } : {})
    });
  } catch (err) {
    console.error('[Generate] Error:', err);
    const status = err.code === 'TRANSCRIPTION_BUDGET_EXHAUSTED' ? 402 : err.retryAfterMs ? 429 : 500;
    res.status(status).json({ error: err.message || 'Generation failed. Try again.', retryAfterMs: err.retryAfterMs || 0, code: err.code || undefined });
  }
});

// Backfill deterministic end times on legacy generated recaps that predate the
// endSeconds field. Runs once at startup so existing JSON files show ranges too.
function backfillExistingRecapEnds() {
  try {
    const config = loadPovConfig();
    for (const pov of (config.povs || [])) {
      if (pov.sourceLabel !== 'AI-generated recap') continue;
      const fileName = pov.id === 'xqc' ? 'daysData.json' : `${pov.id}DaysData.json`;
      const filePath = path.join(SRC_DATA_DIR, fileName);
      if (!fs.existsSync(filePath)) continue;
      const recap = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      let changed = false;
      for (const day of Object.values(recap.days || {})) {
        const before = JSON.stringify((day.events || []).map(e => e.endSeconds));
        deriveEventEnds(day.events, Number(recap.lengthSeconds || day.lengthSeconds || 0));
        if (JSON.stringify((day.events || []).map(e => e.endSeconds)) !== before) changed = true;
      }
      if (changed) fs.writeFileSync(filePath, JSON.stringify(recap, null, 2), 'utf-8');
    }
  } catch (error) {
    console.error('[Backfill] failed to add end times to legacy recaps:', error.message);
  }
}

function pickUnusedColor(config) {
  const used = new Set((config.povs || []).map(p => p.color));
  for (const key of Object.keys(COLOR_PRESETS)) {
    if (!used.has(key)) return COLOR_PRESETS[key];
  }
  return COLOR_PRESETS.amber;
}

// Serve static assets
app.use(express.static(path.join(__dirname, 'dist')));

// SPA fallback
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  backfillExistingRecapEnds();
  recoverTranscriptionJobs();
  resumePendingBatchJobs();
  scheduleNextTranscription();
  console.log(`[StreamRecap] AI recap server on http://0.0.0.0:${PORT} (model: ${RECAP_MODEL})`);
});

// Background VOD downloads/transcription can legitimately take hours. Node's
// default five-minute request timeout would close the internal job request while
// ffmpeg is still working, leaving the job marked failed with a generic fetch error.
const LONG_REQUEST_TIMEOUT_MS = 3 * 60 * 60 * 1000;
httpServer.requestTimeout = LONG_REQUEST_TIMEOUT_MS;
httpServer.timeout = LONG_REQUEST_TIMEOUT_MS;
httpServer.headersTimeout = LONG_REQUEST_TIMEOUT_MS;