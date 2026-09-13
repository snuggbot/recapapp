const DEFAULT_USER_AGENT = 'StreamRecap/1.0 (Reddit research; contact configured by owner)';

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function buildQueries(profile, context, streamId) {
  const aliases = Object.values(profile?.aliases || {}).flatMap((values) => values || []);
  const configured = profile?.redditQueries || [];
  return unique([
    ...configured,
    context?.channelName,
    context?.name,
    streamId,
    ...aliases.slice(0, 12)
  ]).slice(0, 8);
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': process.env.REDDIT_USER_AGENT || DEFAULT_USER_AGENT,
        ...(options.headers || {})
      }
    });
    if (!response.ok) throw new Error(`Reddit request failed: ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getOAuthToken() {
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const response = await fetchJson('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  return response.access_token || null;
}

function normalizePost(post, subreddit, query) {
  const data = post?.data || post;
  if (!data?.id || !data?.title) return null;
  return {
    id: data.id,
    subreddit: data.subreddit || subreddit,
    query,
    title: String(data.title).slice(0, 300),
    excerpt: String(data.selftext || '').slice(0, 700),
    permalink: data.permalink ? `https://www.reddit.com${data.permalink}` : null,
    url: data.url || null,
    createdUtc: Number(data.created_utc) || null,
    score: Number(data.score) || 0,
    comments: Number(data.num_comments) || 0,
    isVideo: Boolean(data.is_video),
    crossposts: Number(data.num_crossposts) || 0
  };
}

/**
 * Gather Reddit posts as candidate leads. These are never treated as verified
 * events; the transcript/VOD and vision passes remain authoritative.
 */
export async function collectRedditEvidence({ profile, context, streamId }) {
  if (String(process.env.REDDIT_RESEARCH_ENABLED).toLowerCase() !== 'true') {
    return { status: 'disabled', posts: [], subreddits: profile?.subreddits || [] };
  }

  const subreddits = unique(profile?.subreddits || []).map((name) => name.replace(/^r\//i, ''));
  if (!subreddits.length) return { status: 'no-subreddits', posts: [] };

  const token = await getOAuthToken();
  if (!token && String(process.env.REDDIT_ALLOW_PUBLIC_SEARCH).toLowerCase() !== 'true') {
    return { status: 'missing-credentials', posts: [], subreddits };
  }

  const queries = buildQueries(profile, context, streamId);
  const posts = [];
  const seen = new Set();

  for (const subreddit of subreddits) {
    for (const query of queries) {
      const params = new URLSearchParams({
        q: query,
        restrict_sr: 'on',
        sort: 'relevance',
        t: 'month',
        limit: '10',
        raw_json: '1'
      });
      const base = token
        ? `https://oauth.reddit.com/r/${encodeURIComponent(subreddit)}/search.json`
        : `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/search.json`;
      try {
        const data = await fetchJson(`${base}?${params}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
        for (const child of data?.data?.children || []) {
          const post = normalizePost(child, subreddit, query);
          if (post && !seen.has(post.id)) {
            seen.add(post.id);
            posts.push(post);
          }
        }
      } catch (error) {
        // Keep other subreddit/query searches useful when one request is blocked.
        console.warn(`[Reddit] ${subreddit}/${query}: ${error.message}`);
      }
    }
  }

  posts.sort((a, b) => (b.score + b.comments * 2) - (a.score + a.comments * 2));
  return {
    status: 'ok',
    fetchedAt: new Date().toISOString(),
    subreddits,
    queries,
    posts: posts.slice(0, 60)
  };
}
