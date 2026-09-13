import { Search, Bookmark, RefreshCw, Check, Plus, ChevronLeft, Lock } from 'lucide-react';

export default function Navbar({
  bookmarkCount,
  showOnlyBookmarks,
  setShowOnlyBookmarks,
  searchQuery,
  setSearchQuery,
  onSync,
  isSyncing,
  syncStatus,
  onOpenAddStream,
  isOwner,
  onUnlock,
  view,
  onGoHome
}) {
  const isHome = view === 'home';

  const getSyncLabel = () => {
    if (isSyncing) return 'Checking...';
    if (syncStatus === 'synced') return 'Up to date';
    return 'Check updates';
  };

  const refreshSpinClass = isSyncing ? 'animate-spin text-amber-400' : '';

  return (
    <header className="sticky top-0 z-40 bg-[#0c0c0e]/85 backdrop-blur-md border-b border-white/[0.08]">
      <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between gap-3 sm:gap-4">
        {/* Left: Back (stream view) / Brand */}
        <div className="flex items-center gap-2 min-w-0">
          {!isHome && (
            <button
              onClick={onGoHome}
              className="p-2 -ml-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800/70 transition-colors cursor-pointer shrink-0"
              title="Back to all streams"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
          )}
          <button
            onClick={onGoHome}
            className="font-extrabold text-white text-sm sm:text-base tracking-tight whitespace-nowrap bg-gradient-to-r from-amber-400 to-amber-200 bg-clip-text text-transparent hover:opacity-90 transition-opacity cursor-pointer shrink-0"
            title="Home"
          >
            StreamRecap
          </button>

          {/* "+ Add Stream" Button — owner only; guests browse read-only */}
          {isOwner && (
            <button
              onClick={onOpenAddStream}
              className="px-2 py-1 rounded-md text-xs font-semibold bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 transition-all flex items-center gap-1 cursor-pointer shadow-sm shrink-0"
              title="Add any stream and generate an AI recap"
            >
              <Plus className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{isHome ? 'Add Stream / VOD' : 'Add Stream'}</span>
            </button>
          )}
        </div>

        {/* Right: stream-scoped actions (hidden on home) */}
        {!isHome && (
          <div className="flex items-center gap-2 shrink-0">
            {/* Search box */}
            <div className="relative w-32 sm:w-48">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                placeholder="Search moments..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-2.5 py-1.5 rounded-md bg-zinc-900/90 text-xs text-zinc-200 placeholder-zinc-500 border border-white/[0.08] focus:outline-none focus:border-zinc-600 transition-colors"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 text-[10px]"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Sync / Check Updates Button — owner only */}
            {isOwner && (
              <button
                onClick={onSync}
                disabled={isSyncing}
                className="px-2.5 py-1.5 rounded-md border border-white/[0.08] bg-zinc-900/90 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 transition-colors disabled:opacity-50 flex items-center gap-1.5 text-xs font-medium cursor-pointer"
                title="Re-load the latest timestamps"
              >
                {syncStatus === 'synced' ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <RefreshCw className={`w-3.5 h-3.5 ${refreshSpinClass}`} />
                )}
                <span className="hidden md:inline text-[11px]">
                  {getSyncLabel()}
                </span>
              </button>
            )}

            {/* Bookmarks Toggle */}
            <button
              onClick={() => setShowOnlyBookmarks(!showOnlyBookmarks)}
              className={`p-1.5 rounded-md border text-xs transition-colors flex items-center gap-1 cursor-pointer ${
                showOnlyBookmarks
                  ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                  : 'bg-zinc-900/90 border-white/[0.08] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80'
              }`}
              title="Show saved highlights"
            >
              <Bookmark className={`w-3.5 h-3.5 ${showOnlyBookmarks ? 'fill-amber-400 text-amber-400' : ''}`} />
              {bookmarkCount > 0 && <span className="font-mono text-[10px] tabular-nums font-semibold">{bookmarkCount}</span>}
            </button>
          </div>
        )}

        {/* Guests: a single lock button opens the owner unlock dialog */}
        {!isOwner && (
          <button
            onClick={onUnlock}
            className="p-1.5 rounded-md border border-white/[0.08] bg-zinc-900/90 text-zinc-500 hover:text-amber-300 hover:border-amber-500/30 transition-colors cursor-pointer shrink-0"
            title="Owner? Unlock editing"
          >
            <Lock className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </header>
  );
}