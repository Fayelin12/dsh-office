import os from "node:os";
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

// 本机 IPv4（办公室标题展示用）：取第一个非内部、非虚拟网卡的地址；
// 全部命中虚拟网卡（VPN/虚拟机/WSL/Docker 等）时退回任一非内部地址，再无则 127.0.0.1
const VIRTUAL_NIC_KEYWORDS = [
  "virtual", "vmware", "virtualbox", "hyper-v", "vethernet", "wsl", "docker",
  "tap-", "tun", "loopback", "bluetooth", "npcap", "zerotier", "tailscale",
];
export function localIPv4() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) {
        candidates.push({ name: name.toLowerCase(), address: net.address });
      }
    }
  }
  const physical = candidates.filter((c) => !VIRTUAL_NIC_KEYWORDS.some((k) => c.name.includes(k)));
  const pick = physical.length > 0 ? physical[0] : candidates[0];
  return pick ? pick.address : "127.0.0.1";
}

export function isHighFreqReadPath(pathname) {
  return HIGH_FREQ_READ_PATHS.has(pathname) || pathname.startsWith("/office-ui/assets/");
}
