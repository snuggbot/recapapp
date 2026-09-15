import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { X, ExternalLink, Loader2, Play, Eye, Volume2, VolumeX, ArrowRightLeft, Columns, Square } from 'lucide-react';
import { KickIcon } from './Icons';

// Individual Video Stream Feed
function SingleStreamFeed({
  streamUrl,
  initialSeconds,
  timestamp,
  streamerName,
  badgeClass = 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  isMuted = false,
  onMuteToggle,
  onVideoRef,
  className = 'w-full h-full'
}) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [needsPlayClick, setNeedsPlayClick] = useState(false);

  useEffect(() => {
    if (onVideoRef && videoRef.current) {
      onVideoRef(videoRef.current);
    }
  }, [onVideoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !streamUrl) {
      setError('Stream URL unavailable');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);
    setNeedsPlayClick(false);

    const seekTarget = Math.max(0, Number(initialSeconds || 0) - 2);

    const tryAutoPlay = () => {
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            setIsLoading(false);
          })
          .catch(() => {
            setIsLoading(false);
            setNeedsPlayClick(true);
          });
      }
    };

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = `${streamUrl}#t=${seekTarget}`;
      video.currentTime = seekTarget;
      
      const onLoadedMetadata = () => {
        video.currentTime = seekTarget;
        tryAutoPlay();
      };

      video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
      tryAutoPlay();

      return () => {
        video.removeEventListener('loadedmetadata', onLoadedMetadata);
        video.removeAttribute('src');
        video.load();
      };
    } else if (Hls.isSupported()) {
      const hls = new Hls({
        startPosition: seekTarget,
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 90
      });
      hlsRef.current = hls;

      hls.loadSource(streamUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        tryAutoPlay();
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls.recoverMediaError();
              break;
            default:
              hls.destroy();
              setError('Stream unavailable');
              setIsLoading(false);
              break;
          }
        }
      });

      return () => {
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }
      };
    } else {
      setError('HLS playback not supported');
      setIsLoading(false);
    }
  }, [streamUrl, initialSeconds]);

  // Sync mute state
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = isMuted;
    }
  }, [isMuted]);

  const handleManualPlay = () => {
    if (videoRef.current) {
      videoRef.current.play().then(() => {
        setNeedsPlayClick(false);
      }).catch(() => {});
    }
  };

  return (
    <div className={`relative bg-black overflow-hidden flex items-center justify-center ${className}`}>
      <video
        ref={videoRef}
        controls
        playsInline
        preload="auto"
        className="w-full h-full object-contain"
      />

      {/* Streamer Pill & Audio indicator */}
      <div className="absolute top-2 left-2 flex items-center gap-1.5 pointer-events-auto z-20">
        <span className={`px-2 py-0.5 rounded text-[11px] font-semibold border backdrop-blur-md shadow-md ${badgeClass}`}>
          {streamerName}
        </span>
        {timestamp && (
          <span className="px-1.5 py-0.5 rounded bg-black/75 text-zinc-300 text-[10px] font-mono border border-white/10 backdrop-blur-md">
            @{timestamp}
          </span>
        )}
        {onMuteToggle && (
          <button
            onClick={onMuteToggle}
            className={`p-1 rounded border backdrop-blur-md transition-colors cursor-pointer ${
              isMuted ? 'bg-black/75 text-zinc-400 border-white/10' : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
            }`}
            title={isMuted ? 'Unmute this stream' : 'Mute this stream'}
          >
            {isMuted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
          </button>
        )}
      </div>

      {/* Loading Spinner */}
      {isLoading && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-xs flex flex-col items-center justify-center gap-2 pointer-events-none z-10">
          <Loader2 className="w-7 h-7 text-[#53fc18] animate-spin" />
          <span className="text-xs text-zinc-300 font-medium">Connecting {streamerName}...</span>
        </div>
      )}

      {/* Tap to Play Fallback */}
      {needsPlayClick && !isLoading && !error && (
        <div 
          onClick={handleManualPlay}
          className="absolute inset-0 bg-black/50 backdrop-blur-xs flex flex-col items-center justify-center gap-2 cursor-pointer z-10"
        >
          <div className="w-12 h-12 rounded-full bg-[#53fc18] text-black flex items-center justify-center shadow-xl hover:scale-105 active:scale-95 transition-all">
            <Play className="w-6 h-6 fill-current ml-0.5" />
          </div>
          <span className="text-xs text-white font-medium bg-black/80 px-2.5 py-0.5 rounded-full border border-white/10">
            Tap to Play ({streamerName})
          </span>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="absolute inset-0 bg-black/80 p-3 flex flex-col items-center justify-center gap-2 text-center z-10">
          <p className="text-xs text-zinc-300">{error}</p>
        </div>
      )}
    </div>
  );
}

// Main Multi-POV Player Component
export default function KickPlayer({
  streamUrl,
  seconds,
  timestamp,
  kickUrl,
  activeStreamer = 'Current POV',
  crossPovs = [],
  onClose
}) {
  // Active primary feed state (supports seamless in-player POV switching)
  const [currentStreamUrl, setCurrentStreamUrl] = useState(streamUrl);
  const [currentSeconds, setCurrentSeconds] = useState(seconds);
  const [currentTimestamp, setCurrentTimestamp] = useState(timestamp);
  const [currentStreamer, setCurrentStreamer] = useState(activeStreamer);
  const [currentKickUrl, setCurrentKickUrl] = useState(kickUrl);

  // Dual POV mode state
  const [isDualMode, setIsDualMode] = useState(false);
  const [secondaryPov, setSecondaryPov] = useState(crossPovs[0] || null);
  const [audioFocus, setAudioFocus] = useState('primary'); // 'primary' | 'secondary'

  const primaryVideoRef = useRef(null);
  const secondaryVideoRef = useRef(null);

  // When initial props change, sync primary state
  useEffect(() => {
    setCurrentStreamUrl(streamUrl);
    setCurrentSeconds(seconds);
    setCurrentTimestamp(timestamp);
    setCurrentStreamer(activeStreamer);
    setCurrentKickUrl(kickUrl);
  }, [streamUrl, seconds, timestamp, activeStreamer, kickUrl]);

  // Sync secondary POV option when crossPovs changes
  useEffect(() => {
    if (crossPovs.length > 0 && !secondaryPov) {
      setSecondaryPov(crossPovs[0]);
    }
  }, [crossPovs, secondaryPov]);

  // Handle switching POV in single mode
  const handleSwitchSinglePov = (povItem) => {
    if (!povItem) return;
    setCurrentStreamUrl(povItem.streamUrl);
    setCurrentSeconds(povItem.seconds);
    setCurrentTimestamp(povItem.timestamp);
    setCurrentStreamer(povItem.streamer || povItem.name || 'Alternate POV');
    setCurrentKickUrl(povItem.kickUrl || null);
  };

  // Swap Left & Right POVs in dual mode
  const handleSwapSides = () => {
    if (!secondaryPov) return;
    const oldPrimary = {
      streamUrl: currentStreamUrl,
      seconds: currentSeconds,
      timestamp: currentTimestamp,
      streamer: currentStreamer,
      kickUrl: currentKickUrl
    };
    handleSwitchSinglePov(secondaryPov);
    setSecondaryPov(oldPrimary);
  };

  // Master Dual Play/Pause
  const handleMasterTogglePlay = () => {
    const v1 = primaryVideoRef.current;
    const v2 = secondaryVideoRef.current;
    if (!v1) return;
    if (v1.paused) {
      v1.play().catch(() => {});
      if (v2) v2.play().catch(() => {});
    } else {
      v1.pause();
      if (v2) v2.pause();
    }
  };

  const hasAltPovs = crossPovs.length > 0;

  return (
    <div className="relative aspect-video w-full bg-zinc-950 overflow-hidden select-none flex flex-col group/player rounded-xl border border-white/10 shadow-2xl">
      {/* Top Header Bar */}
      <div className="absolute top-2 left-2 right-2 flex items-center justify-between pointer-events-auto z-30 transition-opacity duration-200">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-black/80 backdrop-blur-md text-[#53fc18] border border-[#53fc18]/30 text-xs font-mono font-semibold shadow-lg">
            <KickIcon className="w-3.5 h-3.5 fill-current" />
            <span className="text-zinc-200">Ad-Free HLS</span>
          </span>

          {/* Seamless In-Player Switcher Buttons */}
          {hasAltPovs && !isDualMode && (
            <div className="flex items-center gap-1 bg-black/80 backdrop-blur-md p-0.5 rounded-md border border-white/10">
              <span className="px-2 py-0.5 text-[10px] text-zinc-400 font-medium">Switch POV:</span>
              {crossPovs.map((alt) => (
                <button
                  key={alt.pov || alt.streamer}
                  onClick={() => handleSwitchSinglePov(alt)}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-500/20 hover:bg-rose-500/35 text-rose-300 border border-rose-500/30 transition-all cursor-pointer"
                  title={`Switch instantly to ${alt.streamer}'s perspective @ ${alt.timestamp}`}
                >
                  <Eye className="w-3 h-3 text-rose-400" />
                  <span>{alt.streamer}</span>
                  <span className="font-mono text-[9px] opacity-75">({alt.timestamp})</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right Controls: Dual Mode Toggle + External Link + Close */}
        <div className="flex items-center gap-1.5">
          {hasAltPovs && (
            <button
              onClick={() => setIsDualMode(!isDualMode)}
              className={`px-2.5 py-1 rounded-md backdrop-blur-md text-xs font-medium border flex items-center gap-1.5 transition-colors cursor-pointer ${
                isDualMode
                  ? 'bg-purple-600 text-white border-purple-400 shadow-md'
                  : 'bg-black/80 text-zinc-300 hover:text-white border-white/10 hover:border-purple-500/40'
              }`}
              title={isDualMode ? 'Switch to Single POV' : 'Open Side-by-Side Dual POV'}
            >
              {isDualMode ? <Square className="w-3.5 h-3.5" /> : <Columns className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{isDualMode ? 'Single POV' : 'Dual POV'}</span>
            </button>
          )}

          {isDualMode && (
            <button
              onClick={handleSwapSides}
              className="p-1.5 rounded-md bg-black/80 hover:bg-black text-zinc-300 hover:text-white border border-white/10 backdrop-blur-md transition-colors cursor-pointer"
              title="Swap Left & Right Streams"
            >
              <ArrowRightLeft className="w-3.5 h-3.5" />
            </button>
          )}

          {currentKickUrl && (
            <a
              href={currentKickUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded-md bg-black/80 hover:bg-black text-zinc-300 hover:text-white border border-white/10 backdrop-blur-md transition-colors flex items-center gap-1 text-xs"
              title="Open stream externally on Kick"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}

          <button
            onClick={onClose}
            className="p-1.5 rounded-md bg-black/80 hover:bg-black text-zinc-300 hover:text-white border border-white/10 backdrop-blur-md transition-colors cursor-pointer"
            title="Close video (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Video View Area */}
      <div className="flex-1 w-full h-full relative overflow-hidden">
        {isDualMode && secondaryPov ? (
          /* Side-by-Side Dual POV Layout */
          <div className="grid grid-cols-2 w-full h-full divide-x divide-white/10">
            <SingleStreamFeed
              streamUrl={currentStreamUrl}
              initialSeconds={currentSeconds}
              timestamp={currentTimestamp}
              streamerName={currentStreamer}
              badgeClass="bg-amber-500/20 text-amber-300 border-amber-500/40"
              isMuted={audioFocus !== 'primary'}
              onMuteToggle={() => setAudioFocus(prev => prev === 'primary' ? 'secondary' : 'primary')}
              onVideoRef={(ref) => { primaryVideoRef.current = ref; }}
            />
            <SingleStreamFeed
              streamUrl={secondaryPov.streamUrl}
              initialSeconds={secondaryPov.seconds}
              timestamp={secondaryPov.timestamp}
              streamerName={secondaryPov.streamer}
              badgeClass="bg-rose-500/20 text-rose-300 border-rose-500/40"
              isMuted={audioFocus !== 'secondary'}
              onMuteToggle={() => setAudioFocus(prev => prev === 'secondary' ? 'primary' : 'secondary')}
              onVideoRef={(ref) => { secondaryVideoRef.current = ref; }}
            />
          </div>
        ) : (
          /* Single POV Layout */
          <SingleStreamFeed
            streamUrl={currentStreamUrl}
            initialSeconds={currentSeconds}
            timestamp={currentTimestamp}
            streamerName={currentStreamer}
            badgeClass="bg-amber-500/20 text-amber-300 border-amber-500/40"
            isMuted={false}
            onVideoRef={(ref) => { primaryVideoRef.current = ref; }}
          />
        )}
      </div>

      {/* Dual POV Bottom Audio & Sync Bar */}
      {isDualMode && secondaryPov && (
        <div className="h-8 bg-zinc-900/90 border-t border-white/[0.08] px-3 flex items-center justify-between text-xs text-zinc-300 shrink-0 z-20">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-400">Audio Focus:</span>
            <button
              onClick={() => setAudioFocus('primary')}
              className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors cursor-pointer ${
                audioFocus === 'primary'
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                  : 'bg-zinc-800 text-zinc-400 border-white/10'
              }`}
            >
              🔊 {currentStreamer}
            </button>
            <button
              onClick={() => setAudioFocus('secondary')}
              className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors cursor-pointer ${
                audioFocus === 'secondary'
                  ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                  : 'bg-zinc-800 text-zinc-400 border-white/10'
              }`}
            >
              🔊 {secondaryPov.streamer}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleMasterTogglePlay}
              className="px-2.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[10px] font-medium border border-white/10 transition-colors cursor-pointer"
            >
              Sync Play/Pause Both
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
