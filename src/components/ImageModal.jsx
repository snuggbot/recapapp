import { useEffect } from 'react';
import { X, Download, Clock } from 'lucide-react';

export default function ImageModal({ imageInfo, onClose }) {
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!imageInfo) return null;

  return (
    <div 
      className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex items-center justify-center p-3 sm:p-5"
      onClick={onClose}
    >
      <div 
        className="relative max-w-5xl w-full bg-zinc-950 rounded-xl border border-white/[0.08] overflow-hidden shadow-2xl flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header bar */}
        <div className="px-4 py-2.5 bg-zinc-900/90 border-b border-white/[0.08] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 truncate">
            {imageInfo.timestamp && (
              <span className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-black/60 text-zinc-300 font-mono text-xs tabular-nums font-semibold border border-white/10 shrink-0">
                <Clock className="w-3 h-3 text-zinc-400" />
                <span>{imageInfo.timestamp}</span>
              </span>
            )}
            <span className="text-xs sm:text-sm font-medium text-zinc-200 truncate">
              {imageInfo.caption || 'Screenshot'}
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <a
              href={imageInfo.src}
              download
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-white/10 transition-colors"
              title="Download image"
            >
              <Download className="w-3.5 h-3.5" />
            </a>
            <button
              onClick={onClose}
              className="p-1.5 rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white border border-white/10 transition-colors"
              title="Close (Esc)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Image display */}
        <div className="flex-1 overflow-auto bg-black flex items-center justify-center p-2 min-h-[260px]">
          <img
            src={imageInfo.src}
            alt={imageInfo.caption || 'Stream frame'}
            className="max-h-[80vh] w-auto max-w-full object-contain rounded shadow-2xl"
          />
        </div>

        {/* Caption footer */}
        {imageInfo.caption && (
          <div className="px-4 py-2 bg-zinc-900/90 border-t border-white/[0.08] text-xs text-zinc-400 flex items-center justify-between">
            <span className="truncate">{imageInfo.caption}</span>
            <span className="text-[10px] text-zinc-500 font-mono shrink-0 ml-2">nopixel V xQc pov</span>
          </div>
        )}
      </div>
    </div>
  );
}
