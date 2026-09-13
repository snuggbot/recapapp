// Owner-mode helper: the site is browse-only for guests. Mutating actions
// (add stream, sync, delete) require the owner key, stored in localStorage and
// sent as an X-Owner-Key header. The server enforces it regardless of the UI.
export const OWNER_KEY_STORAGE = 'sr_owner_key';

export function getOwnerKey() {
  try {
    return localStorage.getItem(OWNER_KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function setOwnerKey(key) {
  try {
    if (key) localStorage.setItem(OWNER_KEY_STORAGE, key);
    else localStorage.removeItem(OWNER_KEY_STORAGE);
  } catch {}
}

// Like fetch, but attaches the owner key header when one is stored.
export function ownerFetch(url, options = {}) {
  const key = getOwnerKey();
  const headers = { ...(options.headers || {}) };
  if (key) headers['x-owner-key'] = key;
  return fetch(url, { ...options, headers });
}

// Validate a candidate key against the server. Never stores it.
export async function checkOwnerKey(key) {
  try {
    const res = await fetch(`/api/auth/check?key=${encodeURIComponent(key)}`);
    const data = await res.json();
    return !!(data && data.owner);
  } catch {
    return false;
  }
}