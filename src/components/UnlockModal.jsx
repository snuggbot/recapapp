import { useState } from 'react';
import { Lock, X } from 'lucide-react';
import { checkOwnerKey, setOwnerKey } from '../lib/owner.js';

// Small owner unlock dialog. Guests never see it — it appears only via the
// navbar lock button. On success the key is remembered in localStorage.
export default function UnlockModal({ isOpen, onClose, onUnlocked }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  if (!isOpen) return null;

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) return;
    setChecking(true);
    setError('');
    const ok = await checkOwnerKey(trimmed);
    setChecking(false);
    if (!ok) {
      setError('That key is not valid for this site.');
      return;
    }
    setOwnerKey(trimmed);
    setKey('');
    onUnlocked?.();
    onClose?.();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2 text-amber-400">
            <Lock className="w-4 h-4" />
            <h3 className="text-sm font-bold text-white">Unlock editing</h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-zinc-500 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <p className="text-xs text-zinc-400 mt-1 mb-4">
          This site is browse-only for guests. Enter the owner key to add streams, run sync, or delete recaps.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <input
            type="password"
            autoFocus
            value={key}
            onChange={(e) => { setKey(e.target.value); setError(''); }}
            placeholder="Owner key"
            className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-white/10 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-amber-500/50 transition-colors"
          />
          {error && <p className="text-[11px] text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={checking || !key.trim()}
            className="w-full py-2.5 rounded-lg bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 disabled:opacity-50 text-black font-bold text-xs tracking-wide uppercase transition-all cursor-pointer"
          >
            {checking ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </div>
    </div>
  );
}