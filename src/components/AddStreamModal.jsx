import { useState, useRef } from 'react';
import { X, Sparkles, UserRound, FileText, Loader2, CheckCircle2, AlertCircle, ArrowRight, Wand2, Plus, Check, Play } from 'lucide-react';
import { TwitchIcon, KickIcon, YouTubeIcon } from './Icons';
import { ownerFetch } from '../lib/owner.js';

const PROGRESS_STEPS = [
  'Fetching stream metadata & chapters',
  'AI is writing the recap moments…',
  'Saving timeline & switching view'
];

function platformLabel(p) {
  return p === 'twitch' ? 'Twitch' : p === 'kick' ? 'Kick' : p === 'youtube' ? 'YouTube' : p;
}

function formatDuration(secs) {
  const s = Math.max(0, Math.floor(Number(secs) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

export default function AddStreamModal({ isOpen, onClose, onStreamAdded }) {
  const [mode, setMode] = useState('channel'); // 'channel' | 'notes'
  const [urlInput, setUrlInput] = useState('');
  const [notesInput, setNotesInput] = useState('');
  const [streamerName, setStreamerName] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [resolved, setResolved] = useState(null); // { displayName, platforms, latest }
  const [resolving, setResolving] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [status, setStatus] = useState('idle'); // 'idle', 'submitting', 'success', 'error'
  const [errorMessage, setErrorMessage] = useState('');
  const [progressStep, setProgressStep] = useState(0);
  const [backgroundPending, setBackgroundPending] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedVodId, setSelectedVodId] = useState(null);
  const [focusCriteria, setFocusCriteria] = useState('');
  const [focusMode, setFocusMode] = useState('discovery');
  const [profileId, setProfileId] = useState('generic');
  const resolveTimer = useRef(null);
  const suggestTimer = useRef(null);

  const formatDay = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  if (!isOpen) return null;

  // ---- Channel name autocomplete (registry + live resolve) ----
  const loadSuggestions = (q) => {
    fetch(`/api/channels?q=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(d => { if (d.suggestions) setSuggestions(d.suggestions); })
      .catch(() => {});
  };

  const resolveChannel = (name) => {
    const q = String(name || '').trim().replace(/^@/, '');
    if (!q) { setResolved(null); return; }
    setResolving(true);
    fetch(`/api/channel/resolve?name=${encodeURIComponent(q)}`)
      .then(r => r.json())
      .then(d => { setResolved(d); setResolving(false); })
      .catch(() => { setResolved(null); setResolving(false); });
  };

  const handleNameChange = (val) => {
    setStreamerName(val);
    setResolved(null);
    const v = val.trim();
    setShowSuggestions(v.length >= 1);
    clearTimeout(suggestTimer.current);
    clearTimeout(resolveTimer.current);
    if (v.length >= 1) {
      suggestTimer.current = setTimeout(() => loadSuggestions(v), 150);
    }
    if (v.length >= 3) {
      resolveTimer.current = setTimeout(() => resolveChannel(v), 500);
    }
  };

  const platformBadge = (p) => {
    if (p === 'twitch') return <TwitchIcon className="w-3 h-3" />;
    if (p === 'kick') return <KickIcon className="w-3 h-3" />;
    if (p === 'youtube') return <YouTubeIcon className="w-3 h-3" />;
    return null;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const name = streamerName.trim();
    const payload = { name };

    if (mode === 'channel') {
      // Channel name is the primary path; a VOD URL is an optional refinement.
      if (!name && !urlInput.trim()) {
        setErrorMessage('Type a channel name (e.g. xqc) or paste a VOD URL.');
        return;
      }
      if (urlInput.trim()) {
        payload.url = urlInput.trim();
      } else if (resolved?.recentVods?.length) {
        const pick = selectedVodId ?? resolved.recentVods[0]?.id;
        if (pick) payload.vodId = pick;
      }
    } else {
      payload.notes = notesInput.trim();
      if (!payload.notes) {
        setErrorMessage('Paste a chat log, chapter list, or brief notes so the AI can write the recap.');
        return;
      }
    }
    if (name) payload.name = name.replace(/^@/, '');
    if (batchMode) payload.batch = true;
    if (focusCriteria.trim()) {
      payload.filters = {
        criteria: focusCriteria.trim(),
        mode: focusMode
      };
    }
    if (profileId !== 'generic') payload.profile = profileId;

    setStatus('submitting');
    setErrorMessage('');
    setProgressStep(1);

    try {
      setTimeout(() => setProgressStep(2), 700);
      setTimeout(() => setProgressStep(3), 2000);

      const res = await ownerFetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const responseText = await res.text();
      let json;
      try {
        json = JSON.parse(responseText);
      } catch {
        throw new Error('The server timed out or returned an invalid response. Long Twitch/Kick VODs may need background processing.');
      }
      if (!res.ok || !json.ok) {
        throw new Error(json.error || 'Failed to generate recap');
      }

      setProgressStep(3);
      setBackgroundPending(Boolean(json.transcriptionPending));
      setBatchMode(false);
      setTimeout(() => setProgressStep(0), 300);
      setStatus('success');
      setTimeout(() => {
        onStreamAdded?.(json.streamId, json);
        onClose();
      }, 1400);
    } catch (err) {
      setStatus('error');
      setErrorMessage(err.message || 'An error occurred while generating the recap.');
    }
  };

  const reset = () => {
    setMode('channel');
    setUrlInput('');
    setNotesInput('');
    setStreamerName('');
    setSuggestions([]);
    setResolved(null);
    setResolving(false);
    setShowSuggestions(false);
    setStatus('idle');
    setErrorMessage('');
    setProgressStep(0);
    setBackgroundPending(false);
    setBatchMode(false);
    setSelectedVodId(null);
    setFocusCriteria('');
    setFocusMode('discovery');
    setProfileId('generic');
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fadeIn"
      onClick={() => { onClose(); reset(); }}
    >
      <div
        className="relative max-w-lg w-full bg-zinc-950 rounded-2xl border border-white/[0.12] overflow-hidden shadow-2xl p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.08] pb-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-zinc-100 text-base">Generate AI Recap</h3>
              <p className="text-xs text-zinc-400">Any stream, any platform — get a timestamped recap</p>
            </div>
          </div>
          <button
            onClick={() => { onClose(); reset(); }}
            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {status === 'success' ? (
          <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs flex items-center gap-2.5 font-semibold">
            <CheckCircle2 className="w-5 h-5 shrink-0" />
            <span>{backgroundPending ? (batchMode ? 'Recap draft ready - transcript is processing overnight in batch mode (up to 24h). It will upgrade itself when ready.' : 'Recap created. Long-VOD transcription is continuing in the background…') : 'Recap generated! Switching to the new timeline…'}</span>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Source Mode Toggle */}
            <div className="flex items-center bg-zinc-900 rounded-lg p-1 border border-white/[0.08] gap-1">
              <button
                type="button"
                onClick={() => setMode('channel')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  mode === 'channel' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <UserRound className="w-3.5 h-3.5" /> Channel name
              </button>
              <button
                type="button"
                onClick={() => setMode('notes')}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                  mode === 'notes' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <FileText className="w-3.5 h-3.5" /> Notes / Chat Log
              </button>
            </div>

            {mode === 'channel' ? (
              <>
                {/* Channel name (primary — autocompleted, no URL needed) */}
                <div className="space-y-1.5 relative">
                  <label className="text-xs font-semibold text-zinc-300">Channel / streamer name</label>
                  <div className="relative">
                    <input
                      type="text"
                      placeholder="e.g. xqc, buddha, roflgator, omie…"
                      value={streamerName}
                      onChange={(e) => handleNameChange(e.target.value)}
                      onFocus={() => setShowSuggestions(true)}
                      onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                      autoComplete="off"
                      className="w-full px-3.5 py-2.5 pr-5 rounded-xl bg-zinc-900 border border-white/10 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/60 transition-colors"
                    />
                    {resolving && (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-400 absolute right-3 top-1/2 -translate-y-1/2" />
                    )}
                  </div>

                  {/* Autocomplete suggestions */}
                  {showSuggestions && suggestions.length > 0 && (
                    <div className="absolute z-20 left-0 right-0 top-full mt-1 rounded-xl bg-zinc-900 border border-white/10 shadow-2xl overflow-hidden max-h-56 overflow-y-auto">
                      {suggestions.map((s) => (
                        <button
                          key={s.name}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setStreamerName(s.name);
                            setSuggestions([]);
                            setShowSuggestions(false);
                            resolveChannel(s.name);
                          }}
                          className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 text-left hover:bg-zinc-800/70 transition-colors cursor-pointer"
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            <span className="w-6 h-6 rounded-full bg-zinc-800 border border-white/10 flex items-center justify-center text-[9px] font-bold text-zinc-300 shrink-0">
                              {(s.displayName || s.name).charAt(0).toUpperCase()}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-xs text-zinc-100 font-medium truncate">{s.displayName || s.name}</span>
                              <span className="block text-[10px] text-zinc-500">@{s.name}</span>
                            </span>
                          </span>
                          <span className="flex items-center gap-1 shrink-0">
                            {(s.platforms || []).map(p => <span key={p}>{platformBadge(p)}</span>)}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Resolved status line */}
                  {resolving ? (
                    <p className="text-[11px] text-zinc-500">Looking up channel…</p>
                  ) : resolved && resolved.platforms && resolved.platforms.length > 0 ? (
                    <p className="text-[11px] text-emerald-400/90 flex items-center gap-1">
                      <Check className="w-3 h-3" />
                      <span className="font-medium">Found: {resolved.displayName}</span>
                      <span className="text-zinc-500">({resolved.platforms.map(p => platformLabel(p)).join(', ')})</span>
                    </p>
                  ) : resolved && resolved.platforms && resolved.platforms.length === 0 ? (
                    <p className="text-[11px] text-amber-400/90">No channel found with that exact name — check spelling or use a VOD link / notes.</p>
                  ) : null}

                  {/* VOD picker (Twitch last ~6) — or latest-broadcast hint for other platforms */}
                  {resolved?.recentVods?.length ? (
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-zinc-300">
                        Pick a VOD to recap <span className="text-zinc-500 font-normal">(newest is default)</span>
                      </label>
                      <div className="max-h-44 overflow-y-auto rounded-xl border border-white/[0.08] bg-zinc-900/40 divide-y divide-white/[0.04]">
                        {resolved.recentVods.map((v) => {
                          const chosen = (selectedVodId ?? resolved.recentVods[0]?.id) === v.id;
                          return (
                            <button
                              key={v.id}
                              type="button"
                              onClick={() => { setSelectedVodId(v.id); setUrlInput(''); }}
                              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors cursor-pointer ${chosen ? 'bg-amber-500/10' : 'hover:bg-zinc-800/50'}`}
                            >
                              <span className={`w-2 h-2 rounded-full shrink-0 ${chosen ? 'bg-amber-400' : 'bg-zinc-600'}`} />
                              <span className="min-w-0 flex-1">
                                <span className="block text-[11px] leading-tight text-zinc-100 truncate font-medium">{v.title || 'Broadcast'}</span>
                                <span className="block text-[10px] text-zinc-500 mt-0.5">{formatDay(v.createdAt)}{v.lengthSeconds ? ` · ${formatDuration(v.lengthSeconds)}` : ''}</span>
                              </span>
                              {chosen && <Check className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : resolved?.latest ? (
                    <p className="text-[11px] text-zinc-400 flex items-center gap-1.5">
                      <Play className="w-3 h-3 text-emerald-400 shrink-0" />
                      <span className="truncate">Latest broadcast: “{String(resolved.latest.title || 'broadcast').slice(0, 60)}”</span>
                      {resolved.latest.lengthSeconds ? (
                        <span className="shrink-0 font-mono tabular-nums">({formatDuration(resolved.latest.lengthSeconds)})</span>
                      ) : null}
                    </p>
                  ) : null}
                </div>

                {/* Optional VOD link refinement */}
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-zinc-300">
                    VOD link <span className="text-zinc-500 font-normal">(optional — overrides the picker above)</span>
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. https://twitch.tv/videos/1234567890"
                    value={urlInput}
                    onChange={(e) => { setUrlInput(e.target.value); if (e.target.value.trim()) setSelectedVodId(null); }}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-white/10 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/60 transition-colors"
                  />
                </div>

                {/* Per-generation focus criteria */}
                <div className="space-y-1.5 p-3 rounded-xl bg-zinc-900/50 border border-white/[0.08]">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-semibold text-zinc-300">Domain profile</label>
                    <select
                      value={profileId}
                      onChange={(e) => setProfileId(e.target.value)}
                      className="px-2 py-1 rounded-md bg-zinc-900 border border-white/10 text-[10px] text-zinc-300"
                    >
                      <option value="generic">Generic stream</option>
                      <option value="nopixel">NoPixel roleplay (General)</option>
                      <option value="brickbois">Brick Bois (Marty & Crew Focus)</option>
                    </select>
                  </div>
                  <label className="text-xs font-semibold text-zinc-300">Fine-tune this recap <span className="text-zinc-500 font-normal">(optional)</span></label>
                  <textarea
                    rows={2}
                    value={focusCriteria}
                    onChange={(e) => setFocusCriteria(e.target.value)}
                    placeholder="e.g. only moments involving Abdul, lemons, or the server launch"
                    className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-white/10 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/60 transition-colors resize-y"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] text-zinc-500">Text and visual focus instructions are attached only to this generation.</p>
                    <select
                      value={focusMode}
                      onChange={(e) => setFocusMode(e.target.value)}
                      disabled={!focusCriteria.trim()}
                      className="shrink-0 px-2 py-1 rounded-md bg-zinc-900 border border-white/10 text-[10px] text-zinc-300 disabled:opacity-40"
                    >
                      <option value="discovery">Discovery</option>
                      <option value="strict">Strict filter</option>
                    </select>
                  </div>
                </div>

                {/* Overnight batch mode (half price) — only meaningful once a Twitch/Kick VOD is resolved */}
                {resolved?.latest && (resolved.latest.platform === 'twitch' || resolved.latest.platform === 'kick') && (
                  <label className="flex items-start gap-2.5 p-3 rounded-xl bg-zinc-900/60 border border-white/[0.08] cursor-pointer transition-colors hover:border-amber-500/30">
                    <input
                      type="checkbox"
                      checked={batchMode}
                      onChange={(e) => setBatchMode(e.target.checked)}
                      className="mt-0.5 accent-amber-500 w-3.5 h-3.5"
                    />
                    <span className="space-y-0.5">
                      <span className="block text-xs font-semibold text-zinc-200">Overnight batch mode (half price)</span>
                      <span className="block text-[10px] text-zinc-500 leading-relaxed">Transcribe via Groq's batch API at 50% off — the recap draft appears now, but transcript-backed moments arrive in up to 24h.</span>
                    </span>
                  </label>
                )}
              </>
            ) : (
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-300">Chat log, chapter list, or recap notes</label>
                <textarea
                  rows={5}
                  placeholder={'Paste timestamps, chat highlights, or any recap notes:\n\n00:12 intro & setup\n00:45 first clutch…'}
                  value={notesInput}
                  onChange={(e) => setNotesInput(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-white/10 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/60 transition-colors resize-y font-mono"
                />
                <p className="text-[11px] text-zinc-500">Optionally also type the channel name above to name the stream.</p>
              </div>
            )}

            {/* Streamer name (used when Notes mode) */}
            {mode !== 'channel' && (
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-zinc-300">
                  Streamer / channel name <span className="text-zinc-500 font-normal">(optional)</span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. Buddha, Omie, AnthonyZ"
                  value={streamerName}
                  onChange={(e) => setStreamerName(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-white/10 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/60 transition-colors"
                />
              </div>
            )}

            {/* Progress / Status Display */}
            {status === 'submitting' && (
              <div className="p-3.5 rounded-xl bg-zinc-900/80 border border-white/[0.08] space-y-2 text-xs">
                <div className="flex items-center gap-2 text-amber-400 font-semibold">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Generating recap…</span>
                </div>
                <ul className="space-y-1 text-zinc-400 pl-6 list-disc">
                  {PROGRESS_STEPS.map((label, i) => (
                    <li key={label} className={progressStep >= i + 1 ? 'text-zinc-200 font-medium' : 'opacity-40'}>
                      {label}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {status === 'error' && (
              <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              disabled={status === 'submitting'}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-bold text-xs tracking-wide uppercase transition-all shadow-lg hover:shadow-amber-500/20 disabled:opacity-50 cursor-pointer flex items-center justify-center gap-2"
            >
              <Wand2 className="w-4 h-4" />
              <span>{mode === 'channel' ? 'Generate AI Recap' : 'Write Recap from Notes'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>
        )}

        {/* Footer hint */}
        <div className="pt-3 border-t border-white/[0.08] flex items-center justify-between text-[11px] text-zinc-500">
          <span className="flex items-center gap-1">
            <Plus className="w-3 h-3 text-amber-400" />
            <span>New streams are added automatically</span>
          </span>
          <span className="flex items-center gap-1 text-zinc-500">
            <TwitchIcon className="w-3 h-3" />
            <KickIcon className="w-3 h-3" />
            <YouTubeIcon className="w-3 h-3" />
          </span>
        </div>
      </div>
    </div>
  );
}