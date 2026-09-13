import { Clock, Plus, Layers, Sparkles, Play, Trash2 } from 'lucide-react';

function shortDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export default function HomeView({ items = [], onOpenStream, onOpenAddStream, onDeleteStream, isOwner }) {
  return (
    <div className="max-w-6xl mx-auto pb-16">
      {/* Hero header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 sm:gap-4 pt-4 pb-6 border-b border-white/[0.08] mb-6">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-md px-2 py-0.5">
              <Sparkles className="w-3 h-3" />
              AI Timestamp Recaps
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Your Stream Recaps</h1>
          <p className="text-xs text-zinc-500 mt-1">
            Generate timestamped moments from any Twitch, Kick, or YouTube VOD — then click a card to explore the timeline.
          </p>
        </div>

        {isOwner && (
          <button
            onClick={onOpenAddStream}
            className="shrink-0 px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-bold text-xs tracking-wide uppercase transition-all shadow-lg hover:shadow-amber-500/20 flex items-center justify-center gap-2 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Add Stream / VOD
          </button>
        )}
      </div>

      {/* Library grid */}
      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center text-center py-20 px-4 bg-zinc-900/40 rounded-2xl border border-white/[0.08] gap-4">
          <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
            <Layers className="w-8 h-8" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-zinc-200">No recaps yet</h3>
            <p className="text-xs text-zinc-500 mt-1 max-w-sm">
              {isOwner
                ? <>Paste a VOD link (or a channel name) and we&apos;ll auto-generate a timestamped recap. It&apos;ll appear here for you to open any time.</>
                : <>No recaps have been published yet. Check back soon.</>}
            </p>
          </div>
          {isOwner && (
            <button
              onClick={onOpenAddStream}
              className="px-4 py-2.5 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-bold text-xs tracking-wide uppercase transition-all shadow-lg flex items-center gap-2 cursor-pointer"
            >
              <Play className="w-4 h-4" />
              Generate your first recap
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-4">
          {items.map((item) => (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpenStream?.(item.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpenStream?.(item.id); }}
              className="group relative rounded-2xl overflow-hidden border border-white/[0.08] bg-zinc-950 hover:border-zinc-600/80 hover:shadow-xl hover:shadow-black/40 transition-all duration-200 text-left cursor-pointer select-none"
            >
              {/* Thumbnail — the first screenshot of the generated stream */}
              <div className="relative aspect-video w-full overflow-hidden">
                <img
                  src={item.firstImage || '/images/placeholder.svg'}
                  alt={item.name || item.title || ''}
                  loading="lazy"
                  className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/15 to-black/45" />

                {/* top row: name + approx badge */}
                <div className="absolute top-0 inset-x-0 p-2 flex items-start justify-between gap-1">
                  <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-black/60 backdrop-blur-md border border-white/10 text-[11px] font-semibold text-white">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                    {item.name}
                  </span>
                  <div className="flex items-center gap-1">
                    {isOwner && item.isGenerated && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteStream?.(item);
                        }}
                        className="p-1 rounded-md bg-black/60 backdrop-blur-md border border-white/10 text-zinc-400 hover:text-red-300 hover:border-red-400/40 transition-colors cursor-pointer"
                        title="Remove this generated recap"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                    {item.timestampsApproximate && (
                    <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 text-[9px] font-semibold">
                      ~approx
                    </span>
                  )}
                  </div>
                </div>

                {/* bottom: title + stats */}
                <div className="absolute bottom-0 inset-x-0 p-2.5">
                  <p className="text-xs font-semibold text-zinc-100 leading-snug line-clamp-1">
                    {item.title || item.name}
                  </p>
                  <p className="text-[10px] text-zinc-400 mt-1 flex items-center gap-1.5 font-mono tabular-nums">
                    <Clock className="w-3 h-3 text-zinc-500" />
                    {item.totalEvents || item.eventCount || 0} moment{item.totalEvents === 1 ? '' : 's'}{' '}
                    <span className="text-zinc-600">·</span>
                    {item.dayCount || 1} day{item.dayCount === 1 ? '' : 's'}
                    {item.updated ? <><span className="text-zinc-600">·</span> {shortDate(item.updated)}</> : null}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}