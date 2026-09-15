import { useState, useEffect } from 'react';
import recapData from './data/recapData.json';
import initialXqcDays from './data/daysData.json';
import initialBuddhaDays from './data/buddhaDaysData.json';
import initialPovConfig from './data/povConfig.json';
import Navbar from './components/Navbar.jsx';
import HomeView from './components/HomeView.jsx';
import TimelineView from './components/TimelineView.jsx';
import AddStreamModal from './components/AddStreamModal.jsx';
import UnlockModal from './components/UnlockModal.jsx';
import CharacterModal from './components/CharacterModal.jsx';
import CalendarPicker from './components/CalendarPicker.jsx';
import { getOwnerKey, setOwnerKey, ownerFetch } from './lib/owner.js';
import { ArrowUp, ArrowDown, ChevronDown, AlertTriangle, Trash2, X } from 'lucide-react';
import { Analytics } from '@vercel/analytics/react';

export default function App() {
  const [povConfig, setPovConfig] = useState(initialPovConfig);
  // null = Home (library), otherwise the stream id being viewed.
  const [activeStreamId, setActiveStreamId] = useState(null);
  const [library, setLibrary] = useState([]);
  const [currentPov, setCurrentPov] = useState(() => {
    try {
      const saved = localStorage.getItem('sr_active_pov');
      if (saved && initialPovConfig.povs.some(p => p.id === saved)) {
        return saved;
      }
    } catch {}
    return initialPovConfig.defaultPov || 'xqc';
  });

  const [povDaysMap, setPovDaysMap] = useState({
    xqc: initialXqcDays.days || {},
    buddha: initialBuddhaDays.days || {}
  });

  const days = povDaysMap[currentPov] || {};
  const [selectedDay, setSelectedDay] = useState('1');
  const [searchQuery, setSearchQuery] = useState('');
  const [showOnlyBookmarks, setShowOnlyBookmarks] = useState(false);
  const [showAddStream, setShowAddStream] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState('idle');
  const [transcriptionJob, setTranscriptionJob] = useState(null);
  const [transcriptionJobs, setTranscriptionJobs] = useState([]);
  const [selectedCharacter, setSelectedCharacter] = useState(null);

  // Guest vs owner. Site is browse-only by default; the owner key (stored in
  // localStorage via ?key=... or the unlock dialog) reveals the editing UI.
  const [isOwner, setIsOwner] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);

  useEffect(() => {
    let key = getOwnerKey();
    const params = new URLSearchParams(window.location.search);
    const urlKey = params.get('key');
    if (urlKey) {
      key = urlKey;
      setOwnerKey(key);
      // Strip the key from the URL so it doesn't linger in history/screenshots.
      params.delete('key');
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
    }
    fetch(`/api/auth/check?key=${encodeURIComponent(key)}`)
      .then(r => r.json())
      .then(d => { if (d?.owner) setIsOwner(true); })
      .catch(() => {});
  }, []);

  // Bookmarks persistence
  const [bookmarks, setBookmarks] = useState(() => {
    try {
      const saved = localStorage.getItem('sr_bookmarks');
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });

  const toggleBookmark = (eventId) => {
    setBookmarks((prev) => {
      const exists = prev.includes(eventId);
      const next = exists ? prev.filter(id => id !== eventId) : [...prev, eventId];
      try {
        localStorage.setItem('sr_bookmarks', JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  // Keyboard shortcut for search
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        const input = document.querySelector('input[type="text"]');
        if (input) input.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const mergeDaysPreservingImages = (newDays, prevDays) => {
    const merged = { ...newDays };
    Object.keys(merged).forEach(dayKey => {
      if (merged[dayKey]?.events && prevDays[dayKey]?.events) {
        const prevImgMap = {};
        prevDays[dayKey].events.forEach(pe => {
          if (pe.image) {
            prevImgMap[pe.timestamp] = { image: pe.image, caption: pe.imageCaption };
          }
        });
        merged[dayKey].events.forEach(ne => {
          if (!ne.image && prevImgMap[ne.timestamp]) {
            ne.image = prevImgMap[ne.timestamp].image;
            ne.imageCaption = prevImgMap[ne.timestamp].caption;
          }
        });
      }
    });
    return merged;
  };

  // Fetch updated POVs list on mount
  useEffect(() => {
    fetch('/api/povs')
      .then(r => r.json())
      .then(d => {
        if (d && d.povs) setPovConfig(d);
      })
      .catch(() => {});
  }, []);

  // Load the library (home grid) on mount & whenever a stream is added
  const fetchLibrary = () => {
    fetch('/api/library')
      .then(r => r.json())
      .then(d => {
        if (d && Array.isArray(d.streams)) setLibrary(d.streams);
      })
      .catch(() => {});
  };
  useEffect(() => { fetchLibrary(); }, []);

  const fetchTranscriptionJobs = () => {
    fetch('/api/transcription-jobs')
      .then(r => r.json())
      .then(data => setTranscriptionJobs(Array.isArray(data?.jobs) ? data.jobs : []))
      .catch(() => {});
  };
  useEffect(() => {
    fetchTranscriptionJobs();
    const timer = setInterval(fetchTranscriptionJobs, 5000);
    return () => clearInterval(timer);
  }, []);

  const recoverTranscriptionJob = (streamId) => {
    fetch(`/api/transcription-jobs?streamId=${encodeURIComponent(streamId)}`)
      .then(r => r.json())
      .then(data => {
        const activeJob = (data.jobs || []).find(job => job.status === 'queued' || job.status === 'running');
        if (activeJob) {
          setTranscriptionJob(activeJob);
          watchTranscriptionJob(activeJob.id, streamId);
        }
      })
      .catch(() => {});
  };

  const handleOpenStream = (id) => {
    setActiveStreamId(id);
    handleSwitchPov(id);
    recoverTranscriptionJob(id);
    window.scrollTo({ top: 0 });
  };

  const handleGoHome = () => {
    setActiveStreamId(null);
    setSearchQuery('');
    setShowOnlyBookmarks(false);
    fetchLibrary();
    window.scrollTo({ top: 0 });
  };

  const watchTranscriptionJob = (jobId, streamId) => {
    const check = () => {
      fetch(`/api/transcription-jobs/${encodeURIComponent(jobId)}`)
        .then(r => r.json())
        .then(job => {
          setTranscriptionJob(job);
          if (job.status === 'queued' || job.status === 'running' || job.status === 'rate-limited') {
            const batchJob = job.mode === 'batch' || /batch/i.test(job.stage || '');
            setTimeout(check, job.status === 'rate-limited' ? 1000 : batchJob ? 30000 : 5000);
            return;
          }
          if (job.status === 'completed') {
            fetch(`/api/days?pov=${encodeURIComponent(streamId)}`)
              .then(r => r.json())
              .then(data => {
                if (data?.days) {
                  setPovDaysMap(prev => ({
                    ...prev,
                    [streamId]: mergeDaysPreservingImages(data.days, prev[streamId] || {})
                  }));
                }
                fetchLibrary();
                setTimeout(() => setTranscriptionJob(null), 5000);
              })
              .catch(() => {});
          }
        })
        .catch(() => setTimeout(check, 5000));
    };
    check();
  };

  const handleCaptureFrame = async (eventId, dayNumber = selectedDay) => {
    try {
      const res = await ownerFetch(`/api/streams/${encodeURIComponent(currentPov)}/events/${encodeURIComponent(eventId)}/frame?day=${encodeURIComponent(dayNumber)}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Unable to capture screenshot');
      setPovDaysMap(prev => {
        const currentDays = prev[currentPov] || {};
        const nextDays = Object.fromEntries(Object.entries(currentDays).map(([dayKey, day]) => [
          dayKey,
          { ...day, events: (day.events || []).map(event => event.id === eventId ? { ...event, ...data.event } : event) }
        ]));
        return { ...prev, [currentPov]: nextDays };
      });
      return data.event;
    } catch (err) {
      window.alert(err.message || 'Unable to capture screenshot');
      return null;
    }
  };

  const handleReviewEvent = async (eventId, decision) => {
    try {
      const res = await ownerFetch(`/api/streams/${encodeURIComponent(currentPov)}/events/${encodeURIComponent(eventId)}/review`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision })
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Unable to save review');
      setPovDaysMap(prev => {
        const currentDays = prev[currentPov] || {};
        const nextDays = Object.fromEntries(Object.entries(currentDays).map(([dayKey, day]) => [
          dayKey,
          {
            ...day,
            events: (day.events || []).map(event => event.id === eventId ? { ...event, ...data.event } : event)
          }
        ]));
        return { ...prev, [currentPov]: nextDays };
      });
    } catch (err) {
      window.alert(err.message || 'Unable to save review');
    }
  };

  const handleDeleteDay = async (dayNum, dayInfo) => {
    const label = formatDayLabel(dayInfo || {}, dayNum);
    if (!window.confirm(`Delete the ${label} broadcast from this stream? This removes its timeline and screenshots.`)) return;
    try {
      const res = await ownerFetch(`/api/streams/${encodeURIComponent(currentPov)}/days/${encodeURIComponent(dayNum)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Unable to remove stream day');
      if (data.removedStream) {
        setPovDaysMap(prev => {
          const next = { ...prev };
          delete next[currentPov];
          return next;
        });
        setPovConfig(prev => ({ ...prev, povs: (prev.povs || []).filter(stream => stream.id !== currentPov) }));
        handleGoHome();
        return;
      }
      const nextDays = data.data?.days || {};
      setPovDaysMap(prev => ({ ...prev, [currentPov]: nextDays }));
      setSelectedDay(Object.keys(nextDays)[0] || '1');
      fetchLibrary();
    } catch (err) {
      window.alert(err.message || 'Unable to remove stream day');
    }
  };

  const handleDeleteStream = async (item) => {
    if (!item?.id || !window.confirm(`Remove the generated recap for ${item.name}? This deletes its timestamps and screenshots.`)) return;
    try {
      const res = await ownerFetch(`/api/streams/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Unable to remove stream');
      setLibrary(prev => prev.filter(stream => stream.id !== item.id));
      setPovConfig(prev => ({ ...prev, povs: (prev.povs || []).filter(stream => stream.id !== item.id) }));
      if (activeStreamId === item.id) handleGoHome();
    } catch (err) {
      window.alert(err.message || 'Unable to remove stream');
    }
  };

  // Fetch latest days data on mount and on POV change
  useEffect(() => {
    fetch(`/api/days?pov=${currentPov}`)
      .then(r => r.json())
      .then(d => {
        if (d && d.days) {
          setPovDaysMap(prev => ({
            ...prev,
            [currentPov]: mergeDaysPreservingImages(d.days, prev[currentPov] || {})
          }));
          const dayKeys = Object.keys(d.days);
          setSelectedDay(prev => (!dayKeys.includes(prev) && dayKeys.length > 0 ? dayKeys[0] : prev));
        }
      })
      .catch(() => {});
  }, [currentPov]);

  // Sync / check updates
  const handleSync = async () => {
    setIsSyncing(true);
    setSyncStatus('syncing');
    try {
      const res = await ownerFetch(`/api/sync?pov=${currentPov}`, { method: 'POST' });
      const json = await res.json();
      if (json.data && json.data.days) {
        setPovDaysMap(prev => ({
          ...prev,
          [currentPov]: mergeDaysPreservingImages(json.data.days, prev[currentPov] || {})
        }));
        setSyncStatus('synced');
        setTimeout(() => setSyncStatus('idle'), 3000);
      } else {
        setSyncStatus('idle');
      }
    } catch {
      setSyncStatus('idle');
    } finally {
      setIsSyncing(false);
    }
  };

  const handleSwitchPov = (newPovId, targetDay, targetEventId) => {
    setCurrentPov(newPovId);
    try {
      localStorage.setItem('sr_active_pov', newPovId);
    } catch {}

    const targetDays = povDaysMap[newPovId] || (newPovId === 'buddha' ? initialBuddhaDays.days : {});
    const availableDays = Object.keys(targetDays);

    if (targetDay && targetDays[targetDay]) {
      setSelectedDay(targetDay);
    } else if (availableDays.length > 0 && !availableDays.includes(selectedDay)) {
      setSelectedDay(availableDays[0]);
    }

    if (targetEventId) {
      setTimeout(() => {
        const el = document.querySelector(`#${targetEventId}`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('ring-2', 'ring-amber-500', 'ring-offset-2', 'ring-offset-black');
          setTimeout(() => el.classList.remove('ring-2', 'ring-amber-500', 'ring-offset-2', 'ring-offset-black'), 2500);
        }
      }, 250);
    }
  };

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const scrollToBottom = () => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
  };

  const activePovConfig = povConfig.povs.find(p => p.id === currentPov) || povConfig.povs[0];
  const isHome = activeStreamId === null;
  const currentDayInfo = days[selectedDay] || days[Object.keys(days)[0]] || days['1'];
  const activeEvents = currentDayInfo?.events || (currentPov === 'xqc' ? recapData.events : []);

  const formatCooldown = (retryAt) => {
    const remaining = Math.max(0, new Date(retryAt).getTime() - Date.now());
    const totalSeconds = Math.ceil(remaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };

  const formatElapsed = (job) => {
    const startMs = Date.parse(job?.startedAt || job?.createdAt || '');
    if (!Number.isFinite(startMs)) return '—';
    const endMs = Date.parse(job?.completedAt || job?.failedAt || '') || Date.now();
    const totalSeconds = Math.max(0, Math.floor((endMs - startMs) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  };

  const formatEta = (seconds) => {
    const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
    if (!totalSeconds) return '';
    if (totalSeconds < 60) return '<1 min';
    const totalMinutes = Math.ceil(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes} min`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  };

  const getDayOptionLabel = (dayNum, dayInfo) => {
    const count = dayInfo?.eventsCount || dayInfo?.events?.length || 0;
    const approx = dayInfo?.timestampsApproximate ? ' ~approx' : '';
    const status = dayInfo?.isLive ? ' • LIVE' : '';
    const label = formatDayLabel(dayInfo, dayNum);
    return `${label} (${count} moments${approx})${status}`;
  };

  const formatDayLabel = (dayInfo, fallbackNum) => {
    const rawDate = String(dayInfo?.streamDate || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      const [year, month, day] = rawDate.split('-').map(Number);
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sept', 'oct', 'nov', 'dec'];
      if (year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return `${months[month - 1]}.${day}.${String(year).slice(-2)}`;
      }
    }
    return `Day ${fallbackNum}`;
  };

  return (
    <div className="min-h-screen bg-[#09090b] text-zinc-100 flex flex-col font-sans selection:bg-amber-500/20 selection:text-amber-200">
      {/* Top Navigation */}
      <Navbar
        bookmarkCount={bookmarks.length}
        showOnlyBookmarks={showOnlyBookmarks}
        setShowOnlyBookmarks={setShowOnlyBookmarks}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onSync={handleSync}
        isSyncing={isSyncing}
        syncStatus={syncStatus}
        onOpenAddStream={() => setShowAddStream(true)}
        isOwner={isOwner}
        onUnlock={() => setShowUnlock(true)}
        view={isHome ? 'home' : 'stream'}
        onGoHome={handleGoHome}
      />

      {/* Main Content: Home (library) OR Stream timeline */}
      {isHome ? (
        <main className="flex-1 w-full mx-auto px-4 pt-2">
          <HomeView
            items={library}
            onOpenStream={handleOpenStream}
            onOpenAddStream={() => setShowAddStream(true)}
            onDeleteStream={handleDeleteStream}
            isOwner={isOwner}
            onSelectCharacter={(charName) => setSelectedCharacter(charName)}
          />
        </main>
      ) : (
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 pt-3">
        {/* Stream title bar (stream view identification) */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg font-bold text-zinc-100 tracking-tight truncate">
            {activePovConfig?.name}
          </span>
          {!days[selectedDay]?.isLive && formatDayLabel(days[selectedDay] || {}, selectedDay).match(/^\w{3}\s\d/) ? (
            <span className="text-xs text-zinc-500 font-mono shrink-0">{formatDayLabel(days[selectedDay] || {}, selectedDay)}</span>
          ) : null}
          {days[selectedDay]?.isLive && (
            <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 text-[10px] font-bold">LIVE</span>
          )}
        </div>

        {transcriptionJob && transcriptionJob.status !== 'completed' && (
          <div className={`mb-3 p-3 rounded-xl border space-y-2 ${transcriptionJob.status === 'failed' || transcriptionJob.status === 'budget-exhausted' ? 'bg-red-500/[0.07] border-red-500/30' : 'bg-amber-500/[0.07] border-amber-500/20'}`}>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className={`${transcriptionJob.status === 'failed' || transcriptionJob.status === 'budget-exhausted' ? 'text-red-200' : transcriptionJob.status === 'rate-limited' ? 'text-orange-200' : 'text-amber-200'} font-medium`}>{transcriptionJob.status === 'queued' ? `Queued${transcriptionJob.queuePosition ? ` — position ${transcriptionJob.queuePosition}` : ''}` : transcriptionJob.status === 'rate-limited' && transcriptionJob.retryAt ? `Provider cooldown — retry in ${formatCooldown(transcriptionJob.retryAt)}` : (transcriptionJob.stage || 'Transcription in progress')}</span>
              <div className="flex items-center gap-2">
                <span className={`${transcriptionJob.status === 'failed' || transcriptionJob.status === 'budget-exhausted' ? 'text-red-300' : 'text-amber-400'} font-mono tabular-nums`}>{transcriptionJob.progress || 0}%</span>
                {(transcriptionJob.status === 'failed' || transcriptionJob.status === 'budget-exhausted') && (
                  <button
                    onClick={() => setTranscriptionJob(null)}
                    className="p-1 rounded hover:bg-white/10 text-zinc-400 hover:text-white transition-colors cursor-pointer ml-1"
                    title="Dismiss failed notification"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
            <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${transcriptionJob.status === 'failed' || transcriptionJob.status === 'budget-exhausted' ? 'bg-red-500' : 'bg-gradient-to-r from-amber-500 to-orange-400'}`}
                style={{ width: `${Math.max(2, Math.min(100, transcriptionJob.progress || 0))}%` }}
              />
            </div>
            <div className="flex items-center gap-3 text-[10px] text-zinc-500 font-mono tabular-nums">
              <span>Elapsed: {formatElapsed(transcriptionJob)}</span>
              {transcriptionJob.transcriptionStartedAt ? <span>Transcribing: {formatElapsed({ startedAt: transcriptionJob.transcriptionStartedAt })}</span> : null}
            </div>
            <p className="text-[10px] text-zinc-500">
              {transcriptionJob.status === 'failed' || transcriptionJob.status === 'budget-exhausted'
                ? (transcriptionJob.error || 'Transcription failed. The provisional recap remains available.')
                : transcriptionJob.status === 'queued'
                  ? 'Waiting for the active transcription job to finish. Your VOD will start automatically.'
                  : transcriptionJob.status === 'rate-limited'
                    ? 'The transcription provider is cooling down; the job will retry automatically.'
                    : transcriptionJob.etaSeconds > 0
                    ? `Estimated time remaining: about ${formatEta(transcriptionJob.etaSeconds)}. This adjusts as more chunks finish.`
                    : (transcriptionJob.progress || 0) >= 35
                      ? 'Calculating an ETA from the first completed chunks…'
                      : 'Preparing audio. An ETA will appear once transcription begins.'}
            </p>
            {transcriptionJob.usage && (
              <div className="flex items-center justify-between text-[10px] pt-1 border-t border-white/[0.06]">
                <span className="text-zinc-500">
                  {transcriptionJob.usage.provider === 'groq' ? 'Groq usage' : 'Transcription usage (estimated)'}: <span className="font-mono text-zinc-300">${transcriptionJob.usage.spendDollars.toFixed(2)}</span> / <span className="font-mono text-zinc-300">${transcriptionJob.usage.capDollars.toFixed(2)}</span> this month
                </span>
                <span className={`font-mono tabular-nums ${transcriptionJob.usage.pct >= 80 ? 'text-rose-400' : 'text-zinc-500'}`}>{transcriptionJob.usage.pct}% used</span>
              </div>
            )}
          </div>
        )}

        {transcriptionJobs.filter(job => ['queued', 'running', 'rate-limited'].includes(job.status)).length > 0 && (
          <div className="mb-3 p-3 rounded-xl border border-white/[0.08] bg-zinc-950/70 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-zinc-200">Transcription queue</span>
              <span className="text-zinc-500 font-mono tabular-nums">
                {transcriptionJobs.filter(job => ['queued', 'running', 'rate-limited'].includes(job.status)).length} active
              </span>
            </div>
            <div className="space-y-1.5">
              {transcriptionJobs
                .filter(job => ['queued', 'running', 'rate-limited'].includes(job.status))
                .map(job => (
                  <div key={job.id} className="flex items-center justify-between gap-3 text-[10px] text-zinc-400">
                    <span className="min-w-0 truncate">
                      <span className="text-zinc-200 font-medium">{job.streamId}</span>
                      {job.vodDate ? <span className="text-amber-300/80 font-mono ml-1.5">{formatDayLabel({ streamDate: job.vodDate }, '')}</span> : null}
                      <span className="mx-1.5 text-zinc-600">·</span>
                      <span>{job.status === 'queued' ? `Queued${job.queuePosition ? ` · #${job.queuePosition}` : ''}` : job.stage || job.status}</span>
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-zinc-500">
                      {job.status === 'queued' ? '—' : `${job.progress || 0}% · ${formatElapsed(job)}`}
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Day Switcher & Extras Toolbar */}
        <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/[0.08] gap-2">
          <div className="flex items-center gap-2 overflow-x-auto">
            {Object.keys(days).length <= 6 ? (
              <div className="flex items-center bg-zinc-900/90 p-1 rounded-lg border border-white/[0.08] gap-1 overflow-x-auto">
              {Object.entries(days).map(([dayNum, dayInfo]) => {
                const isSelected = selectedDay === dayNum;
                const count = dayInfo.eventsCount || dayInfo.events?.length || 0;
                return (
                  <div key={dayNum} className="flex items-center shrink-0">
                    <button
                      onClick={() => setSelectedDay(dayNum)}
                      className={`px-3 py-1.5 rounded-l-md text-xs transition-all flex items-center gap-1.5 cursor-pointer whitespace-nowrap ${
                        isSelected
                          ? 'bg-zinc-800 text-white font-semibold shadow-sm border border-zinc-700/60'
                          : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/40'
                      }`}
                    >
                      <span>{formatDayLabel(dayInfo, dayNum)}</span>
                      <span className="font-mono text-[10px] tabular-nums opacity-75">({count})</span>
                      {dayInfo.timestampsApproximate && (
                        <span
                          className="text-[9px] text-amber-400/80 font-semibold"
                          title="Timestamps are approximate — paste the VOD link or chat notes for exact moment times."
                        >
                          ~approx
                        </span>
                      )}
                    </button>
                    {isOwner && (
                      <button
                        onClick={() => handleDeleteDay(dayNum, dayInfo)}
                        className={`p-1.5 rounded-r-md border-l text-zinc-500 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer ${isSelected ? 'bg-zinc-800 border-zinc-700/60' : 'border-transparent'}`}
                        title={`Delete ${formatDayLabel(dayInfo, dayNum)} broadcast`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="relative">
                <select
                  value={selectedDay}
                  onChange={(e) => setSelectedDay(e.target.value)}
                  className="pl-3 pr-8 py-1.5 rounded-lg text-xs font-semibold bg-zinc-900 text-zinc-100 border border-white/10 hover:border-zinc-700 focus:outline-none transition-colors appearance-none cursor-pointer shadow-sm"
                >
                  {Object.entries(days).map(([dayNum, dayInfo]) => (
                    <option key={dayNum} value={dayNum}>
                      {getDayOptionLabel(dayNum, dayInfo)}
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-3.5 h-3.5 text-zinc-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              </div>
              {isOwner && currentDayInfo && (
                <button
                  onClick={() => handleDeleteDay(selectedDay, currentDayInfo)}
                  className="p-1.5 rounded-lg border border-white/10 text-zinc-500 hover:text-rose-300 hover:bg-rose-500/10 cursor-pointer"
                  title={`Delete ${formatDayLabel(currentDayInfo, selectedDay)} broadcast`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
          </div>

          {/* Calendar Picker Popover with Clickable Days */}
          <div className="flex items-center gap-1.5 shrink-0">
            <CalendarPicker
              days={days}
              selectedDay={selectedDay}
              onSelectDay={(dayKey) => setSelectedDay(dayKey)}
              streamColor={activePovConfig?.color || 'amber'}
            />
          </div>
        </div>

        {/* Approximate Timeline Notice */}
        {currentDayInfo?.timestampsApproximate && (
          <div className="flex items-start gap-2 px-3 py-2 mb-3 rounded-lg bg-amber-500/[0.07] border border-amber-500/20 text-[11px] text-amber-200/90">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
            <p>
              <span className="font-semibold text-amber-300">Timestamps are approximate.</span> This recap was generated without
              exact timestamp sources (VOD chapters, clips, or chat notes). For pinpoint moments, re-run with the VOD link or paste
              a chat log / notes.
            </p>
          </div>
        )}

        {/* The Clean Timeline Feed */}
        <TimelineView
          events={activeEvents}
          bookmarks={bookmarks}
          toggleBookmark={toggleBookmark}
          showOnlyBookmarks={showOnlyBookmarks}
          setShowOnlyBookmarks={setShowOnlyBookmarks}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          kickStreamUrl={currentDayInfo?.kickStreamUrl || null}
          activePov={activePovConfig}
          isOwner={isOwner}
          onReviewEvent={handleReviewEvent}
          onCaptureFrame={handleCaptureFrame}
          activeDayNumber={selectedDay}
          onSwitchPov={handleSwitchPov}
          onSelectCharacter={(charName) => setSelectedCharacter(charName)}
        />
      </main>
      )}

      {/* Add Stream / Generate Recap Modal */}
      <AddStreamModal
        isOpen={showAddStream}
        onClose={() => setShowAddStream(false)}
        onStreamAdded={(newId, result) => {
          fetch('/api/povs')
            .then(r => r.json())
            .then(d => {
              if (d && d.povs) setPovConfig(d);
              handleSwitchPov(newId);
            });
          // Open the freshly generated stream's timeline + refresh the home library.
          setActiveStreamId(newId);
          fetchLibrary();
          window.scrollTo({ top: 0 });
          if (result?.transcriptionJobId) watchTranscriptionJob(result.transcriptionJobId, newId);
        }}
      />

      <UnlockModal
        isOpen={showUnlock}
        onClose={() => setShowUnlock(false)}
        onUnlocked={() => setIsOwner(true)}
      />

      <CharacterModal
        characterName={selectedCharacter}
        isOpen={Boolean(selectedCharacter)}
        onClose={() => setSelectedCharacter(null)}
        onOpenMoment={(streamId, dayNumber, eventId) => {
          setSelectedCharacter(null);
          handleOpenStream(streamId);
          handleSwitchPov(streamId, dayNumber, eventId);
        }}
      />

      {/* Floating Scroll Navigation — stream view only */}
      {!isHome && (
      <div className="fixed bottom-6 right-6 z-30 flex flex-col gap-2">
        <button
          onClick={scrollToTop}
          className="p-2.5 rounded-full bg-zinc-800/90 hover:bg-zinc-700 text-zinc-300 hover:text-white shadow-xl border border-white/10 hover:scale-105 active:scale-95 transition-all cursor-pointer backdrop-blur-md"
          title="Scroll to top"
        >
          <ArrowUp className="w-4 h-4" />
        </button>
        <button
          onClick={scrollToBottom}
          className="p-2.5 rounded-full bg-zinc-800/90 hover:bg-zinc-700 text-zinc-300 hover:text-white shadow-xl border border-white/10 hover:scale-105 active:scale-95 transition-all cursor-pointer backdrop-blur-md"
          title="Scroll to bottom"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      </div>
      )}

      <Analytics />
    </div>
  );
}
