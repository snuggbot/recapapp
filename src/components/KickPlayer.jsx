import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { X, ExternalLink, Loader2, Play } from 'lucide-react';
import { KickIcon } from './Icons';

export default function KickPlayer({ streamUrl, seconds, timestamp, kickUrl, onClose }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [needsPlayClick, setNeedsPlayClick] = useState(false);

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

    const seekTarget = Math.max(0, Number(seconds || 0) - 2);

    const tryAutoPlay = () => {
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            setIsLoading(false);
          })
          .catch(() => {
            // Autoplay blocked by mobile browser policy: show play button
            setIsLoading(false);
            setNeedsPlayClick(true);
          });
      }
    };

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS for Safari (iOS & macOS)
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
      // Hls.js for Chrome, Android, Firefox, Edge
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
              setError('Failed to load Kick stream');
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
      setError('HLS playback is not supported on this browser');
      setIsLoading(false);
    }
  }, [streamUrl, seconds]);

  const handleManualPlay = () => {
    if (videoRef.current) {
      videoRef.current.play().then(() => {
        setNeedsPlayClick(false);
      }).catch(() => {});
    }
  };

  return (
    <div className="relative aspect-video w-full bg-black overflow-hidden select-none flex items-center justify-center group/player">
      {/* HTML5 Video Element */}
      <video
        ref={videoRef}
        controls
        playsInline
        preload="auto"
        className="w-full h-full object-contain"
      />

      {/* Top Floating Control Bar */}
      <div className="absolute top-2 left-2 right-2 flex items-center justify-between pointer-events-auto z-30 transition-opacity duration-200">
        <div className="flex items-center gap-1.5">
          <span className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-black/80 backdrop-blur-md text-[#53fc18] border border-[#53fc18]/30 text-xs font-mono font-semibold shadow-lg">
            <KickIcon className="w-3.5 h-3.5 fill-current" />
            <span className="text-zinc-200">Kick Ad-Free</span>
          </span>
          {timestamp && (
            <span className="px-2 py-1 rounded-md bg-black/80 backdrop-blur-md text-zinc-200 border border-white/10 text-xs font-mono tabular-nums">
              @{timestamp}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {kickUrl && (
            <a
              href={kickUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded-md bg-black/80 hover:bg-black text-zinc-300 hover:text-white border border-white/10 backdrop-blur-md transition-colors flex items-center gap-1 text-xs"
              title="Open externally on Kick"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
          <button
            onClick={onClose}
            className="p-1.5 rounded-md bg-black/80 hover:bg-black text-zinc-300 hover:text-white border border-white/10 backdrop-blur-md transition-colors cursor-pointer"
            title="Return to screenshot"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Loading Spinner */}
      {isLoading && (
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm flex flex-col items-center justify-center gap-2 pointer-events-none z-20">
          <Loader2 className="w-8 h-8 text-[#53fc18] animate-spin" />
          <span className="text-xs text-zinc-300 font-medium">Loading Kick stream @ {timestamp}...</span>
        </div>
      )}

      {/* Manual Tap to Play (when mobile browser blocks unmuted autoplay) */}
      {needsPlayClick && !isLoading && !error && (
        <div 
          onClick={handleManualPlay}
          className="absolute inset-0 bg-black/50 backdrop-blur-xs flex flex-col items-center justify-center gap-3 cursor-pointer z-20"
        >
          <div className="w-14 h-14 rounded-full bg-[#53fc18] text-black flex items-center justify-center shadow-2xl hover:scale-110 active:scale-95 transition-all">
            <Play className="w-7 h-7 fill-current ml-1" />
          </div>
          <span className="text-xs text-white font-medium bg-black/80 px-3 py-1 rounded-full border border-white/10">
            Tap to Play ({timestamp})
          </span>
        </div>
      )}

      {/* Error State Fallback */}
      {error && (
        <div className="absolute inset-0 bg-black/90 p-4 flex flex-col items-center justify-center gap-3 text-center z-20">
          <p className="text-xs sm:text-sm text-zinc-300 max-w-sm">{error}</p>
          {kickUrl && (
            <a
              href={kickUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#53fc18] hover:bg-[#48de14] text-black font-semibold text-xs transition-all shadow-md"
            >
              <KickIcon className="w-4 h-4 fill-current" />
              <span>Open on Kick Website</span>
              <ExternalLink className="w-3.5 h-3.5 ml-1" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}
