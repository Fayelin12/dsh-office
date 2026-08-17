'use strict';

/**
 * calendar.js — 拉取我的会议日程（供 DSH 办公室插件「📅 会议」视图 + ⏰ 提醒使用）
 *
 * 用法：node calendar.js [--days N] [--since "YYYY-MM-DD"] [--history N] [--profile NAME]
 *   --days N     向前拉取的天数（含今天），默认 7，最大 30
 *   --since      起始日期（YYYY-MM-DD），默认今天
 *   --history N  额外拉取「已开完」的历史会议天数（默认 7；用于展示妙记/纪要入口）
 *   --profile    lark-cli profile 名（授权时用的 --profile），默认读 env LARK_PROFILE 或 'default'
 *
 * 输出：单行 JSON（stdout 只有这一行 JSON）：
 *   { ok: true, since, days, historyDays,
 *     events: [{ event_id, summary, start_ts, end_ts, start, end,
 *                meeting_url, app_link, organizer, rsvp, busy,
 *                meeting_id, meeting_note, note_doc_token, minute_token }] }
 *   start/end 为本地时间 'YYYY-MM-DD HH:MM'（与消息 created_at 同风格，可直接比较）
 *   meeting_id：视频会议 ID（已开过视频会议的日程才有）
 *   meeting_note：用户手动绑定到日程的纪要文档 token（可选）
 *   note_doc_token / minute_token：AI 智能纪要 / 妙记 token（需 vc scope 授权）
 *   失败时：{ ok: false, error }
 *
 * 依赖：全局安装 @larksuite/cli 并完成用户授权（见 docs/feishu-setup.md）。
 * 本文件为开箱示例：自带 lark-cli spawn 封装，不依赖本地其它文件。
 */

const { spawn } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

// ---- 配置区（按需修改） ----
// lark-cli 的 Node 入口。全局安装后可用 `npm prefix -g` 查到：
//   Windows: C:\Users\<你>\AppData\Roaming\npm\node_modules\@larksuite\cli\scripts\run.js
//   macOS/Linux: /usr/local/lib/node_modules/@larksuite/cli/scripts/run.js
const LARK_CLI_RUN_JS = process.env.LARK_CLI_RUN_JS || '';
// profile 名：与 `lark-cli auth login --profile <名>` 一致；也可用 --profile 参数覆盖
const PROFILE = process.env.LARK_PROFILE || 'default';

function resolveRunJs() {
  if (LARK_CLI_RUN_JS && existsSync(LARK_CLI_RUN_JS)) return LARK_CLI_RUN_JS;
  // 兜底：尝试常见全局安装位置
  const candidates = [];
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'));
  if (process.env.npm_config_prefix) candidates.push(join(process.env.npm_config_prefix, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'));
  if (process.platform !== 'win32') {
    candidates.push('/usr/local/lib/node_modules/@larksuite/cli/scripts/run.js');
    candidates.push('/usr/lib/node_modules/@larksuite/cli/scripts/run.js');
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return '';
}

function lark(args) {
  const runJs = resolveRunJs();
  if (!runJs) return Promise.reject(new Error('未找到 lark-cli（@larksuite/cli）。请先全局安装：npm install -g @larksuite/cli'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runJs, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      if (code === 0) { try { resolve(JSON.parse(out)); } catch { resolve(out); } }
      else reject(new Error('lark-cli exit ' + code + ': ' + (err || out).slice(0, 400)));
    });
    child.on('error', reject);
  });
}

function parseArg(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) {
    const n = parseInt(argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 30);
  }
  return fallback;
}

function parseStr(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return String(argv[i + 1]).trim();
  return fallback;
}

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

// ISO 8601（含时区）→ 本地 'YYYY-MM-DD HH:MM'；解析失败返回 null
function toLocalLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 批量查询日程 → meeting_id / meeting_note（calendar +meeting，最多 50 个一批）
async function fetchMeetingIds(profile, events) {
  const ids = events.map((e) => e.event_id).filter(Boolean);
  const out = new Map();
  const BATCH = 50;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    try {
      const res = await lark(['--profile', profile, 'calendar', '+meeting', '--event-ids', batch.join(','), '--format', 'json']);
      const meetings = (res && res.ok && res.data && res.data.meetings) || [];
      for (const m of meetings) {
        if (m && m.event_id) out.set(m.event_id, { meeting_id: m.meeting_id || '', meeting_note: m.meeting_note || '' });
      }
    } catch (e) { /* 单批失败不致命 */ }
  }
  return out;
}

// 批量查询会议 → note_id / minute_token（vc +detail，需要 vc:meeting.meetingevent:read scope）
async function fetchVcDetails(profile, meetingIds) {
  const out = new Map();
  const ids = [...new Set(meetingIds.filter(Boolean))];
  const BATCH = 50;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    try {
      const res = await lark(['--profile', profile, 'vc', '+detail', '--meeting-ids', batch.join(','), '--format', 'json']);
      const meetings = (res && res.ok && res.data && res.data.meetings) || [];
      for (const m of meetings) {
        if (m && m.meeting_id) out.set(String(m.meeting_id), { note_id: (m.note && m.note.note_id) || '', minute_token: m.minute_token || '' });
      }
    } catch (e) { /* 无 vc scope 或失败：跳过 */ }
  }
  return out;
}

// note_id → 纪要文档 token（note +detail）
async function fetchNoteTokens(profile, noteIds) {
  const out = new Map();
  const ids = [...new Set(noteIds.filter(Boolean))];
  for (const id of ids) {
    try {
      const res = await lark(['--profile', profile, 'note', '+detail', '--note-id', id, '--format', 'json']);
      const d = res && res.ok && res.data;
      if (d) out.set(id, { note_doc_token: d.note_doc_token || '', verbatim_doc_token: d.verbatim_doc_token || '' });
    } catch (e) { /* 单个失败跳过 */ }
  }
  return out;
}

function normalizeEvents(raw) {
  return raw.map((e) => {
    const startIso = e.start_time && e.start_time.datetime;
    const endIso = e.end_time && e.end_time.datetime;
    return {
      event_id: e.event_id || '',
      summary: e.summary || '（无标题）',
      start_ts: startIso ? new Date(startIso).getTime() : null,
      end_ts: endIso ? new Date(endIso).getTime() : null,
      start: toLocalLabel(startIso),
      end: toLocalLabel(endIso),
      meeting_url: (e.vchat && e.vchat.meeting_url) || '',
      app_link: e.app_link || '',
      organizer: (e.event_organizer && e.event_organizer.display_name) || '',
      rsvp: e.self_rsvp_status || '',
      busy: e.free_busy_status || 'busy',
    };
  }).sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0));
}

async function main() {
  const argv = process.argv.slice(2);
  const days = parseArg(argv, '--days', 7);
  const historyDays = parseArg(argv, '--history', 7);
  const since = parseStr(argv, '--since', new Date().toISOString().slice(0, 10));
  const profile = parseStr(argv, '--profile', PROFILE);

  const startDate = new Date(since + 'T00:00:00');
  if (isNaN(startDate.getTime())) return fail('无效起始日期: ' + since);
  startDate.setDate(startDate.getDate() - historyDays);
  const endDate = new Date(since + 'T00:00:00');
  endDate.setDate(endDate.getDate() + days);

  const res = await lark(['--profile', profile, 'calendar', '+agenda', '--as', 'user',
    '--start', startDate.toISOString().slice(0, 10), '--end', endDate.toISOString().slice(0, 10), '--format', 'json']);
  if (!res || !res.ok) {
    const msg = res && res.error && (res.error.message || res.error.hint);
    return fail(msg || 'lark-cli calendar 调用失败（请确认已安装并授权 @larksuite/cli）');
  }
  const raw = (res.data && Array.isArray(res.data) ? res.data : []);
  const events = normalizeEvents(raw);
  const now = Date.now();

  const pastEvents = events.filter((e) => e.end_ts != null && e.end_ts < now);
  const futureEvents = events.filter((e) => !(e.end_ts != null && e.end_ts < now));

  if (pastEvents.length) {
    const meetingMap = await fetchMeetingIds(profile, pastEvents);
    const meetingIds = pastEvents.map((e) => (meetingMap.get(e.event_id) || {}).meeting_id || '').filter(Boolean);
    const vcMap = meetingIds.length ? await fetchVcDetails(profile, meetingIds) : new Map();
    const noteIds = [...vcMap.values()].map((v) => v.note_id || '').filter(Boolean);
    const noteMap = noteIds.length ? await fetchNoteTokens(profile, noteIds) : new Map();

    for (const e of pastEvents) {
      const m = meetingMap.get(e.event_id) || {};
      e.meeting_id = m.meeting_id || '';
      e.meeting_note = m.meeting_note || '';
      const vc = vcMap.get(String(m.meeting_id)) || {};
      const nt = noteMap.get(vc.note_id) || {};
      e.note_doc_token = nt.note_doc_token || '';
      e.verbatim_doc_token = nt.verbatim_doc_token || '';
      e.minute_token = vc.minute_token || '';
    }
  }

  const all = [...futureEvents, ...pastEvents].sort((a, b) => (a.start_ts || 0) - (b.start_ts || 0));
  console.log(JSON.stringify({
    ok: true, since, days, historyDays, total: all.length,
    events: all,
    hasMinutes: all.filter((e) => e.meeting_note || e.note_doc_token || e.minute_token).length,
  }));
  process.exit(0);
}

main().catch((e) => {
  fail('lark-cli 调用异常: ' + (e && e.message ? e.message : String(e)));
});
