import { useState, useEffect } from 'react';
import { X, ExternalLink, Clock, Star, Users, Shield, Tag, Eye } from 'lucide-react';

export default function CharacterModal({
  characterName,
  isOpen,
  onClose,
  onOpenMoment
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isOpen || !characterName) {
      setData(null);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    fetch(`/api/characters/${encodeURIComponent(characterName)}`)
      .then((r) => {
        if (!r.ok) throw new Error('Failed to load character details');
        return r.json();
      })
      .then((res) => {
        if (active) {
          setData(res);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(err.message || 'Unable to load dossier');
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [characterName, isOpen]);

  if (!isOpen || !characterName) return null;

  const character = data?.character || {};
  const moments = data?.moments || [];
  const displayName = character.name || characterName;
  const status = character.status || 'Active';
  const aliases = character.aliases || [];
  const affiliations = character.affiliations || [];
  const playedBy = character.playedBy || '';
  const wikiUrl = character.wikiUrl;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 animate-fadeIn"
      onClick={onClose}
    >
      <div
        className="relative max-w-2xl w-full bg-zinc-950 rounded-2xl border border-white/[0.12] overflow-hidden shadow-2xl flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 sm:p-5 bg-gradient-to-b from-zinc-900 via-zinc-900/90 to-zinc-950 border-b border-white/[0.08] flex items-start justify-between gap-3">
          <div className="flex items-start gap-3.5">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-amber-500/20 to-zinc-800 border border-amber-500/30 flex items-center justify-center text-amber-300 font-bold text-lg shrink-0 shadow-md">
              {displayName.charAt(0)}
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
                  {displayName}
                </h2>
                <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  {status}
                </span>
              </div>
              {playedBy && (
                <p className="text-xs text-zinc-400 mt-0.5">
                  Streamer:{' '}
                  <span className="text-zinc-200 font-medium">
                    {playedBy}
                  </span>
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {wikiUrl && (
              <a
                href={wikiUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 rounded-lg border border-white/10 bg-zinc-900/80 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors flex items-center gap-1 text-xs"
                title="View on NoPixel Wiki"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span className="hidden sm:inline text-[11px]">Wiki</span>
              </a>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg border border-white/10 bg-zinc-900/80 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          {loading && (
            <div className="py-12 text-center text-xs text-zinc-500">
              Loading canon dossier and moments…
            </div>
          )}
          {!loading && error && (
            <div className="py-8 text-center text-xs text-rose-400">
              {error}
            </div>
          )}
          {!loading && !error && (
            <>
              {/* Lore / Metadata Badges */}
              {(affiliations.length > 0 || aliases.length > 0) && (
                <div className="p-3 rounded-xl bg-zinc-900/60 border border-white/[0.06] space-y-2.5">
                  {/* Factions / Affiliations */}
                  {affiliations.length > 0 && (
                    <div>
                      <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider block mb-1 flex items-center gap-1">
                        <Shield className="w-3 h-3 text-amber-400" />
                        Gangs & Affiliations
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {affiliations.map((affil) => (
                          <span
                            key={affil}
                            className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-500/10 text-amber-300 border border-amber-500/25"
                          >
                            {affil}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Known In-game Aliases */}
                  {aliases.length > 0 && (
                    <div>
                      <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider block mb-1 flex items-center gap-1">
                        <Tag className="w-3 h-3 text-zinc-400" />
                        In-Game Aliases
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {aliases.slice(0, 10).map((alias) => (
                          <span
                            key={alias}
                            className="px-1.5 py-0.5 rounded text-[10px] bg-zinc-800/80 text-zinc-300 border border-white/[0.06]"
                          >
                            {alias}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Timeline Moments featuring this character */}
              <div>
                <div className="flex items-center justify-between mb-2.5">
                  <h3 className="text-xs font-semibold text-zinc-300 flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5 text-zinc-400" />
                    <span>Timeline Moments Featuring {displayName}</span>
                  </h3>
                  <span className="text-[11px] font-mono text-zinc-500 tabular-nums">
                    {moments.length} moment{moments.length === 1 ? '' : 's'}
                  </span>
                </div>

                {moments.length === 0 ? (
                  <div className="py-8 text-center text-xs text-zinc-500 bg-zinc-900/30 rounded-xl border border-white/[0.04]">
                    No recorded timeline moments yet for this character.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {moments.map((m) => (
                      <div
                        key={`${m.streamId}-${m.eventId}`}
                        onClick={() => {
                          onClose();
                          onOpenMoment?.(m.streamId, m.dayNumber, m.eventId);
                        }}
                        className="group flex items-start justify-between gap-3 p-2.5 sm:p-3 rounded-xl bg-zinc-900/70 hover:bg-zinc-800/80 border border-white/[0.06] hover:border-zinc-600/80 transition-all cursor-pointer text-left"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-zinc-800 text-zinc-300 border border-white/10">
                              {m.streamName || m.streamId}
                            </span>
                            <span className="text-[10px] font-mono text-zinc-500">
                              Day {m.dayNumber}
                            </span>
                            <span className="flex items-center gap-1 text-[10px] font-mono text-zinc-400">
                              <Clock className="w-2.5 h-2.5 text-zinc-500" />
                              {m.timestamp}
                            </span>
                            {m.isMajor && (
                              <Star className="w-3 h-3 fill-amber-400 text-amber-400 shrink-0" />
                            )}
                          </div>
                          <p className="text-xs font-semibold text-zinc-100 group-hover:text-amber-300 transition-colors leading-snug line-clamp-1">
                            {m.title || m.description}
                          </p>
                          <p className="text-[11px] text-zinc-400 mt-0.5 line-clamp-2 leading-relaxed">
                            {m.description}
                          </p>
                        </div>

                        <button
                          type="button"
                          className="shrink-0 p-1.5 rounded-lg bg-zinc-800 group-hover:bg-amber-500 text-zinc-400 group-hover:text-black transition-colors self-center"
                          title="Jump to moment"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
