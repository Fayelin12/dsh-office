import { CT_TEXT, HIGH_FREQ_READ_PATHS } from "./constants.js";

export function sendForbidden(res) {
  res.writeHead(403, { 'content-type': CT_TEXT });
  res.end('forbidden');
}

// Extract [id, parentSession] pair from session entries with varying shapes:
// - sessionQuery records: { header: { id, parentSession } }
// - live sessions: { id, header: { parentSession } }
export function extractParentEntry(entry) {
  const h = entry.header || entry;
  const id = entry.id != null ? entry.id : h.id;
  const ps = h.parentSession;
  if (id != null && ps != null) {
    return [String(id), String(ps)];
  }
  return null;
}

// P1-2: LRU eviction — delete oldest entries when cache exceeds max size
export function evictOldest(map, max) {
  while (map.size > max) {
    const firstKey = map.keys().next().value;
    if (firstKey === undefined) break;
    map.delete(firstKey);
  }
}

export function isLoopback(remoteAddr) {
  return remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
}

export function isHighFreqReadPath(pathname) {
  return HIGH_FREQ_READ_PATHS.has(pathname) || pathname.startsWith("/office-ui/assets/");
}
