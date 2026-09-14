/**
 * StreamRecap — Reddit Community Research Module
 * 
 * Compliant with Reddit's Data API Terms & Responsible Builder Policy:
 * 1. Read-Only Context: Queries public subreddit search to find relevant community discussion threads.
 * 2. No Model Training: Data is strictly used for real-time reference linking and citation.
 *    Reddit data is NEVER used to train, fine-tune, or evaluate machine learning models.
 * 3. Data Minimization: Stores only canonical post IDs, titles, subreddits, timestamps, scores, and permalinks.
 *    Zero user PII, author usernames, user profiles, or comment trees are stored.
 * 4. 14-Day Retention Limit: Cached entries expire and are automatically evicted after 14 days.
 * 5. Full Attribution: Every item provides the direct canonical Reddit permalink (https://www.reddit.com/r/...).
 * 6. Strict OAuth2: Requires client_credentials authentication; no unauthorized scraping.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_FILE = path.join(__dirname, '..', 'data', 'reddit-cache.json');

const DEFAULT_USER_AGENT = process.env.REDDIT_USER_AGENT || 'web:StreamRecap:v1.0.0 (by /u/StreamRecapDev)';
const RETENTION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14-day retention limit
const MAX_QUERIES_PER_RUN = 5; // Strict query budget per stream recap
const REQUEST_PACING_MS = 400; // Polite rate-limit spacing between requests

// In-memory token cache to prevent unnecessary token generation requests
let cachedToken = null;
let tokenExpiresAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

/**
 * Load and automatically purge expired cache entries (14-day retention policy)
 */
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    const now = Date.now();
    let mutated = false;

    // Evict any entry older than 14 days
    for (const key of Object.keys(data)) {
      if (!data[key]?.timestamp || (now - data[key].timestamp) > RETENTION_TTL_MS) {
        delete data[key];
        mutated = true;
      }
    }

    if (mutated) {
      saveCache(data);
    }
    return data;
  } catch (err) {
    return {};
  }
}

function saveCache(data) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Reddit] Failed to save cache:', err.message);
  }
}

/**
 * Purge cache for a specific stream ID or purge all expired items (honors user deletion rights)
 */
export function purgeRedditCacheForStream(streamId) {
  try {
    const cache = loadCache();
    let changed = false;
    for (const key of Object.keys(cache)) {
      if (key.startsWith(`${streamId}:`)) {
        delete cache[key];
        changed = true;
      }
    }
    if (changed) saveCache(cache);
  } catch {}
}

export function purgeAllExpiredRedditCache() {
  loadCache(); // Triggers automated eviction of expired entries
}

/**
 * Authenticate strictly via OAuth2 client_credentials grant
 */
async function getOAuthToken() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': process.env.REDDIT_USER_AGENT || DEFAULT_USER_AGENT
      },
      body,
      signal: controller.signal
    });

    if (!response.ok) {
      console.warn(`[Reddit] Token request failed: ${response.status}`);
      return null;
    }

    const data = await response.json();
    if (data?.access_token) {
      cachedToken = data.access_token;
      tokenExpiresAt = now + (Number(data.expires_in) || 3600) * 1000;
      return cachedToken;
    }
    return null;
  } catch (err) {
    console.warn(`[Reddit] OAuth error: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Data Minimization: strictly retain only minimal public metadata required for reference linking.
 * Never store author usernames, user IDs, or comment trees.
 */
function normalizePost(post, subreddit, query) {
  const data = post?.data || post;
  if (!data?.id || !data?.title) return null;

  const permalink = data.permalink
    ? `https://www.reddit.com${data.permalink.startsWith('/') ? '' : '/'}${data.permalink}`
    : null;

  return {
    id: String(data.id),
    subreddit: String(data.subreddit || subreddit),
    query: String(query || ''),
    title: String(data.title || '').slice(0, 280),
    permalink,
    url: data.url ? String(data.url) : permalink,
    createdUtc: Number(data.created_utc) || null,
    score: Number(data.score) || 0,
    comments: Number(data.num_comments) || 0
  };
}

/**
 * Construct prioritized, constrained search queries for the stream.
 */
function buildQueries(profile, context, streamId) {
  const aliases = Object.values(profile?.aliases || {}).flatMap((values) => values || []);
  const configured = profile?.redditQueries || [];

  return unique([
    ...configured.slice(0, 3),
    context?.channelName,
    context?.name,
    streamId,
    ...aliases.slice(0, 4)
  ]).slice(0, MAX_QUERIES_PER_RUN);
}

/**
 * Gather Reddit public posts as candidate community discussion leads.
 * 
 * Compliant read-only OAuth integration:
 * - Only searches allowed subreddits
 * - Strictly cached with 14-day TTL
 * - Never used for model training
 * - Direct canonical permalink attribution
 */
export async function collectRedditEvidence({ profile, context, streamId }) {
  if (String(process.env.REDDIT_RESEARCH_ENABLED).toLowerCase() !== 'true') {
    return { status: 'disabled', posts: [], subreddits: profile?.subreddits || [] };
  }

  const subreddits = unique(profile?.subreddits || []).map((name) => name.replace(/^r\//i, ''));
  if (!subreddits.length) return { status: 'no-subreddits', posts: [] };

  const token = await getOAuthToken();
  if (!token) {
    return {
      status: 'missing-credentials',
      posts: [],
      subreddits,
      message: 'Reddit API integration requires approved OAuth credentials (REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET).'
    };
  }

  const cache = loadCache();
  const queries = buildQueries(profile, context, streamId);
  const posts = [];
  const seen = new Set();
  let executedCount = 0;

  for (const subreddit of subreddits) {
    for (const query of queries) {
      if (executedCount >= MAX_QUERIES_PER_RUN) break;

      const cacheKey = `${streamId}:${subreddit}:${query.toLowerCase()}`;
      const cached = cache[cacheKey];

      // Check 14-day valid cache
      if (cached && cached.posts && (Date.now() - cached.timestamp) < RETENTION_TTL_MS) {
        for (const post of cached.posts) {
          if (!seen.has(post.id)) {
            seen.add(post.id);
            posts.push(post);
          }
        }
        continue;
      }

      executedCount++;
      const params = new URLSearchParams({
        q: query,
        restrict_sr: 'on',
        sort: 'relevance',
        t: 'month',
        limit: '10',
        raw_json: '1'
      });

      // Polite rate-limit spacing
      await sleep(REQUEST_PACING_MS);

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);

        const response = await fetch(`https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?${params}`, {
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'User-Agent': process.env.REDDIT_USER_AGENT || DEFAULT_USER_AGENT
          }
        });

        clearTimeout(timer);

        if (response.status === 429) {
          console.warn('[Reddit] Rate limit (429) encountered. Pacing requests.');
          break; // Stop further requests on rate limit
        }

        if (!response.ok) {
          console.warn(`[Reddit] Request error ${response.status} for r/${subreddit}: ${query}`);
          continue;
        }

        const data = await response.json();
        const queryPosts = [];

        for (const child of data?.data?.children || []) {
          const post = normalizePost(child, subreddit, query);
          if (post && !seen.has(post.id)) {
            seen.add(post.id);
            posts.push(post);
            queryPosts.push(post);
          }
        }

        // Save into 14-day TTL cache
        cache[cacheKey] = {
          timestamp: Date.now(),
          posts: queryPosts
        };
        saveCache(cache);

      } catch (error) {
        console.warn(`[Reddit] ${subreddit}/${query} search failed: ${error.message}`);
      }
    }
    if (executedCount >= MAX_QUERIES_PER_RUN) break;
  }

  // Sort by engagement score for relevance ranking
  posts.sort((a, b) => (b.score + b.comments * 2) - (a.score + a.comments * 2));

  return {
    status: 'ok',
    fetchedAt: new Date().toISOString(),
    subreddits,
    queries,
    retentionDays: 14,
    posts: posts.slice(0, 30)
  };
}
