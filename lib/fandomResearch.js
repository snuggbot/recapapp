/**
 * StreamRecap — NoPixel Fandom MediaWiki Intelligence Module
 * 
 * Uses the public NoPixel Fandom API (nopixel.fandom.com/api.php):
 * - Zero keys, authentication, or developer approval required.
 * - Extracts canonical character names, in-game nicknames, aliases, and affiliations.
 * - Enriches AI recap prompts so the LLM understands in-world character lore and aliases.
 * - Local 7-day TTL cache in data/wiki-cache.json to minimize network lookups.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_FILE = path.join(__dirname, '..', 'data', 'wiki-cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7-day cache

const STREAMER_TO_CHARACTER = {
  xqc: 'Jean Paul',
  buddha: 'Lang Buddha',
  omie: 'Marty Banks',
  anthonyz: 'Tony Corleone',
  summit1g: 'Charles Johnson',
  fuslie: 'April Fooze',
  valkyrae: 'Ray Mond',
  sykkuno: 'Yuno Sykk',
  blaustoise: 'Mickey Haverford',
  sayeedblack: 'Sayeed Speedy',
  kyle: 'Kyle Pred',
  roflgator: 'Robert Spumoni',
  chatterbox: 'Chatterbox'
};

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw);
    const now = Date.now();
    let mutated = false;

    for (const key of Object.keys(data)) {
      if (!data[key]?.timestamp || (now - data[key].timestamp) > CACHE_TTL_MS) {
        delete data[key];
        mutated = true;
      }
    }
    if (mutated) saveCache(data);
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
    console.error('[Fandom] Failed to save cache:', err.message);
  }
}

function cleanWikiText(val) {
  return String(val || '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1') // [[Target|Label]] -> Label
    .replace(/\{\{[^}]*\}\}/g, '') // {{Template}} -> ''
    .replace(/<[^>]*>/g, '') // <tags> -> ''
    .replace(/[']{2,}/g, '') // bold/italic quotes
    .trim();
}

function parseInfobox(wikitext) {
  const fields = {};
  const lines = wikitext.split('\n');
  let currentKey = null;

  for (const line of lines) {
    const match = line.match(/^\s*\|([a-zA-Z0-9_#]+)\s*=\s*(.*)$/);
    if (match) {
      currentKey = match[1].trim();
      fields[currentKey] = match[2];
    } else if (currentKey && line.startsWith('*')) {
      fields[currentKey] += '\n' + line;
    }
  }

  const name = cleanWikiText(fields.name || '');
  const status = cleanWikiText(fields.status || 'Active');

  const aliases = (fields.aliases || '')
    .split(/\n|<br\s*\/?>|\*/)
    .map((a) => cleanWikiText(a).replace(/\(.*?\)/g, '').replace(/^[-–—]\s*/, '').trim())
    .filter((a) => a && a.length > 1 && a.length < 40);

  const rawAffil = (fields.affiliation || '') + '\n' + (fields.formerAffiliation || '') + '\n' + (fields.residence || '');
  const affiliations = rawAffil
    .split(/\n|<br\s*\/?>|\*/)
    .map((a) => cleanWikiText(a).replace(/\(.*?\)/g, '').trim())
    .filter((a) => a && a.length > 2 && a.length < 40 && !['member', 'og', 'founding member', 'don'].includes(a.toLowerCase()));

  const job = cleanWikiText(fields.employer || fields.formerJob || '');
  const playedBy = cleanWikiText(fields.PlayedBy || '');

  return {
    name,
    status,
    aliases: [...new Set(aliases)],
    affiliations: [...new Set(affiliations)],
    job: job.split(/\n|\*/).map(cleanWikiText).filter(Boolean).slice(0, 3).join(', '),
    playedBy
  };
}

/**
 * Search the NoPixel wiki for a character or streamer name.
 */
async function searchWikiPages(query) {
  const cleanQuery = String(query || '').trim();
  if (!cleanQuery) return [];

  const url = `https://nopixel.fandom.com/api.php?action=opensearch&search=${encodeURIComponent(cleanQuery)}&limit=5&format=json`;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'StreamRecap/1.0 (NoPixel character intelligence)' } });
    if (!response.ok) return [];
    const data = await response.json();
    return Array.isArray(data?.[1]) ? data[1] : [];
  } catch {
    return [];
  }
}

/**
 * Fetch and parse wikitext for a given wiki page title.
 */
async function fetchWikiPageWikitext(pageTitle) {
  const url = `https://nopixel.fandom.com/api.php?action=parse&page=${encodeURIComponent(pageTitle)}&prop=wikitext&format=json&section=0`;
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'StreamRecap/1.0 (NoPixel character intelligence)' } });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.parse?.wikitext?.['*'] || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a character dossier from NoPixel Fandom Wiki with caching.
 */
export async function fetchCharacterDossier(characterOrStreamer) {
  const query = String(characterOrStreamer || '').trim();
  if (!query) return null;

  const resolvedName = STREAMER_TO_CHARACTER[query.toLowerCase()] || query;
  const cacheKey = `char:${resolvedName.toLowerCase()}`;
  const cache = loadCache();

  if (cache[cacheKey] && cache[cacheKey].data && (Date.now() - cache[cacheKey].timestamp) < CACHE_TTL_MS) {
    return cache[cacheKey].data;
  }

  // Find candidate pages on NoPixel wiki
  const pages = await searchWikiPages(resolvedName);
  // Prefer current 4.0/5.0/V versions if present, else top match
  const bestPage = pages.find((p) => p.includes('4.0') || p.includes('5.0')) || pages[0] || null;

  if (!bestPage) return null;

  const wikitext = await fetchWikiPageWikitext(bestPage);
  if (!wikitext) return null;

  const parsed = parseInfobox(wikitext);
  const dossier = {
    query: resolvedName,
    pageTitle: bestPage,
    name: parsed.name || resolvedName,
    status: parsed.status,
    aliases: parsed.aliases,
    affiliations: parsed.affiliations,
    job: parsed.job,
    playedBy: parsed.playedBy || (STREAMER_TO_CHARACTER[query.toLowerCase()] ? query : ''),
    wikiUrl: `https://nopixel.fandom.com/wiki/${encodeURIComponent(bestPage.replace(/\s+/g, '_'))}`
  };

  cache[cacheKey] = {
    timestamp: Date.now(),
    data: dossier
  };
  saveCache(cache);

  return dossier;
}

/**
 * Fetch character dossiers for a stream's POV character and core server characters.
 */
export async function getStreamLoreDossiers(streamId, profile) {
  const charactersToFetch = new Set();

  if (STREAMER_TO_CHARACTER[String(streamId).toLowerCase()]) {
    charactersToFetch.add(STREAMER_TO_CHARACTER[String(streamId).toLowerCase()]);
  } else {
    charactersToFetch.add(streamId);
  }

  // Include top aliases or participants configured in the profile
  if (profile?.aliases) {
    for (const charName of Object.keys(profile.aliases).slice(0, 5)) {
      charactersToFetch.add(charName);
    }
  }

  const dossiers = [];
  for (const char of charactersToFetch) {
    try {
      const dossier = await fetchCharacterDossier(char);
      if (dossier && dossier.name) {
        dossiers.push(dossier);
      }
    } catch {}
  }

  return dossiers;
}

/**
 * Augment a profile's aliases with freshly discovered aliases from Fandom Wiki.
 */
export function augmentProfileWithDossiers(profile, dossiers = []) {
  if (!profile || !Array.isArray(dossiers)) return profile;

  const nextAliases = { ...(profile.aliases || {}) };

  for (const d of dossiers) {
    if (!d?.name || !Array.isArray(d.aliases)) continue;

    const existing = nextAliases[d.name] || [];
    const normalizedNew = d.aliases
      .map((a) => a.toLowerCase().trim())
      .filter((a) => a.length >= 2 && a.length <= 25);

    const merged = [...new Set([...existing, ...normalizedNew])];
    nextAliases[d.name] = merged;
  }

  return {
    ...profile,
    aliases: nextAliases
  };
}

/**
 * Format dossiers into a clean LLM context block.
 */
export function formatLorePromptDossier(dossiers = []) {
  if (!Array.isArray(dossiers) || !dossiers.length) return [];

  const lines = [
    'CANON_CHARACTER_DOSSIERS (Verified NoPixel in-world character lore from Fandom Wiki):'
  ];

  for (const d of dossiers.slice(0, 6)) {
    const aliasStr = (d.aliases || []).slice(0, 6).join(', ');
    const affilStr = (d.affiliations || []).slice(0, 3).join(', ');
    lines.push(`- Character: ${d.name}${d.playedBy ? ` (Played by: ${d.playedBy})` : ''}`);
    if (aliasStr) lines.push(`  Aliases / Nicknames: ${aliasStr}`);
    if (affilStr) lines.push(`  Affiliations / Gangs: ${affilStr}`);
    if (d.status) lines.push(`  Status: ${d.status}`);
  }

  lines.push('INSTRUCTION: Use these canonical names and aliases. Do not confuse the streamer with the roleplay character.');
  return lines;
}
