import { useState, useMemo, useEffect } from 'react';
import { 
  Clock, Star, Play, 
  Bookmark, Check, Share2, 
  AlertTriangle, ArrowUpDown, Maximize2, LayoutGrid, Square, X, ChevronDown,
  ChevronLeft, ChevronRight, ExternalLink, Eye, ArrowRightLeft, Download, Users
} from 'lucide-react';
import { TwitchIcon, KickIcon, YouTubeIcon, RedditIcon } from './Icons';
import KickPlayer from './KickPlayer.jsx';

function fmtClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function compactDescription(value, maxChars = 150) {
  const text = String(value || '').replace(/\\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const firstSentence = text.match(/^.{1,${maxChars}}?[.!?](?:\\s|$)/)?.[0]?.trim();
  if (firstSentence && firstSentence.length <= maxChars) return firstSentence;
  return `${text.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

const CLIP_DURATION_CAP_SECONDS = 120;

function policeOutcomeStyle(outcome) {
  if (outcome === 'escaped') return 'bg-blue-500/15 text-blue-300 border-blue-500/30';
  if (outcome === 'arrested') return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
  return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
}

const BRICK_BOYS_CANON = [
  { id: 'buddha', short: 'Buddha', check: (p) => /buddha|lang/i.test(p) },
  { id: 'x', short: 'X', check: (p) => /jean\s*paul|\bjp\b|\bx\b|\bxqc\b/i.test(p) },
  { id: 'marty', short: 'Marty', check: (p) => /marty|martin/i.test(p) },
  { id: 'tony', short: 'Tony', check: (p) => /tony|corleone/i.test(p) },
];

export function getBrickBoysSquad(participants) {
  if (!Array.isArray(participants) || participants.length === 0) return null;
  const found = BRICK_BOYS_CANON.filter(member =>
    participants.some(p => member.check(p))
  );

  if (found.length === 4) {
    return {
      type: '4-man',
      key: '4-man',
      label: '4-Man Full Squad',
      shortLabel: '4-Man',
      comboLabel: 'Buddha, X, Marty, Tony',
      members: found.map(m => m.short),
      badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    };
  }

  if (found.length === 3) {
    const names = found.map(m => m.short).join(', ');
    const comboKey = '3-man-' + found.map(m => m.id).sort().join('-');
    return {
      type: '3-man',
      key: comboKey,
      label: `3-Man Trio (${names})`,
      shortLabel: '3-Man',
      comboLabel: names,
      members: found.map(m => m.short),
      badgeClass: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40',
    };
  }

  if (found.length === 2) {
    const names = found.map(m => m.short).join(' & ');
    const comboKey = '2-man-' + found.map(m => m.id).sort().join('-');
    return {
      type: '2-man',
      key: comboKey,
      label: `2-Man Duo (${names})`,
      shortLabel: '2-Man',
      comboLabel: names,
      members: found.map(m => m.short),
      badgeClass: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
    };
  }

  return null;
}

// Events from older recap files lack end times. Derive a display-only end so the
// range badge works everywhere without rewriting legacy JSON.
function eventEndSeconds(event, allEvents) {
  if (event.endSeconds !== undefined && event.endSeconds !== null) {
    return Math.max(Number(event.seconds) + 1, Number(event.endSeconds));
  }
  const sorted = [...allEvents].sort((a, b) => a.seconds - b.seconds);
  const idx = sorted.findIndex(e => e.id === event.id);
  const next = idx >= 0 ? sorted[idx + 1] : null;
  const start = Number(event.seconds) || 0;
  if (next) {
    return Math.min(start + CLIP_DURATION_CAP_SECONDS, Math.max(start + 1, next.seconds - 5));
  }
  return start + CLIP_DURATION_CAP_SECONDS;
}

function formatRange(event, allEvents) {
  const start = Number(event.seconds) || 0;
  const end = eventEndSeconds(event, allEvents);
  const dur = Math.max(0, end - start);
  if (dur <= 0) return event.timestamp;
  const mins = Math.floor(dur / 60);
  const secs = dur % 60;
  return `${event.timestamp} – ${fmtClock(end)} (${mins ? `${mins}m${secs ? ` ${secs}s` : ''}` : `${secs}s`})`;
}

const CATEGORY_CONFIG = {
  all: { label: 'All Tags', accentColor: 'bg-zinc-600', dotColor: 'bg-zinc-400' },
  crime: { label: 'Crime', accentColor: 'bg-rose-500', dotColor: 'bg-rose-500' },
  job: { label: 'Economy & Jobs', accentColor: 'bg-emerald-500', dotColor: 'bg-emerald-500' },
  chase: { label: 'Police Chases', accentColor: 'bg-blue-500', dotColor: 'bg-blue-500' },
  lore: { label: 'Lore', accentColor: 'bg-purple-500', dotColor: 'bg-purple-500' },
  medical: { label: 'Medical', accentColor: 'bg-pink-500', dotColor: 'bg-pink-500' },
  crypto: { label: 'Crypto', accentColor: 'bg-lime-400', dotColor: 'bg-lime-400' },
  mechanic: { label: 'Mechanics', accentColor: 'bg-sky-500', dotColor: 'bg-sky-500' },
  social: { label: 'Social', accentColor: 'bg-teal-500', dotColor: 'bg-teal-500' },
  general: { label: 'General', accentColor: 'bg-zinc-500', dotColor: 'bg-zinc-400' }
};

const KICK_STREAM_FALLBACKS = {
  '1': 'https://stream.kick.com/3c81249a5ce0/ivs/v1/196233775518/DsuAwCgUc9Bh/2026/9/8/14/59/8wZGxx2ttqbw/media/hls/master.m3u8',
  '2': 'https://stream.kick.com/3c81249a5ce0/ivs/v1/196233775518/DsuAwCgUc9Bh/2026/9/9/16/26/2oh2tsSCFYxW/media/hls/master.m3u8'
};

const POV_STREAM_MAP = {
  xqc: {
    name: 'xQc',
    character: 'Jean Paul (X)',
    streams: {
      '1': 'https://stream.kick.com/3c81249a5ce0/ivs/v1/196233775518/DsuAwCgUc9Bh/2026/9/8/14/59/8wZGxx2ttqbw/media/hls/master.m3u8',
      '2': 'https://stream.kick.com/3c81249a5ce0/ivs/v1/196233775518/DsuAwCgUc9Bh/2026/9/9/16/26/2oh2tsSCFYxW/media/hls/master.m3u8'
    },
    kickChannel: 'https://kick.com/xqc'
  },
  buddha: {
    name: 'Buddha',
    character: 'Lang Buddha',
    streams: {
      '1': 'https://stream.kick.com/3c81249a5ce0/ivs/v1/196233775518/BO2zfdDBEu6T/2026/9/9/17/11/TM2rqWmgja1C/media/hls/master.m3u8',
      '2': 'https://stream.kick.com/3c81249a5ce0/ivs/v1/196233775518/BO2zfdDBEu6T/2026/9/9/17/11/TM2rqWmgja1C/media/hls/master.m3u8'
    },
    kickChannel: 'https://kick.com/buddha'
  },
  omie: {
    name: 'Omie',
    character: 'Marty Banks',
    streams: {
      '1': 'https://stream.kick.com/3c81249a5ce0/ivs/v1/196233775518/MPRaN7wf9lTL/2026/9/8/14/54/nVrImoLkKHnU/media/hls/master.m3u8'
    },
    kickChannel: 'https://kick.com/omie'
  }
};

// Validation labels shown on event cards (provenance of the description).
const VALIDATION_LABELS = {
  supported:    { label: '✓ evidence-supported', cls: 'bg-emerald-500/15 text-emerald-300' },
  'needs-review': { label: '! evidence far (review)', cls: 'bg-amber-500/15 text-amber-300' },
  unmatched:    { label: '! evidence not found', cls: 'bg-rose-500/15 text-rose-300' },
  'entity-gap': { label: '! entity not in source', cls: 'bg-rose-500/15 text-rose-300' },
  'no-evidence': { label: 'no evidence supplied', cls: 'bg-zinc-700 text-zinc-400' },
  unsupported:  { label: 'unsupported', cls: 'bg-zinc-700 text-zinc-400' },
  notes:        { label: 'from notes', cls: 'bg-sky-500/15 text-sky-300' },
  'vision-confirmed': { label: '✓ visually confirmed', cls: 'bg-cyan-500/15 text-cyan-300' },
  'vision-downgraded': { label: '! visual mismatch', cls: 'bg-rose-500/15 text-rose-300' },
  'vision-needs-review': { label: '! visual review', cls: 'bg-amber-500/15 text-amber-300' },
  'human-confirmed': { label: '✓ human confirmed', cls: 'bg-emerald-500/15 text-emerald-300' },
  'human-rejected': { label: '! human rejected', cls: 'bg-rose-500/15 text-rose-300' }
};

export default function TimelineView({ 
  events, 
  bookmarks, 
  toggleBookmark, 
  showOnlyBookmarks,
  setShowOnlyBookmarks,
  searchQuery,
  setSearchQuery,
  kickStreamUrl,
  activePov,
  isOwner,
  onReviewEvent,
  onCaptureFrame,
  activeDayNumber,
  onSwitchPov,
  onSelectCharacter
}) {
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [isMajorOnly, setIsMajorOnly] = useState(false);
  const [selectedArc, setSelectedArc] = useState('all');
  const [selectedSquad, setSelectedSquad] = useState('all');
  const [sortOrder, setSortOrder] = useState('asc'); // 'asc' or 'desc'
  const [layoutMode, setLayoutMode] = useState('feed'); // 'feed' (1-col), 'grid' (2-col/3-col), or 'list' (compact timestamps)
  const [copiedId, setCopiedId] = useState(null);
  const [copiedToast, setCopiedToast] = useState(false);
  const [toastText, setToastText] = useState('');
  const [tappedId, setTappedId] = useState(null);
  const [focusedEvent, setFocusedEvent] = useState(null);
  const [isPlayingKick, setIsPlayingKick] = useState(false);
  const [capturingFrame, setCapturingFrame] = useState(false);
  const [communityThreads, setCommunityThreads] = useState([]);
  const [isSearchingCommunity, setIsSearchingCommunity] = useState(false);
  const [communitySearched, setCommunitySearched] = useState(false);
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || 
           (window.innerWidth < 768 && ('ontouchstart' in window || navigator.maxTouchPoints > 0));
  });

  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || 
        (window.innerWidth < 768 && ('ontouchstart' in window || navigator.maxTouchPoints > 0))
      );
    };
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!focusedEvent || focusedEvent.image || !isOwner || !onCaptureFrame) return undefined;
    setCapturingFrame(true);
    Promise.resolve(onCaptureFrame(focusedEvent.id, activeDayNumber))
      .then(event => {
        if (!cancelled && event) setFocusedEvent(previous => ({ ...previous, ...event }));
      })
      .finally(() => { if (!cancelled) setCapturingFrame(false); });
    return () => { cancelled = true; };
  }, [focusedEvent?.id, focusedEvent?.image, isOwner, activeDayNumber]);

  const activeKickStream = kickStreamUrl
    || POV_STREAM_MAP[activePov?.id]?.streams?.[String(activeDayNumber || '1')]
    || KICK_STREAM_FALLBACKS[focusedEvent?.id?.startsWith('d2') ? '2' : '1']
    || KICK_STREAM_FALLBACKS['1'];

  const focusedCrossPovs = useMemo(() => {
    if (!focusedEvent) return [];
    const list = [];
    const currentPovId = activePov?.id || 'xqc';

    // 1. Explicit crossPov on event
    if (focusedEvent.crossPov) {
      const p = focusedEvent.crossPov;
      const streamUrl = POV_STREAM_MAP[p.pov]?.streams?.[String(p.day || '1')] || null;
      let sec = p.seconds;
      if (sec === undefined && p.timestamp) {
        const parts = p.timestamp.split(':').map(Number);
        if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
        else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
      }
      if (streamUrl) {
        list.push({
          pov: p.pov,
          streamer: p.streamer || POV_STREAM_MAP[p.pov]?.name || p.pov,
          character: POV_STREAM_MAP[p.pov]?.character,
          timestamp: p.timestamp || fmtClock(sec),
          seconds: sec || 0,
          streamUrl,
          kickUrl: `https://kick.com/${p.pov}`
        });
      }
    }

    // 2. Derive cross-POV from participants if not already added
    const parts = focusedEvent.participants || [];
    const hasBuddha = parts.some(name => /buddha|lang/i.test(name));
    const hasX = parts.some(name => /jean\s*paul|\bjp\b|\bx\b|\bxqc\b/i.test(name));
    const hasMarty = parts.some(name => /marty|martin/i.test(name));

    if (hasBuddha && currentPovId !== 'buddha' && !list.some(item => item.pov === 'buddha')) {
      const bStream = POV_STREAM_MAP.buddha.streams['1'];
      if (bStream) {
        const targetSec = Math.max(0, Number(focusedEvent.seconds) - 2785);
        list.push({
          pov: 'buddha',
          streamer: 'Buddha',
          character: 'Lang Buddha',
          timestamp: fmtClock(targetSec),
          seconds: targetSec,
          streamUrl: bStream,
          kickUrl: 'https://kick.com/buddha'
        });
      }
    }

    if (hasX && currentPovId !== 'xqc' && !list.some(item => item.pov === 'xqc')) {
      const xStream = POV_STREAM_MAP.xqc.streams['1'];
      if (xStream) {
        const targetSec = Number(focusedEvent.seconds) + 2785;
        list.push({
          pov: 'xqc',
          streamer: 'xQc',
          character: 'Jean Paul (X)',
          timestamp: fmtClock(targetSec),
          seconds: targetSec,
          streamUrl: xStream,
          kickUrl: 'https://kick.com/xqc'
        });
      }
    }

    if (hasMarty && currentPovId !== 'omie' && !list.some(item => item.pov === 'omie')) {
      const oStream = POV_STREAM_MAP.omie.streams['1'];
      if (oStream) {
        const targetSec = currentPovId === 'xqc' ? Number(focusedEvent.seconds) + 300 : Number(focusedEvent.seconds);
        list.push({
          pov: 'omie',
          streamer: 'Marty (Omie)',
          character: 'Marty Banks',
          timestamp: fmtClock(targetSec),
          seconds: targetSec,
          streamUrl: oStream,
          kickUrl: 'https://kick.com/omie'
        });
      }
    }

    return list;
  }, [focusedEvent, activePov?.id]);

  const showToast = (text, duration = 2000) => {
    setToastText(text);
    setCopiedToast(true);
    setTimeout(() => {
      setCopiedToast(false);
      setToastText('');
    }, duration);
  };

  // Copy share link
  const copyEventLink = (event) => {
    const url = `${window.location.origin}${window.location.pathname}#${event.id}`;
    try {
      navigator.clipboard.writeText(url);
    } catch {}
    setCopiedId(event.id);
    showToast('timestamp link copied', 2000);
    setTimeout(() => {
      setCopiedId(null);
    }, 2000);
  };

  // On mobile: open the focused card modal with the in-app player already playing
  const handleMobileKickPlay = (e, event) => {
    e.preventDefault();
    e.stopPropagation();
    setFocusedEvent(event);
    setIsPlayingKick(true);
  };

  // Filtered & sorted events (Combined with AND logic)
  const filteredEvents = useMemo(() => {
    return events.filter(event => {
      // 1. Bookmark filter
      if (showOnlyBookmarks && !bookmarks.includes(event.id)) {
        return false;
      }
      // 2. Major Only filter
      if (isMajorOnly && !event.isMajor) {
        return false;
      }
      // 3. Category Tag filter — match if any of the event's tags include selected
      if (selectedCategory !== 'all' && !(event.tags || [event.category]).includes(selectedCategory)) {
        return false;
      }
      // 4. Storyline Arc filter
      if (selectedArc !== 'all' && event.arcId !== selectedArc) {
        return false;
      }
      // 5. Squad Formation filter
      if (selectedSquad !== 'all') {
        const squad = getBrickBoysSquad(event.participants);
        if (!squad) return false;
        if (selectedSquad === 'any-squad') {
          // matched any Brick Boys squad
        } else if (selectedSquad === '4-man' || selectedSquad === '3-man' || selectedSquad === '2-man') {
          if (squad.type !== selectedSquad) return false;
        } else if (squad.key !== selectedSquad) {
          return false;
        }
      }
      // 6. Search query filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchDesc = event.description?.toLowerCase().includes(q);
        const matchTime = event.timestamp?.includes(q);
        return matchDesc || matchTime;
      }
      return true;
    }).sort((a, b) => {
      return sortOrder === 'asc' ? a.seconds - b.seconds : b.seconds - a.seconds;
    });
  }, [events, selectedCategory, selectedArc, selectedSquad, isMajorOnly, showOnlyBookmarks, bookmarks, searchQuery, sortOrder]);

  // Keyboard navigation for focused one-column card view (defined AFTER filteredEvents)
  const handlePrevFocused = () => {
    if (!focusedEvent) return;
    const idx = filteredEvents.findIndex(e => e.id === focusedEvent.id);
    if (idx > 0) {
      setIsPlayingKick(false);
      setFocusedEvent(filteredEvents[idx - 1]);
    }
  };

  const handleNextFocused = () => {
    if (!focusedEvent) return;
    const idx = filteredEvents.findIndex(e => e.id === focusedEvent.id);
    if (idx !== -1 && idx < filteredEvents.length - 1) {
      setIsPlayingKick(false);
      setFocusedEvent(filteredEvents[idx + 1]);
    }
  };

  useEffect(() => {
    if (!focusedEvent) return;
    setCommunityThreads([]);
    setCommunitySearched(false);
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setFocusedEvent(null);
      } else if (e.key === 'ArrowLeft') {
        handlePrevFocused();
      } else if (e.key === 'ArrowRight') {
        handleNextFocused();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusedEvent, filteredEvents]);

  // Dynamic category counts — each tag in tags[] increments its own bucket
  const categoryCounts = useMemo(() => {
    const counts = { all: 0 };
    events.forEach(e => {
      const matchMajor = !isMajorOnly || e.isMajor;
      if (matchMajor) {
        counts.all = (counts.all || 0) + 1;
        const tags = e.tags || [e.category];
        tags.forEach(t => { counts[t] = (counts[t] || 0) + 1; });
      }
    });
    return counts;
  }, [events, isMajorOnly]);

  const majorCount = useMemo(() => {
    return events.filter(e => {
      const matchCat = selectedCategory === 'all' || (e.tags || [e.category]).includes(selectedCategory);
      const matchArc = selectedArc === 'all' || e.arcId === selectedArc;
      const squad = getBrickBoysSquad(e.participants);
      let matchSquad = true;
      if (selectedSquad === 'any-squad') matchSquad = Boolean(squad);
      else if (selectedSquad === '4-man' || selectedSquad === '3-man' || selectedSquad === '2-man') matchSquad = squad?.type === selectedSquad;
      else if (selectedSquad !== 'all') matchSquad = squad?.key === selectedSquad;
      return e.isMajor && matchCat && matchArc && matchSquad;
    }).length;
  }, [events, selectedCategory, selectedArc, selectedSquad]);

  const availableArcs = useMemo(() => {
    const map = new Map();
    for (const e of events) {
      if (e.arcId && e.arcTitle) {
        if (!map.has(e.arcId)) {
          map.set(e.arcId, { id: e.arcId, title: e.arcTitle, count: 0 });
        }
        map.get(e.arcId).count++;
      }
    }
    return Array.from(map.values());
  }, [events]);

  const availableSquads = useMemo(() => {
    const typeCounts = { '4-man': 0, '3-man': 0, '2-man': 0, total: 0 };
    const comboMap = new Map();

    for (const e of events) {
      const squad = getBrickBoysSquad(e.participants);
      if (squad) {
        typeCounts.total++;
        typeCounts[squad.type]++;
        if (!comboMap.has(squad.key)) {
          comboMap.set(squad.key, {
            key: squad.key,
            type: squad.type,
            label: squad.label,
            comboLabel: squad.comboLabel,
            count: 0
          });
        }
        comboMap.get(squad.key).count++;
      }
    }

    return {
      typeCounts,
      combos: Array.from(comboMap.values()).sort((a, b) => {
        if (a.type !== b.type) return a.type.localeCompare(b.type);
        return b.count - a.count;
      })
    };
  }, [events]);

  const hasActiveFilters = selectedCategory !== 'all' || selectedArc !== 'all' || selectedSquad !== 'all' || isMajorOnly || searchQuery || showOnlyBookmarks;

  const kickBtnClass = isPlayingKick
    ? 'bg-[#53fc18] text-black border-[#53fc18] shadow-md'
    : 'bg-[#53fc18]/15 hover:bg-[#53fc18]/25 text-[#53fc18] border border-[#53fc18]/30';

  const handleSearchCommunity = async () => {
    if (!focusedEvent) return;
    setIsSearchingCommunity(true);
    setCommunitySearched(true);
    try {
      const q = focusedEvent.title || focusedEvent.description || '';
      const res = await fetch(`/api/community/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setCommunityThreads(data?.results || []);
    } catch {
      setCommunityThreads([]);
    } finally {
      setIsSearchingCommunity(false);
    }
  };

  // Export the shown moments as a Clipper timestamp file (START - END | label).
  // Deduplicates exact ranges and clamps overlaps so Clipper's parser accepts it.
  const exportClips = () => {
    const sorted = [...filteredEvents].sort((a, b) => a.seconds - b.seconds);
    const lines = [];
    const seen = new Set();
    let coveredUntil = -1;
    for (const event of sorted) {
      let start = Number(event.seconds) || 0;
      const end = eventEndSeconds(event, sorted);
      if (start < coveredUntil) start = coveredUntil;
      if (end <= start) continue;
      const key = `${start}:${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      coveredUntil = end;
      const label = String(event.title || event.description || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      lines.push(`${fmtClock(start)}-${fmtClock(end)} | ${label}`);
    }
    const header = `# ${activePov?.name || 'StreamRecap'} clip candidates (${lines.length} moments)\n# Paste into Clipper to render these ranges\n`;
    const blob = new Blob([header, lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${String(activePov?.name || 'stream').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-clips.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('clip timestamps exported');  };

  return (
    <div className="max-w-5xl mx-auto space-y-3 pb-16">
      {/* Grounded Neutral Filter Controls Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1 text-xs">
        {/* Left Side: Major Only Toggle + Character Dropdown + Tag Dropdown */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Major Highlights Toggle Button */}
          <button
            onClick={() => setIsMajorOnly(!isMajorOnly)}
            className={`px-3 py-1.5 rounded-md font-medium whitespace-nowrap transition-colors border flex items-center gap-1.5 cursor-pointer ${
              isMajorOnly
                ? 'bg-amber-500 text-black border-amber-400 font-semibold shadow-sm'
                : 'bg-zinc-900/90 text-zinc-300 border-white/[0.08] hover:bg-zinc-800/80 hover:text-white'
            }`}
            title="Filter to Major Breakthrough Moments (bolded by author)"
          >
            <Star className={`w-3.5 h-3.5 ${isMajorOnly ? 'fill-black text-black' : 'fill-amber-400 text-amber-400'}`} />
            <span>Major Highlights</span>
            <span className={`px-1.5 py-0.2 rounded text-[10px] font-mono tabular-nums font-semibold ${isMajorOnly ? 'bg-black/20 text-black' : 'bg-zinc-800 text-zinc-400'}`}>
              {majorCount}
            </span>
          </button>

          {/* Tags Dropdown Filter */}
          <div className="relative">
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              className={`pl-3 pr-8 py-1.5 rounded-md text-xs border focus:outline-none transition-colors appearance-none cursor-pointer ${
                selectedCategory === 'all'
                  ? 'bg-zinc-900/90 text-zinc-300 border-white/[0.08] hover:border-zinc-700'
                  : 'bg-zinc-800 text-white border-zinc-600 font-medium'
              }`}
              title="Filter by category tag"
            >
              <option value="all">All Tags ({categoryCounts.all || events.length})</option>
              {Object.entries(CATEGORY_CONFIG)
                .filter(([k]) => k !== 'all')
                .map(([key, config]) => {
                  const count = categoryCounts[key] || 0;
                  return (
                    <option key={key} value={key}>
                      {config.label} ({count})
                    </option>
                  );
                })}
            </select>
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          </div>

          {/* Storyline Arc Filter Dropdown */}
          {availableArcs.length > 0 && (
            <div className="relative">
              <select
                value={selectedArc}
                onChange={(e) => setSelectedArc(e.target.value)}
                className={`pl-3 pr-8 py-1.5 rounded-md text-xs border focus:outline-none transition-colors appearance-none cursor-pointer ${
                  selectedArc === 'all'
                    ? 'bg-zinc-900/90 text-zinc-300 border-white/[0.08] hover:border-zinc-700'
                    : 'bg-purple-950/70 text-purple-200 border-purple-500/40 font-medium'
                }`}
                title="Filter by storyline arc"
              >
                <option value="all">All Storylines ({events.length})</option>
                {availableArcs.map((arc) => (
                  <option key={arc.id} value={arc.id}>
                    {arc.title} ({arc.count})
                  </option>
                ))}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-zinc-500 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          )}

          {/* Squad Formation Filter Dropdown */}
          {availableSquads.typeCounts.total > 0 && (
            <div className="relative">
              <select
                value={selectedSquad}
                onChange={(e) => setSelectedSquad(e.target.value)}
                className={`pl-3 pr-8 py-1.5 rounded-md text-xs border focus:outline-none transition-colors appearance-none cursor-pointer ${
                  selectedSquad === 'all'
                    ? 'bg-zinc-900/90 text-zinc-300 border-white/[0.08] hover:border-zinc-700'
                    : 'bg-amber-950/70 text-amber-200 border-amber-500/40 font-medium'
                }`}
                title="Filter by Brick Boys squad formation"
              >
                <option value="all">All Squads ({events.length})</option>
                <option value="any-squad">Any Brick Boys Squad ({availableSquads.typeCounts.total})</option>
                {availableSquads.typeCounts['4-man'] > 0 && (
                  <option value="4-man">4-Man Full Squad ({availableSquads.typeCounts['4-man']})</option>
                )}
                {availableSquads.typeCounts['3-man'] > 0 && (
                  <option value="3-man">3-Man Trios ({availableSquads.typeCounts['3-man']})</option>
                )}
                {availableSquads.typeCounts['2-man'] > 0 && (
                  <option value="2-man">2-Man Duos ({availableSquads.typeCounts['2-man']})</option>
                )}
                {availableSquads.combos.length > 1 && (
                  <optgroup label="Specific Combinations">
                    {availableSquads.combos.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label} ({c.count})
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <ChevronDown className="w-3.5 h-3.5 text-zinc-500 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            </div>
          )}
        </div>

        {/* Right Controls: Export, Sort Order & Layout Switcher */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Export clip timestamp ranges (Clipper-compatible: START - END | label) */}
          <button
            onClick={exportClips}
            className="px-2.5 py-1.5 rounded-md bg-zinc-900/90 hover:bg-emerald-900/60 hover:border-emerald-500/40 text-zinc-400 hover:text-emerald-300 border border-white/[0.08] transition-colors flex items-center gap-1.5 cursor-pointer"
            title="Export the displayed moments as a Clipper-compatible timestamp file"
          >
            <Download className="w-3 h-3" />
            <span className="text-[11px] hidden sm:inline">Export clips</span>
          </button>

          {/* Sort order toggle */}
          <button
            onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
            className="px-2.5 py-1.5 rounded-md bg-zinc-900/90 hover:bg-zinc-800/80 text-zinc-400 hover:text-zinc-200 border border-white/[0.08] transition-colors flex items-center gap-1.5 cursor-pointer"
            title={sortOrder === 'asc' ? 'Earliest first' : 'Latest first'}
          >
            <ArrowUpDown className="w-3 h-3 text-zinc-400" />
            <span className="text-[11px] hidden sm:inline font-mono tabular-nums">
              {sortOrder === 'asc' ? '01:00 → 13:25' : '13:25 → 01:00'}
            </span>
          </button>

          {/* Layout switcher: Feed (1-col), Grid (2-col on mobile, 3-col on desktop), List (Timestamps) */}
          <div className="flex items-center bg-zinc-900/90 rounded-md border border-white/[0.08] p-0.5 gap-0.5">
            <button
              onClick={() => setLayoutMode('feed')}
              className={`p-1.5 rounded transition-colors cursor-pointer ${layoutMode === 'feed' ? 'bg-zinc-800 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
              title="Single column view"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setLayoutMode('grid')}
              className={`p-1.5 rounded transition-colors cursor-pointer ${layoutMode === 'grid' ? 'bg-zinc-800 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
              title="Multi column view"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setLayoutMode('list')}
              className={`p-1.5 rounded transition-colors cursor-pointer ${layoutMode === 'list' ? 'bg-zinc-800 text-zinc-100 shadow-sm' : 'text-zinc-500 hover:text-zinc-300'}`}
              title="Timestamp view"
            >
              <Clock className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Active Combined Filter Chips (Clearable independently) */}
      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1 pb-1 text-xs text-zinc-400 bg-zinc-900/60 p-2 rounded-lg border border-white/[0.08]">
          <span className="text-[11px] font-medium text-zinc-500 mr-1 uppercase tracking-wider">
            Filters ({filteredEvents.length} moments):
          </span>

          {/* Major Filter Chip */}
          {isMajorOnly && (
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[11px] font-medium">
              <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
              <span>Major Highlights</span>
              <button onClick={() => setIsMajorOnly(false)} className="hover:text-white p-0.5 cursor-pointer" title="Remove Major filter">
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {/* Tag Filter Chip */}
          {selectedCategory !== 'all' && (
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-zinc-800 text-zinc-200 border border-zinc-700 text-[11px] font-medium">
              <span>Tag: {CATEGORY_CONFIG[selectedCategory]?.label || selectedCategory}</span>
              <button onClick={() => setSelectedCategory('all')} className="hover:text-white p-0.5 cursor-pointer" title="Remove Tag filter">
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {/* Search Query Chip */}
          {searchQuery && (
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-zinc-800 text-zinc-200 border border-zinc-700 text-[11px]">
              <span>Search: "{searchQuery}"</span>
              <button onClick={() => setSearchQuery('')} className="hover:text-white p-0.5 cursor-pointer" title="Clear search">
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {/* Saved Bookmarks Chip */}
          {showOnlyBookmarks && (
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-amber-500/10 text-amber-300 border border-amber-500/30 text-[11px]">
              <span>Saved Only</span>
              <button onClick={() => setShowOnlyBookmarks(false)} className="hover:text-white p-0.5 cursor-pointer" title="Show all">
                <X className="w-3 h-3" />
              </button>
            </span>
          )}

          {/* Reset All Filters */}
          <button
            onClick={() => {
              setSelectedCategory('all');
              setIsMajorOnly(false);
              setSearchQuery('');
              setShowOnlyBookmarks(false);
            }}
            className="text-zinc-500 hover:text-zinc-200 text-[11px] underline ml-auto font-medium transition-colors cursor-pointer"
          >
            Reset all
          </button>
        </div>
      )}

      {/* Empty State */}
      {events.length === 0 && (
        <div className="text-center py-20 px-4 bg-zinc-900/40 rounded-2xl border border-white/[0.08] space-y-3">
          <div className="w-12 h-12 rounded-full bg-amber-500/10 text-amber-400 flex items-center justify-center mx-auto border border-amber-500/20">
            <Clock className="w-6 h-6" />
          </div>
          <h3 className="text-lg font-semibold text-zinc-100">Ready for Fresh Recaps</h3>
          <p className="text-xs text-zinc-400 max-w-md mx-auto leading-relaxed">
            This stream has a clean slate. Click <strong className="text-amber-300 font-medium">+ Add Stream</strong> in the header to ingest a VOD and generate your own fresh timestamps and AI timeline!
          </p>
        </div>
      )}

      {events.length > 0 && filteredEvents.length === 0 && (
        <div className="text-center py-16 px-4 bg-zinc-900/40 rounded-xl border border-white/[0.08] space-y-3">
          <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto" />
          <h3 className="text-base font-semibold text-zinc-200">No timeline moments match this combination</h3>
          <p className="text-xs text-zinc-400 max-w-sm mx-auto">
            Try removing one of the active filters above to see matching moments.
          </p>
          <button
            onClick={() => {
              setSelectedCategory('all');
              setSelectedArc('all');
              setSelectedSquad('all');
              setIsMajorOnly(false);
              setSearchQuery('');
              setShowOnlyBookmarks(false);
            }}
            className="px-3.5 py-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium text-xs border border-zinc-700 transition-colors cursor-pointer"
          >
            Reset Filters
          </button>
        </div>
      )}

      {/* View Mode Switching: List Mode vs Visual Gallery Mode */}
      {layoutMode === 'list' ? (
        /* Dense Compact Timestamp List View */
        <div className="rounded-xl border border-white/[0.08] bg-zinc-950/70 overflow-hidden divide-y divide-white/[0.05]">
          {filteredEvents.map((event) => {
            const isBookmarked = bookmarks.includes(event.id);
            const imgSrc = event.image || '/images/placeholder.svg';

            return (
              <div
                key={event.id}
                id={event.id}
                className="group flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-2.5 sm:px-3.5 sm:py-2.5 hover:bg-zinc-900/60 transition-colors"
              >
                {/* Left: Timestamp + Major Star + Mini Thumbnail + Description */}
                <div className="flex items-center gap-2 sm:gap-2.5 min-w-0 flex-1">
                    <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-black/60 text-zinc-200 border border-white/10 text-xs font-mono tabular-nums font-semibold shrink-0">
                      <Clock className="w-3 h-3 text-zinc-400" />
                      <span title={formatRange(event, filteredEvents)}>{event.timestamp}</span>
                    </span>

                    {eventEndSeconds(event, filteredEvents) > (Number(event.seconds) || 0) && (
                      <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded bg-black/60 text-zinc-300 border border-white/10 text-[10px] font-mono tabular-nums shrink-0" title={`Ends at ${fmtClock(eventEndSeconds(event, filteredEvents))} · ${eventEndSeconds(event, filteredEvents) - (Number(event.seconds) || 0)}s`}>
                        {fmtClock(eventEndSeconds(event, filteredEvents))}
                      </span>
                    )}

                  {event.isMajor && (
                    <span title="Major Highlight" className="shrink-0">
                      <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                    </span>
                  )}

                  {/* Clickable mini thumbnail (opens 1-column card modal) */}
                  <button
                    onClick={() => setFocusedEvent(event)}
                    className="relative w-12 sm:w-14 aspect-video rounded overflow-hidden border border-white/10 shrink-0 group/thumb hover:border-zinc-500 transition-colors cursor-pointer"
                    title="Click to view details"
                  >
                    <img
                      src={imgSrc}
                      alt={event.description}
                      loading="lazy"
                      className="w-full h-full object-cover group-hover/thumb:scale-105 transition-transform"
                    />
                    <div className="absolute inset-0 bg-black/30 opacity-0 group-hover/thumb:opacity-100 flex items-center justify-center transition-opacity">
                      <Maximize2 className="w-2.5 h-2.5 text-white" />
                    </div>
                  </button>

                  {/* Description */}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs sm:text-sm text-zinc-200 font-medium line-clamp-2 sm:line-clamp-1 leading-snug" title={event.description}>
                      {compactDescription(event.description)}
                    </p>
                    {event.validation && (
                      <p className="mt-1 text-[10px] inline-flex items-center gap-1">
                        <span className={`keyLabel ${VALIDATION_LABELS[event.validation]?.cls || 'bg-zinc-700 text-zinc-400'}`}>
                          {VALIDATION_LABELS[event.validation]?.label || event.validation}
                        </span>
                        {event.needsReview && <span className="text-amber-400/90">needs review</span>}
                      </p>
                    )}
                    {event.evidence && (
                      <p className="mt-1 text-[10px] text-emerald-300/80 line-clamp-1" title={event.evidence}>
                        Evidence: “{event.evidence}”
                      </p>
                    )}
                    {event.visionValidation?.visualEvidence && (
                      <p className="mt-1 text-[10px] text-cyan-300/75 line-clamp-1" title={event.visionValidation.visualEvidence}>
                        Visual check: {event.visionValidation.visualEvidence}
                      </p>
                    )}
                    {isOwner && event.needsReview && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
                        <span className="text-amber-300/80">Human review:</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); onReviewEvent?.(event.id, 'approved'); }}
                          className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/25 cursor-pointer"
                        >Approve</button>
                        <button
                          onClick={(e) => { e.stopPropagation(); onReviewEvent?.(event.id, 'rejected'); }}
                          className="px-1.5 py-0.5 rounded bg-rose-500/15 border border-rose-500/30 text-rose-300 hover:bg-rose-500/25 cursor-pointer"
                        >Reject</button>
                      </div>
                    )}
                    {event.participants?.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        {event.participants.map((p) => (
                          <button
                            key={p}
                            onClick={(e) => { e.stopPropagation(); onSelectCharacter?.(p); }}
                            className="px-1.5 py-0.2 rounded text-[9px] font-medium bg-zinc-800/90 hover:bg-amber-500/20 text-zinc-300 hover:text-amber-300 border border-white/[0.08] hover:border-amber-500/30 transition-colors cursor-pointer"
                            title={`View ${p} character dossier & moments`}
                          >
                            @{p}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Economy Badge */}
                    {event.economy && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 font-medium">
                          <span>💰 {event.economy.asset}</span>
                          {event.economy.price && <span>· {event.economy.price}</span>}
                          {event.economy.amount && <span>({event.economy.amount})</span>}
                          <span className="opacity-75 uppercase text-[8px]">{event.economy.action}</span>
                        </span>
                        <span className={`px-1.5 py-0.2 rounded text-[9px] font-medium border ${
                          event.economy.verification === 'screen-verified'
                            ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'
                            : 'bg-zinc-800 text-zinc-400 border-white/10'
                        }`}>
                          {event.economy.verification === 'screen-verified' ? '✓ Screen Verified' : 'Spoken Claim'}
                        </span>
                      </div>
                    )}

                    {/* Police Incident Badge */}
                    {event.policeIncident && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px]">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium border ${policeOutcomeStyle(event.policeIncident.outcome)}`}>
                          <span>🚨 Police: {event.policeIncident.outcome === 'escaped' ? 'Pursuit Escaped' : event.policeIncident.outcome}</span>
                          {event.policeIncident.charges?.length > 0 && (
                            <span className="opacity-75">({event.policeIncident.charges.join(', ')})</span>
                          )}
                        </span>
                      </div>
                    )}

                    {/* Story Arc Badge */}
                    {event.arcTitle && (
                      <div className="mt-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedArc(event.arcId); }}
                          className="inline-flex items-center gap-1 text-[9px] font-semibold text-purple-300 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/25 px-1.5 py-0.5 rounded transition-colors cursor-pointer"
                          title="Filter timeline to this story arc"
                        >
                          <span>⚡ {event.arcTitle}</span>
                        </button>
                      </div>
                    )}

                    {/* Squad Formation Badge */}
                    {(() => {
                      const squad = getBrickBoysSquad(event.participants);
                      if (!squad) return null;
                      return (
                        <div className="mt-1">
                          <button
                            onClick={(e) => { e.stopPropagation(); setSelectedSquad(squad.key); }}
                            className={`inline-flex items-center gap-1 text-[9px] font-semibold px-1.5 py-0.5 rounded border transition-colors cursor-pointer ${squad.badgeClass}`}
                            title={`Filter timeline to this squad combination (${squad.comboLabel})`}
                          >
                            <Users className="w-2.5 h-2.5" />
                            <span>{squad.label}</span>
                          </button>
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* Right: Category Tags + Twitch + Kick + Bookmark + Share */}
                <div className="flex items-center justify-between sm:justify-end gap-2 shrink-0 pt-1 sm:pt-0 border-t sm:border-t-0 border-white/[0.04]">
                  {/* Category Tags + Cross-POV Link */}
                  <div className="flex items-center gap-1">
                    {event.crossPov && (
                      <button
                        onClick={() => onSwitchPov?.(event.crossPov.pov, event.crossPov.day, event.crossPov.eventId)}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border border-rose-500/30 transition-all cursor-pointer shrink-0"
                        title={`Watch ${event.crossPov.streamer}'s version of this moment`}
                      >
                        <Eye className="w-3 h-3 text-rose-400" />
                        <span className="hidden md:inline">{event.crossPov.streamer}'s view</span>
                        <span className="md:hidden">POV</span>
                        <span className="font-mono text-[9px] opacity-75">{event.crossPov.timestamp}</span>
                      </button>
                    )}

                    {(event.tags || [event.category]).map((tag) => (
                      <span
                        key={tag}
                        className="inline-flex items-center gap-1 text-[10px] text-zinc-400 bg-zinc-900 px-1.5 py-0.5 rounded border border-white/[0.06]"
                        title={CATEGORY_CONFIG[tag]?.label || tag}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${CATEGORY_CONFIG[tag]?.dotColor || 'bg-zinc-400'}`} />
                        <span className="hidden md:inline">{CATEGORY_CONFIG[tag]?.label || tag}</span>
                      </span>
                    ))}
                  </div>

                  {/* Twitch & Kick Jump Buttons */}
                  <div className="flex items-center gap-1">
                    {(event.twitchUrl || activePov?.twitchChannel) && (
                      <a
                        href={event.twitchUrl || activePov.twitchChannel}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded bg-[#9146ff] hover:bg-[#772ce8] text-white transition-colors shadow-sm flex items-center justify-center"
                        title={`Jump to ${event.timestamp} on Twitch`}
                      >
                        <TwitchIcon className="w-3.5 h-3.5 fill-current" />
                      </a>
                    )}

                    {event.kickUrl && event.kickUrl.includes('/videos/') && (
                      isMobile ? (
                        <button
                          onClick={(e) => handleMobileKickPlay(e, event)}
                          className="p-1.5 rounded bg-[#53fc18]/15 hover:bg-[#53fc18]/25 text-[#53fc18] border border-[#53fc18]/30 transition-colors flex items-center justify-center cursor-pointer"
                          title={`Play in browser @ ${event.timestamp}`}
                        >
                          <KickIcon className="w-3.5 h-3.5 fill-current" />
                        </button>
                      ) : (
                        <a
                          href={event.kickUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded bg-[#53fc18]/15 hover:bg-[#53fc18]/25 text-[#53fc18] border border-[#53fc18]/30 transition-colors flex items-center justify-center"
                          title={`Jump to ${event.timestamp} on Kick`}
                        >
                          <KickIcon className="w-3.5 h-3.5 fill-current" />
                        </a>
                      )
                    )}

                    {event.youtubeUrl && (
                      <a
                        href={event.youtubeUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded bg-[#ff0000] hover:bg-[#cc0000] text-white transition-colors shadow-sm flex items-center justify-center"
                        title={`Jump to ${event.timestamp} on YouTube`}
                      >
                        <YouTubeIcon className="w-3.5 h-3.5 fill-current" />
                      </a>
                    )}

                    {(event.redditUrl || event.communityUrl) && (
                      <a
                        href={event.redditUrl || event.communityUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded bg-[#ff4500]/15 hover:bg-[#ff4500]/25 text-[#ff4500] border border-[#ff4500]/30 transition-colors flex items-center justify-center"
                        title="View community discussion on Reddit"
                      >
                        <RedditIcon className="w-3.5 h-3.5 fill-current" />
                      </a>
                    )}

                    <button
                      onClick={() => toggleBookmark(event.id)}
                      className={`p-1.5 rounded border transition-colors cursor-pointer ${
                        isBookmarked
                          ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                          : 'bg-zinc-900 border-white/10 text-zinc-400 hover:text-white'
                      }`}
                      title={isBookmarked ? 'Remove bookmark' : 'Bookmark this moment'}
                    >
                      <Bookmark className={`w-3.5 h-3.5 ${isBookmarked ? 'fill-amber-400' : ''}`} />
                    </button>

                    <button
                      onClick={() => copyEventLink(event)}
                      className="p-1.5 rounded bg-zinc-900 border border-white/10 text-zinc-400 hover:text-white transition-colors cursor-pointer"
                      title="Copy link"
                    >
                      {copiedId === event.id ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Share2 className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* Visual Screenshot Gallery: Feed (1-col) or Grid (2-col on mobile & tablet, 3-col on desktop) */
        <div className={layoutMode === 'grid' ? 'grid grid-cols-2 lg:grid-cols-3 gap-2 sm:gap-4' : 'space-y-4'}>
          {filteredEvents.map((event) => {
            const isBookmarked = bookmarks.includes(event.id);
            const isTapped = tappedId === event.id;
            const imgSrc = event.image || '/images/placeholder.svg';

            return (
              <article
                key={event.id}
                id={event.id}
                onClick={() => {
                  if (layoutMode === 'grid') {
                    setFocusedEvent(event);
                  } else {
                    setTappedId(isTapped ? null : event.id);
                  }
                }}
                className="group relative rounded-xl overflow-hidden aspect-video bg-zinc-950 border border-white/[0.08] hover:border-zinc-600/80 shadow-md transition-all duration-200 ease-out cursor-pointer select-none"
              >
                {/* Full-Bleed Screenshot with subtle 1.02x scale-up */}
                <img
                  src={imgSrc}
                  alt={event.description}
                  loading="lazy"
                  className="w-full h-full object-cover object-center transition-transform duration-300 ease-out group-hover:scale-[1.02]"
                />

                {/* Subtle Top Gradient for Badge Readability */}
                <div className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/70 to-transparent pointer-events-none group-hover:opacity-0 transition-opacity duration-200 ease-out"></div>

                {/* Translucent Centered Play Icon on Hover */}
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10 opacity-0 group-hover:opacity-90 transition-all duration-200 ease-out scale-90 group-hover:scale-100">
                  <div className="w-8 h-8 sm:w-11 sm:h-11 rounded-full bg-black/60 backdrop-blur-md border border-white/20 flex items-center justify-center text-white shadow-xl">
                    <Play className="w-4 h-4 sm:w-5 sm:h-5 fill-white ml-0.5" />
                  </div>
                </div>

                {/* Top Permanent Badge & Action Overlay - sits at z-30 above hover backdrop */}
                <div className="absolute top-2 sm:top-2.5 left-2 sm:left-3.5 right-2 sm:right-3 flex items-center justify-between pointer-events-auto z-30">
                  <div className="flex items-center gap-1 sm:gap-1.5">
                    {/* Frosted Glass Monospace Timestamp Pill */}
                    <span className="flex items-center gap-1 px-1.5 sm:px-2.5 py-0.5 sm:py-1 rounded-md bg-black/60 backdrop-blur-md text-zinc-200 border border-white/10 text-[10px] sm:text-xs font-mono tabular-nums font-semibold shadow-sm">
                      <Clock className="w-3 h-3 text-zinc-400" />
                      <span>{event.timestamp}</span>
                      {eventEndSeconds(event, filteredEvents) > (Number(event.seconds) || 0) && (
                        <span className="hidden md:inline text-zinc-400">– {fmtClock(eventEndSeconds(event, filteredEvents))}</span>
                      )}
                    </span>

                    {/* Major Update Badge (Amber) */}
                    {event.isMajor && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsMajorOnly(!isMajorOnly);
                        }}
                        className="flex items-center gap-1 px-1.5 sm:px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[9px] sm:text-[10px] font-semibold tracking-wide uppercase shadow-sm hover:bg-amber-500/30 transition-colors cursor-pointer"
                        title="Major breakthrough moment"
                      >
                        <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400" />
                        <span className="hidden sm:inline">Major</span>
                      </button>
                    )}

                    {/* Tag dots — visible on desktop */}
                    <div className="hidden md:flex items-center gap-1">
                      {(event.tags || [event.category]).map(tag => (
                        <button
                          key={tag}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedCategory(selectedCategory === tag ? 'all' : tag);
                          }}
                          className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60 backdrop-blur-md border border-white/10 text-[10px] font-medium text-zinc-300 hover:text-white hover:bg-black/80 transition-colors cursor-pointer"
                          title={`Filter: ${CATEGORY_CONFIG[tag]?.label || tag}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${CATEGORY_CONFIG[tag]?.dotColor || 'bg-zinc-400'}`}></span>
                          <span>{CATEGORY_CONFIG[tag]?.label || tag}</span>
                        </button>
                      ))}
                    </div>

                    {/* Squad formation pill on front of card */}
                    {(() => {
                      const squad = getBrickBoysSquad(event.participants);
                      if (!squad) return null;
                      return (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedSquad(selectedSquad === squad.key ? 'all' : squad.key);
                          }}
                          className={`hidden sm:inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[9px] font-semibold tracking-wide border shadow-sm backdrop-blur-md transition-all cursor-pointer ${squad.badgeClass}`}
                          title={`Filter: ${squad.label}`}
                        >
                          <Users className="w-2.5 h-2.5" />
                          <span>{squad.shortLabel}</span>
                        </button>
                      );
                    })()}
                  </div>

                  {/* Bookmark & Share Actions */}
                  <div className="flex items-center gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleBookmark(event.id);
                      }}
                      className={`p-1 sm:p-1.5 rounded-md backdrop-blur-md border transition-colors cursor-pointer ${
                        isBookmarked
                          ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                          : 'bg-black/60 border-white/10 text-zinc-400 hover:text-white hover:bg-black/80'
                      }`}
                      title={isBookmarked ? 'Remove bookmark' : 'Bookmark this moment'}
                    >
                      <Bookmark className={`w-3 sm:w-3.5 h-3 sm:h-3.5 ${isBookmarked ? 'fill-amber-400' : ''}`} />
                    </button>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        copyEventLink(event);
                      }}
                      className="p-1 sm:p-1.5 rounded-md backdrop-blur-md bg-black/60 border border-white/10 text-zinc-400 hover:text-white hover:bg-black/80 transition-colors cursor-pointer"
                      title="Copy direct link"
                    >
                      {copiedId === event.id ? <Check className="w-3 sm:w-3.5 h-3 sm:h-3.5 text-emerald-400" /> : <Share2 className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>

                {/* Hover Pop-Up Overlay */}
                <div
                  className={`absolute inset-0 bg-[#09090b]/92 backdrop-blur-md px-3 sm:px-4 pt-9 sm:pt-10 pb-2 sm:pb-2.5 flex flex-col justify-between transition-all duration-200 ease-out z-20 ${
                    isTapped ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'
                  }`}
                >
                  {/* Overlay Body: Description (top-aligned to prevent cutting off the start) */}
                  <div className="flex-1 min-h-0 overflow-y-auto pr-1 pt-1 flex flex-col justify-start">
                    <p className="text-zinc-100 text-[11px] sm:text-xs md:text-sm leading-snug font-medium" title={event.description}>
                      {compactDescription(event.description)}
                    </p>
                    {event.participants?.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {event.participants.map((p) => (
                          <button
                            key={p}
                            onClick={(e) => { e.stopPropagation(); onSelectCharacter?.(p); }}
                            className="px-1.5 py-0.2 rounded text-[9px] font-medium bg-zinc-800 hover:bg-amber-500/20 text-zinc-300 hover:text-amber-300 border border-white/10 hover:border-amber-500/30 transition-colors cursor-pointer"
                            title={`View ${p} character dossier`}
                          >
                            @{p}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Economy & Police Badges in Card */}
                    {(event.economy || event.policeIncident || event.arcTitle) && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {event.economy && (
                          <span className="px-1.5 py-0.2 rounded text-[9px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                            💰 {event.economy.asset} {event.economy.price || ''}
                          </span>
                        )}
                        {event.policeIncident && (
                          <span className={`px-1.5 py-0.2 rounded text-[9px] font-semibold border ${
                            event.policeIncident.outcome === 'escaped' ? 'bg-blue-500/15 text-blue-300 border-blue-500/30' : 'bg-rose-500/15 text-rose-300 border-rose-500/30'
                          }`}>
                            🚨 {event.policeIncident.outcome === 'escaped' ? 'Escaped' : event.policeIncident.outcome}
                          </span>
                        )}
                        {event.arcTitle && (
                          <span className="px-1.5 py-0.2 rounded text-[9px] font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/30">
                            ⚡ {event.arcTitle}
                          </span>
                        )}
                        {(() => {
                          const squad = getBrickBoysSquad(event.participants);
                          if (!squad) return null;
                          return (
                            <span className={`px-1.5 py-0.2 rounded text-[9px] font-semibold border flex items-center gap-1 ${squad.badgeClass}`}>
                              <Users className="w-2.5 h-2.5" />
                              <span>{squad.shortLabel}: {squad.comboLabel}</span>
                            </span>
                          );
                        })()}
                      </div>
                    )}
                  </div>

                  {/* Overlay Footer: Always pinned and shrink-0 */}
                  <div className="shrink-0 flex flex-col gap-1.5 pt-1.5 border-t border-white/[0.08] mt-1">
                    {event.crossPov && (
                      <div className="flex items-center justify-between gap-1 text-[10px]">
                        <span className="text-zinc-400 truncate">Also in {event.crossPov.streamer}'s stream:</span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSwitchPov?.(event.crossPov.pov, event.crossPov.day, event.crossPov.eventId);
                          }}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/30 transition-all cursor-pointer shadow-sm shrink-0"
                          title={`Watch ${event.crossPov.streamer}'s version of this moment`}
                        >
                          <Eye className="w-3 h-3 text-rose-400" />
                          <span>Switch</span>
                          <span className="font-mono text-[9px] opacity-75">({event.crossPov.timestamp})</span>
                        </button>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] sm:text-[11px] text-zinc-500 font-mono">
                        Jump to VOD:
                      </span>

                      <div className="flex items-center gap-1.5">
                        {(event.twitchUrl || activePov?.twitchChannel) && (
                          <a
                            href={event.twitchUrl || activePov.twitchChannel}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="p-1.5 rounded-md bg-[#9146ff] hover:bg-[#772ce8] text-white transition-colors shadow-sm flex items-center justify-center cursor-pointer"
                            title={`Jump to ${event.timestamp} on Twitch`}
                          >
                            <TwitchIcon className="w-3.5 h-3.5 fill-current" />
                          </a>
                        )}

                        {event.kickUrl && event.kickUrl.includes('/videos/') && (
                          isMobile ? (
                            <button
                              onClick={(e) => handleMobileKickPlay(e, event)}
                              className="p-1.5 rounded-md bg-[#53fc18]/15 hover:bg-[#53fc18]/25 text-[#53fc18] border border-[#53fc18]/30 transition-colors flex items-center justify-center cursor-pointer"
                              title={`Play in browser @ ${event.timestamp}`}
                            >
                              <KickIcon className="w-3.5 h-3.5 fill-current" />
                            </button>
                          ) : (
                            <a
                              href={event.kickUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="p-1.5 rounded-md bg-[#53fc18]/15 hover:bg-[#53fc18]/25 text-[#53fc18] border border-[#53fc18]/30 transition-colors flex items-center justify-center cursor-pointer"
                              title={`Jump to ${event.timestamp} on Kick`}
                            >
                              <KickIcon className="w-3.5 h-3.5 fill-current" />
                            </a>
                          )
                        )}

                        {event.youtubeUrl && (
                          <a
                            href={event.youtubeUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="p-1.5 rounded-md bg-[#ff0000] hover:bg-[#cc0000] text-white transition-colors shadow-sm flex items-center justify-center cursor-pointer"
                            title={`Jump to ${event.timestamp} on YouTube`}
                          >
                            <YouTubeIcon className="w-3.5 h-3.5 fill-current" />
                          </a>
                        )}

                        {(event.redditUrl || event.communityUrl) && (
                          <a
                            href={event.redditUrl || event.communityUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="p-1.5 rounded-md bg-[#ff4500]/15 hover:bg-[#ff4500]/25 text-[#ff4500] border border-[#ff4500]/30 transition-colors flex items-center justify-center cursor-pointer"
                            title="View community discussion on Reddit"
                          >
                            <RedditIcon className="w-3.5 h-3.5 fill-current" />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Big One-Column Card Modal (when clicked in multi-column view) */}
      {focusedEvent && (
        <div 
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 animate-fadeIn"
          onClick={() => setFocusedEvent(null)}
        >
          <div 
            className="relative max-w-4xl w-full bg-zinc-950 rounded-2xl border border-white/[0.12] overflow-hidden shadow-2xl flex flex-col max-h-[92vh]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-4 py-3 bg-zinc-900/90 border-b border-white/[0.08] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1 px-2.5 py-1 rounded bg-black/60 text-zinc-200 border border-white/10 text-xs font-mono tabular-nums font-semibold">
                  <Clock className="w-3.5 h-3.5 text-zinc-400" />
                  <span>{focusedEvent.timestamp}</span>
                  {eventEndSeconds(focusedEvent, filteredEvents) > (Number(focusedEvent.seconds) || 0) && (
                    <span className="text-zinc-400">– {fmtClock(eventEndSeconds(focusedEvent, filteredEvents))}</span>
                  )}
                </span>
                {focusedEvent.isMajor && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/40 text-[10px] font-semibold tracking-wide uppercase">
                    <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                    <span>Major Highlight</span>
                  </span>
                )}
                {(focusedEvent.tags || [focusedEvent.category]).map(tag => (
                  <span
                    key={tag}
                    className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-black/60 border border-white/10 text-[10px] font-medium text-zinc-300"
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${CATEGORY_CONFIG[tag]?.dotColor || 'bg-zinc-400'}`}></span>
                    <span>{CATEGORY_CONFIG[tag]?.label || tag}</span>
                  </span>
                ))}
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => toggleBookmark(focusedEvent.id)}
                  className={`p-1.5 rounded-md border transition-colors cursor-pointer ${
                    bookmarks.includes(focusedEvent.id)
                      ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                      : 'bg-zinc-800 border-white/10 text-zinc-400 hover:text-white'
                  }`}
                  title="Bookmark"
                >
                  <Bookmark className={`w-4 h-4 ${bookmarks.includes(focusedEvent.id) ? 'fill-amber-400' : ''}`} />
                </button>
                <button
                  onClick={() => copyEventLink(focusedEvent)}
                  className="p-1.5 rounded-md bg-zinc-800 border border-white/10 text-zinc-400 hover:text-white transition-colors cursor-pointer"
                  title="Copy direct link"
                >
                  {copiedId === focusedEvent.id ? <Check className="w-4 h-4 text-emerald-400" /> : <Share2 className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => setFocusedEvent(null)}
                  className="p-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-white transition-colors cursor-pointer ml-1"
                  title="Close (Esc)"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Large 16:9 Screenshot or In-App Kick Player */}
            {isPlayingKick && activeKickStream ? (
              <KickPlayer
                streamUrl={activeKickStream}
                seconds={focusedEvent.seconds}
                timestamp={focusedEvent.timestamp}
                kickUrl={focusedEvent.kickUrl}
                activeStreamer={activePov?.name || activePov?.character || 'Current POV'}
                crossPovs={focusedCrossPovs}
                onClose={() => setIsPlayingKick(false)}
              />
            ) : (
              <div className="relative aspect-video w-full bg-black overflow-hidden select-none group/img">
                <img
                  src={focusedEvent.image || '/images/placeholder.svg'}
                  alt={focusedEvent.description}
                  className="w-full h-full object-contain"
                />
                {capturingFrame && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/55 text-xs text-zinc-200 font-medium">
                    Capturing screenshot…
                  </div>
                )}

                {/* Prev / Next Navigation Buttons */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePrevFocused();
                  }}
                  className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 hover:bg-black/80 text-white backdrop-blur-md border border-white/10 transition-all opacity-80 hover:opacity-100 cursor-pointer z-20"
                  title="Previous moment (←)"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleNextFocused();
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-black/60 hover:bg-black/80 text-white backdrop-blur-md border border-white/10 transition-all opacity-80 hover:opacity-100 cursor-pointer z-20"
                  title="Next moment (→)"
                >
                  <ChevronRight className="w-5 h-5" />
                </button>
              </div>
            )}

            {/* Bottom Card Content: Description + Characters + VOD Jump */}
            <div className="p-4 sm:p-5 bg-zinc-950 space-y-3 border-t border-white/[0.08]">
              <p className="text-zinc-100 text-sm sm:text-base leading-relaxed font-medium">
                {compactDescription(focusedEvent.description, 180)}
              </p>
              {focusedEvent.evidence && (
                <div className="px-3 py-2 rounded-lg bg-emerald-500/[0.07] border border-emerald-500/20 text-xs text-emerald-200/90">
                  <span className="font-semibold text-emerald-300">Transcript evidence:</span> “{focusedEvent.evidence}”
                </div>
              )}

              {focusedEvent.participants?.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <span className="text-[11px] text-zinc-500 font-medium">In this scene:</span>
                  {focusedEvent.participants.map((p) => (
                    <button
                      key={p}
                      onClick={() => onSelectCharacter?.(p)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-zinc-800/90 hover:bg-amber-500/20 text-zinc-200 hover:text-amber-300 border border-white/10 hover:border-amber-500/30 transition-colors cursor-pointer shadow-sm"
                      title={`View ${p} dossier and moments`}
                    >
                      <span>@{p}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Story Arc in Modal */}
              {focusedEvent.arcTitle && (
                <div className="flex items-center gap-2 text-xs text-purple-300 bg-purple-500/10 border border-purple-500/25 px-3 py-1.5 rounded-lg">
                  <span>⚡ Part of Storyline:</span>
                  <span className="font-semibold text-white">{focusedEvent.arcTitle}</span>
                </div>
              )}

              {/* Squad Formation in Modal */}
              {(() => {
                const focusedSquad = getBrickBoysSquad(focusedEvent.participants);
                if (!focusedSquad) return null;
                return (
                  <div className={`flex items-center justify-between text-xs px-3 py-1.5 rounded-lg border ${focusedSquad.badgeClass}`}>
                    <div className="flex items-center gap-2">
                      <Users className="w-3.5 h-3.5" />
                      <span>Brick Boys: <strong className="text-white">{focusedSquad.label}</strong></span>
                    </div>
                    <span className="font-mono text-[10px] opacity-80">{focusedSquad.comboLabel}</span>
                  </div>
                );
              })()}

              {/* Economy Details in Modal */}
              {focusedEvent.economy && (
                <div className="p-3 rounded-xl bg-emerald-500/[0.07] border border-emerald-500/20 text-xs text-zinc-300 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-base">💰</span>
                    <div>
                      <span className="font-semibold text-emerald-300">{focusedEvent.economy.asset}</span>
                      {focusedEvent.economy.price && <span className="ml-1.5 font-mono text-zinc-300">Price: {focusedEvent.economy.price}</span>}
                      {focusedEvent.economy.amount && <span className="ml-1.5 font-mono text-zinc-400">Total: {focusedEvent.economy.amount}</span>}
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${
                    focusedEvent.economy.verification === 'screen-verified'
                      ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30'
                      : 'bg-zinc-800 text-zinc-400 border-white/10'
                  }`}>
                    {focusedEvent.economy.verification === 'screen-verified' ? '✓ Screen Verified (On-Screen UI)' : 'Spoken Claim (Audio)'}
                  </span>
                </div>
              )}

              {/* Police Incident Details in Modal */}
              {focusedEvent.policeIncident && (
                <div className="p-3 rounded-xl bg-blue-500/[0.07] border border-blue-500/20 text-xs text-zinc-300 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-base">🚨</span>
                    <div>
                      <span className="font-semibold text-blue-300">
                        Police Incident: {focusedEvent.policeIncident.outcome === 'escaped' ? 'Pursuit Escaped' : focusedEvent.policeIncident.outcome}
                      </span>
                      {focusedEvent.policeIncident.charges?.length > 0 && (
                        <div className="text-[11px] text-zinc-400 mt-0.5">
                          Charges: {focusedEvent.policeIncident.charges.join(', ')}
                        </div>
                      )}
                    </div>
                  </div>
                  {focusedEvent.policeIncident.officers?.length > 0 && (
                    <span className="text-[10px] font-mono text-zinc-400">
                      Officers: {focusedEvent.policeIncident.officers.join(', ')}
                    </span>
                  )}
                </div>
              )}

              {/* Cross-POV Banner */}
              {focusedEvent.crossPov && (
                <div className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30">
                  <div className="flex items-center gap-2">
                    <ArrowRightLeft className="w-4 h-4 text-rose-400 shrink-0" />
                    <div>
                      <div className="text-xs font-semibold text-rose-300">
                        Cross-POV Available: {focusedEvent.crossPov.streamer}
                      </div>
                      <div className="text-[11px] text-zinc-400">
                        {focusedEvent.crossPov.title || 'Matching moment in other perspective'}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      const cp = focusedEvent.crossPov;
                      setFocusedEvent(null);
                      onSwitchPov?.(cp.pov, cp.day, cp.eventId);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold bg-rose-500 hover:bg-rose-600 text-white transition-all cursor-pointer shadow-md shrink-0"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>Watch {focusedEvent.crossPov.streamer} POV</span>
                    <span className="font-mono text-[10px] opacity-80">({focusedEvent.crossPov.timestamp})</span>
                  </button>
                </div>
              )}

              {/* Community Reddit Discussion Section */}
              <div className="space-y-2 pt-1">
                {focusedEvent.redditUrl ? (
                  <div className="flex items-center justify-between p-2.5 rounded-lg bg-[#ff4500]/10 border border-[#ff4500]/25 text-xs text-zinc-300">
                    <div className="flex items-center gap-2 min-w-0">
                      <RedditIcon className="w-4 h-4 text-[#ff4500] shrink-0 fill-current" />
                      <span className="truncate">{focusedEvent.redditTitle || 'Community Discussion Thread'}</span>
                    </div>
                    <a
                      href={focusedEvent.redditUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#ff4500] hover:underline shrink-0 ml-2"
                    >
                      <span>Open on Reddit</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-zinc-400 font-medium">Community Context:</span>
                      <button
                        onClick={handleSearchCommunity}
                        disabled={isSearchingCommunity}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-white/10 hover:border-zinc-700 transition-colors cursor-pointer disabled:opacity-50"
                      >
                        <RedditIcon className="w-3 h-3 text-[#ff4500] fill-current" />
                        <span>{isSearchingCommunity ? 'Searching Reddit…' : 'Find Reddit Threads'}</span>
                      </button>
                    </div>

                    {communitySearched && communityThreads.length > 0 && (
                      <div className="space-y-1.5 pt-1">
                        {communityThreads.slice(0, 3).map(thread => (
                          <a
                            key={thread.id || thread.permalink}
                            href={thread.permalink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center justify-between p-2 rounded-md bg-zinc-900/80 hover:bg-zinc-800/80 border border-white/[0.08] text-xs text-zinc-200 transition-colors group"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <RedditIcon className="w-3.5 h-3.5 text-[#ff4500] shrink-0 fill-current" />
                              <span className="truncate group-hover:text-amber-300 transition-colors">{thread.title}</span>
                              <span className="text-[10px] text-zinc-500 shrink-0 font-mono">r/{thread.subreddit}</span>
                            </div>
                            <ExternalLink className="w-3 h-3 text-zinc-500 group-hover:text-zinc-300 shrink-0 ml-2" />
                          </a>
                        ))}
                      </div>
                    )}

                    {communitySearched && !isSearchingCommunity && communityThreads.length === 0 && (
                      <p className="text-[11px] text-zinc-500 italic">
                        No indexed Reddit threads found for this moment yet. Configure a search API key in .env to expand discovery.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Footer: Jump to VOD buttons & Switch to Feed button */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-white/[0.08]">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-400 font-mono">
                    Jump to VOD:
                  </span>
                  {/* Twitch VOD jump */}
                  {(focusedEvent.twitchUrl || activePov?.twitchChannel) && (
                    <a
                      href={focusedEvent.twitchUrl || activePov.twitchChannel}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 rounded-md bg-[#9146ff] hover:bg-[#772ce8] text-white transition-colors shadow-sm flex items-center justify-center cursor-pointer"
                      title={`Jump to ${focusedEvent.timestamp} on Twitch`}
                    >
                      <TwitchIcon className="w-3.5 h-3.5 fill-current" />
                    </a>
                  )}

                  {focusedEvent.kickUrl && focusedEvent.kickUrl.includes('/videos/') && (
                    isMobile ? (
                      /* Mobile: Play in browser button + external link icon */
                      <>
                        <button
                          onClick={() => setIsPlayingKick(!isPlayingKick)}
                          className={`px-3 py-1.5 rounded-md border text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${kickBtnClass}`}
                          title={isPlayingKick ? "Close player" : `Play stream in browser @ ${focusedEvent.timestamp}`}
                        >
                          <KickIcon className="w-3.5 h-3.5 fill-current" />
                          <span>{isPlayingKick ? 'Close player' : 'Play in browser'}</span>
                        </button>
                        <a
                          href={focusedEvent.kickUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 rounded-md bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-white/10 transition-colors flex items-center justify-center cursor-pointer"
                          title="Open in Kick app/website"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </>
                    ) : (
                      /* Desktop: Clean icon-only Kick button linking directly to Kick */
                      <a
                        href={focusedEvent.kickUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded-md bg-[#53fc18]/15 hover:bg-[#53fc18]/25 text-[#53fc18] border border-[#53fc18]/30 transition-colors flex items-center justify-center cursor-pointer"
                        title={`Jump to ${focusedEvent.timestamp} on Kick`}
                      >
                        <KickIcon className="w-3.5 h-3.5 fill-current" />
                      </a>
                    )
                  )}

                  {focusedEvent.youtubeUrl && (
                    <a
                      href={focusedEvent.youtubeUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 rounded-md bg-[#ff0000] hover:bg-[#cc0000] text-white transition-colors shadow-sm flex items-center justify-center cursor-pointer"
                      title={`Jump to ${focusedEvent.timestamp} on YouTube`}
                    >
                      <YouTubeIcon className="w-3.5 h-3.5 fill-current" />
                    </a>
                  )}

                  {(focusedEvent.redditUrl || focusedEvent.communityUrl) && (
                    <a
                      href={focusedEvent.redditUrl || focusedEvent.communityUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="p-1.5 rounded-md bg-[#ff4500]/15 hover:bg-[#ff4500]/25 text-[#ff4500] border border-[#ff4500]/30 transition-colors flex items-center justify-center cursor-pointer"
                      title="View community discussion on Reddit"
                    >
                      <RedditIcon className="w-3.5 h-3.5 fill-current" />
                    </a>
                  )}
                </div>

                {/* Switch to single column view button */}
                <button
                  onClick={() => {
                    setLayoutMode('feed');
                    const targetId = focusedEvent.id;
                    setFocusedEvent(null);
                    setTimeout(() => {
                      const el = document.querySelector(`#${targetId}`);
                      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }, 100);
                  }}
                  className="text-xs text-zinc-400 hover:text-zinc-200 underline font-medium transition-colors cursor-pointer"
                >
                  Switch to single column feed
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Quick Toast Popup when Share Link or Kick Timestamp is Copied */}
      <div
        className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 transition-all duration-300 pointer-events-none ${
          copiedToast ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-2 scale-95'
        }`}
      >
        <div className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-zinc-900/95 text-zinc-100 border border-white/15 shadow-2xl backdrop-blur-md text-xs font-medium max-w-[90vw] text-center">
          <div className="w-4 h-4 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
            <Check className="w-2.5 h-2.5 stroke-[2.5]" />
          </div>
          <span className="truncate sm:whitespace-normal">{toastText || 'timestamp link copied'}</span>
        </div>
      </div>
    </div>
  );
}
