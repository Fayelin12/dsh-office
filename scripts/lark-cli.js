'use strict';

/**
 * lark-cli.js — 调用 lark-cli 的公共封装（供 scripts/ 下各开箱示例脚本共用）
 *
 * 导出：
 *   resolveRunJs()        → lark-cli run.js 绝对路径（env LARK_CLI_RUN_JS 优先，兜底探测全局安装位置）
 *   lark(args, opts)      → spawn node run.js，返回解析后的 JSON（成功/业务错误均解析 stdout/stderr JSON）
 *   parseStr(argv, n, fb) → 命令行字符串参数解析
 *   mapLarkError(res)     → 把 lark-cli 错误输出映射为 { code, message }
 *   fail(code, msg)       → 输出单行 JSON 错误并退出
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ---- 配置区（按需修改） ----
// lark-cli 的 Node 入口。全局安装后可用 `npm prefix -g` 查到：
//   Windows: C:\Users\<你>\AppData\Roaming\npm\node_modules\@larksuite\cli\scripts\run.js
//   macOS/Linux: /usr/local/lib/node_modules/@larksuite/cli/scripts/run.js
const LARK_CLI_RUN_JS = process.env.LARK_CLI_RUN_JS || '';
// profile 名：与 `lark-cli auth login --profile <名>` 一致；各脚本也可用 --profile 参数覆盖
export const PROFILE = process.env.LARK_PROFILE || 'default';

export function resolveRunJs() {
  if (LARK_CLI_RUN_JS && existsSync(LARK_CLI_RUN_JS)) return LARK_CLI_RUN_JS;
  // 兜底：尝试常见全局安装位置
  const candidates = [];
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'));
  // 自定义 npm 全局 prefix（如 nvm / `npm --prefix` 安装；本机 lark-cli 装在 D:\npm-global，与飞书项目 lark-cli.js 的 RUN_JS 保持一致）
  candidates.push(join('D:', 'npm-global', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'));
  if (process.env.npm_config_prefix) candidates.push(join(process.env.npm_config_prefix, 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'));
  if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js'));
  if (process.platform !== 'win32') {
    candidates.push('/usr/local/lib/node_modules/@larksuite/cli/scripts/run.js');
    candidates.push('/usr/lib/node_modules/@larksuite/cli/scripts/run.js');
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return '';
}

export function lark(args, opts = {}) {
  const runJs = resolveRunJs();
  if (!runJs) return Promise.reject(new Error('未找到 lark-cli（@larksuite/cli）。请先全局安装：npm install -g @larksuite/cli'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runJs, ...args], { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      // lark-cli 成功 JSON 走 stdout；错误 JSON 走 stderr（缺 scope / 无权限等业务错误 exit 非 0）
      const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
      const parsed = tryParse(out) || tryParse(err);
      if (parsed) { resolve(parsed); return; }
      if (code === 0) { resolve(out); return; }
      reject(new Error('lark-cli exit ' + code + ': ' + (err || out).slice(0, 400)));
    });
    child.on('error', reject);
  });
}

export function parseStr(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return String(argv[i + 1]).trim();
  return fallback;
}

export function fail(code, msg) {
  console.log(JSON.stringify({ ok: false, error: { code, message: msg } }));
  process.exit(1);
}

// 从 lark-cli 错误输出映射语义化错误码
// 两种错误形态：顶层 error 对象（authorization / permission_denied 等），
// 或 minutes +detail 的 data.minutes[].error 字符串（如 "No read permission for minute ..."）
export function mapLarkError(res) {
  if (!res || typeof res !== 'object') return { code: 'LARK_ERROR', message: 'lark-cli 调用失败' };
  const err = res.error;
  if (err && typeof err === 'object') {
    const type = err.type || '';
    const subtype = err.subtype || '';
    const message = err.message || (err.hint || 'lark-cli 调用失败');
    if (type === 'authorization') return { code: 'AUTH_REQUIRED', message };
    if (subtype === 'permission_denied') return { code: 'NO_PERMISSION', message };
    return { code: 'LARK_ERROR', message };
  }
  const mErr = res.data && Array.isArray(res.data.minutes) && res.data.minutes[0] && res.data.minutes[0].error;
  if (typeof mErr === 'string' && mErr) {
    return /permission/i.test(mErr) ? { code: 'NO_PERMISSION', message: mErr } : { code: 'LARK_ERROR', message: mErr };
  }
  return { code: 'LARK_ERROR', message: 'lark-cli 调用失败' };
}
