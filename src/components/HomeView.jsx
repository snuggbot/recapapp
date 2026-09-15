import { useState, useEffect } from 'react';
import { Clock, Plus, Layers, Sparkles, Play, Trash2, Users } from 'lucide-react';

function shortDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export default function HomeView({ items = [], onOpenStream, onOpenAddStream, onDeleteStream, isOwner, onSelectCharacter }) {
  const [characters, setCharacters] = useState([]);

  useEffect(() => {
    fetch('/api/characters')
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d?.characters)) setCharacters(d.characters);
      })
      .catch(() => {});
  }, []);

  const activeCharacters = characters.filter((c) => (c.momentCount || 0) > 0);
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

      {/* NoPixel V Character Roster & Storylines */}
      {activeCharacters.length > 0 && (
        <div className="mt-10 pt-8 border-t border-white/[0.08]">
          <div className="flex items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white tracking-tight flex items-center gap-2">
                <Users className="w-4 h-4 text-amber-400" />
                <span>NoPixel V Server Characters & Storylines</span>
              </h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                Explore canonical dossiers, in-game lore, and every indexed moment across all streamer POVs.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {activeCharacters.slice(0, 12).map((char) => (
              <div
                key={char.id || char.name}
                onClick={() => onSelectCharacter?.(char.name)}
                className="group p-3 rounded-xl bg-zinc-950/70 hover:bg-zinc-900/90 border border-white/[0.07] hover:border-zinc-600/80 transition-all cursor-pointer text-left flex flex-col justify-between shadow-sm"
              >
                <div>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="w-8 h-8 rounded-lg bg-zinc-900 border border-white/10 flex items-center justify-center font-bold text-xs text-amber-300 group-hover:border-amber-500/40 transition-colors">
                      {char.name.charAt(0)}
                    </div>
                    {char.hasPOV && (
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/25">
                        POV STREAM
                      </span>
                    )}
                  </div>

                  <h3 className="text-xs font-bold text-zinc-100 group-hover:text-amber-300 transition-colors line-clamp-1">
                    {char.name}
                  </h3>
                  {char.role && (
                    <p className="text-[10px] text-zinc-400 line-clamp-1 mt-0.5">
                      {char.role}
                    </p>
                  )}
                  {char.streamer && (
                    <p className="text-[10px] text-zinc-500 mt-1">
                      Streamer: <span className="text-zinc-300 font-medium">{char.streamer}</span>
                    </p>
                  )}
                </div>

                <div className="mt-3 pt-2 border-t border-white/[0.05] flex items-center justify-between text-[10px] text-zinc-500 font-mono">
                  <span>{char.momentCount || 0} moment{char.momentCount === 1 ? '' : 's'}</span>
                  <span className="text-amber-400/80 font-sans group-hover:underline flex items-center gap-0.5">
                    Dossier →
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}