/**
 * StreamRecap — Reddit Community Research Module
 * 
 * Supports two compliant modes for locating community discussions:
 * 1. Search Engine API (Recommended): Uses Brave Search API or Google Custom Search
 *    to index and retrieve public Reddit threads (site:reddit.com/r/...) without requiring
 *    gated Reddit Developer Platform approval.
 * 2. Reddit Data API: Uses standard OAuth2 client_credentials grant if approved.
 * 
 * Compliant with Responsible Data & Privacy Standards:
 * - Read-only reference linking to public discussions.
 * - Zero model training or fine-tuning.
 * - Data minimization: stores only post IDs, titles, timestamps, and canonical permalinks.
 * - 14-day automated cache retention limit with automatic eviction.
 * - Full canonical attribution (https://www.reddit.com/r/...).
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
const REQUEST_PACING_MS = 400; // Polite spacing between requests

// In-memory token cache for official OAuth
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
  } catch {
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
 * Purge cache for a specific stream ID or purge all expired items
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
  loadCache(); // Triggers automated eviction
}

/**
 * Parse a raw web URL to extract canonical Reddit post information.
 */
function parseRedditUrl(rawUrl, rawTitle = '') {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const match = rawUrl.match(/reddit\.com\/r\/([^/]+)\/comments\/([a-z0-9]+)(?:\/([^/?#]+))?/i);
  if (!match) return null;

  const subreddit = match[1];
  const id = match[2];
  const slug = match[3] || '';
  const permalink = `https://www.reddit.com/r/${subreddit}/comments/${id}/${slug ? `${slug}/` : ''}`;

  // Clean title from common search suffixes like " : r/GTARP - Reddit"
  const cleanTitle = String(rawTitle || slug.replace(/_/g, ' '))
    .replace(/\s*:\s*r\/[a-zA-Z0-9_]+\s*-?\s*Reddit$/i, '')
    .replace(/\s*-\s*Reddit$/i, '')
    .trim();

  return {
    id,
    subreddit,
    title: cleanTitle.slice(0, 280),
    permalink,
    url: permalink,
    score: 0,
    comments: 0,
    source: 'search-engine'
  };
}

/**
 * Query Reddit threads using Brave Search API
 * Free tier: 2,000 queries/month free at https://brave.com/search/api/
 */
async function searchViaBrave(query, subreddits = []) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return null;

  const siteFilter = subreddits.length
    ? subreddits.map((s) => `site:reddit.com/r/${encodeURIComponent(s.replace(/^r\//, ''))}`).join(' OR ')
    : 'site:reddit.com';

  const fullQuery = `(${siteFilter}) ${query}`;
  const endpoint = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(fullQuery)}&count=10`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey
      }
    });

    if (!response.ok) {
      console.warn(`[Reddit/Brave] Search returned ${response.status}`);
      return null;
    }

    const data = await response.json();
    const results = [];

    for (const item of data?.web?.results || []) {
      const parsed = parseRedditUrl(item.url, item.title);
      if (parsed) {
        parsed.query = query;
        results.push(parsed);
      }
    }
    return results;
  } catch (err) {
    console.warn('[Reddit/Brave] Search failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Query Reddit threads using Google Custom Search API
 * Free tier: 100 queries/day at Google Cloud Console
 */
async function searchViaGoogle(query, subreddits = []) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  if (!apiKey || !cx) return null;

  const siteFilter = subreddits.length
    ? subreddits.map((s) => `site:reddit.com/r/${encodeURIComponent(s.replace(/^r\//, ''))}`).join(' OR ')
    : 'site:reddit.com';

  const fullQuery = `(${siteFilter}) ${query}`;
  const endpoint = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(apiKey)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(fullQuery)}&num=10`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(endpoint, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });

    if (!response.ok) {
      console.warn(`[Reddit/Google] Search returned ${response.status}`);
      return null;
    }

    const data = await response.json();
    const results = [];

    for (const item of data?.items || []) {
      const parsed = parseRedditUrl(item.link, item.title);
      if (parsed) {
        parsed.query = query;
        results.push(parsed);
      }
    }
    return results;
  } catch (err) {
    console.warn('[Reddit/Google] Search failed:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search official Reddit Data API via OAuth2 (if approved)
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

    if (!response.ok) return null;
    const data = await response.json();
    if (data?.access_token) {
      cachedToken = data.access_token;
      tokenExpiresAt = now + (Number(data.expires_in) || 3600) * 1000;
      return cachedToken;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeOAuthPost(post, subreddit, query) {
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
    comments: Number(data.num_comments) || 0,
    source: 'reddit-api'
  };
}

/**
 * On-demand community search (used by API endpoint and recap pipeline)
 */
export async function searchCommunityThreads(query, subreddits = ['GTARP', 'LivestreamFail', 'xqcow']) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  // 1. Try Brave Search API if configured
  if (process.env.BRAVE_SEARCH_API_KEY) {
    const braveResults = await searchViaBrave(cleanQuery, subreddits);
    if (braveResults && braveResults.length) return braveResults;
  }

  // 2. Try Google Custom Search if configured
  if (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX) {
    const googleResults = await searchViaGoogle(cleanQuery, subreddits);
    if (googleResults && googleResults.length) return googleResults;
  }

  // 3. Try official OAuth if configured
  const token = await getOAuthToken();
  if (token) {
    const posts = [];
    for (const sub of subreddits.slice(0, 2)) {
      try {
        const params = new URLSearchParams({
          q: cleanQuery,
          restrict_sr: 'on',
          sort: 'relevance',
          limit: '5',
          raw_json: '1'
        });
        const res = await fetch(`https://oauth.reddit.com/r/${encodeURIComponent(sub)}/search.json?${params}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': process.env.REDDIT_USER_AGENT || DEFAULT_USER_AGENT
          }
        });
        if (res.ok) {
          const json = await res.json();
          for (const child of json?.data?.children || []) {
            const p = normalizeOAuthPost(child, sub, cleanQuery);
            if (p) posts.push(p);
          }
        }
      } catch {}
    }
    if (posts.length) return posts;
  }

  return [];
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
 * Automatically chooses Search Engine discovery (Brave/Google) or official OAuth.
 */
export async function collectRedditEvidence({ profile, context, streamId }) {
  const subreddits = unique(profile?.subreddits || []).map((name) => name.replace(/^r\//i, ''));
  const queries = buildQueries(profile, context, streamId);
  const cache = loadCache();
  const posts = [];
  const seen = new Set();

  const hasSearchEngine = Boolean(process.env.BRAVE_SEARCH_API_KEY || (process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX));
  const hasOAuth = Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);

  if (!hasSearchEngine && !hasOAuth && String(process.env.REDDIT_RESEARCH_ENABLED).toLowerCase() !== 'true') {
    return {
      status: 'unconfigured',
      provider: 'none',
      message: 'Add BRAVE_SEARCH_API_KEY (free: https://brave.com/search/api/) or GOOGLE_SEARCH_API_KEY to search Reddit discussions.',
      posts: [],
      subreddits
    };
  }

  let executedCount = 0;

  for (const query of queries) {
    if (executedCount >= MAX_QUERIES_PER_RUN) break;

    const cacheKey = `${streamId}:query:${query.toLowerCase()}`;
    const cached = cache[cacheKey];

    // Check 14-day TTL cache
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
    await sleep(REQUEST_PACING_MS);

    let queryPosts = [];

    // Prioritize Search Engine method (no Reddit API block)
    if (hasSearchEngine) {
      queryPosts = await searchCommunityThreads(query, subreddits);
    } else if (hasOAuth) {
      const token = await getOAuthToken();
      if (token) {
        for (const subreddit of subreddits.slice(0, 2)) {
          try {
            const params = new URLSearchParams({
              q: query,
              restrict_sr: 'on',
              sort: 'relevance',
              t: 'month',
              limit: '5',
              raw_json: '1'
            });
            const res = await fetch(`https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/search.json?${params}`, {
              headers: {
                Authorization: `Bearer ${token}`,
                'User-Agent': process.env.REDDIT_USER_AGENT || DEFAULT_USER_AGENT
              }
            });
            if (res.ok) {
              const json = await res.json();
              for (const child of json?.data?.children || []) {
                const p = normalizeOAuthPost(child, subreddit, query);
                if (p) queryPosts.push(p);
              }
            }
          } catch {}
        }
      }
    }

    for (const post of queryPosts) {
      if (!seen.has(post.id)) {
        seen.add(post.id);
        posts.push(post);
      }
    }

    // Save into 14-day cache
    cache[cacheKey] = {
      timestamp: Date.now(),
      posts: queryPosts
    };
    saveCache(cache);
  }

  return {
    status: 'ok',
    provider: hasSearchEngine ? (process.env.BRAVE_SEARCH_API_KEY ? 'brave' : 'google') : (hasOAuth ? 'reddit-oauth' : 'cache-only'),
    fetchedAt: new Date().toISOString(),
    subreddits,
    queries,
    retentionDays: 14,
    posts: posts.slice(0, 25)
  };
}
