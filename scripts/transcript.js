'use strict';

/**
 * transcript.js — 拉取妙记逐字稿（供 DSH 办公室插件「逐字稿已生成 + 保存」使用）
 *
 * 用法：node transcript.js --minute-token <token> [--title "会议标题"] [--out-dir <目录>] [--profile NAME]
 *   --minute-token  妙记 token（必填；从妙记 URL 末尾或会议 minute_token 取）
 *   --title         会议标题（可选；用于文件名，默认 "无标题"）
 *   --out-dir       逐字稿输出目录（默认 ./transcripts，目录不存在会自动创建）
 *   --profile       lark-cli profile 名（授权时用的 --profile），默认读 env LARK_PROFILE 或 'default'
 *
 * 输出：单行 JSON（stdout 只有这一行 JSON）：
 *   { ok: true, file, title, chars, lines }
 *     file：逐字稿本地文件绝对路径（{out-dir}/{日期}-{清洗后标题}-{token}.txt）
 *     chars / lines：逐字稿字符数 / 行数
 *   失败时：{ ok: false, error: { code, message } }
 *     code：AUTH_REQUIRED（lark-cli 未授权）| NO_PERMISSION（无妙记查看权限）
 *           | LARK_ERROR（lark-cli 调用失败）
 *
 * 依赖：全局安装 @larksuite/cli 并完成用户授权（含 minutes:minutes.basic:read scope）。
 * 本文件为开箱示例：lark-cli 调用封装共用 scripts/lark-cli.js（与 permission.js 同源）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILE, fail, lark, mapLarkError, parseStr } from './lark-cli.js';

// 输出目录缺省值（可用 --out-dir 覆盖）
const DEFAULT_OUT_DIR = join(process.cwd(), 'transcripts');
// 文件名标题最长长度（超长截断，避免文件名过长）
const TITLE_MAX_LENGTH = 60;

// 清洗标题为合法文件名：去 Windows 非法字符与首尾空白，超长截断；空结果回退"无标题"
function sanitizeTitle(title) {
  const cleaned = String(title || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '无标题';
  return cleaned.length > TITLE_MAX_LENGTH ? cleaned.slice(0, TITLE_MAX_LENGTH) : cleaned;
}

// 在目录下递归查找第一个 transcript.txt（lark-cli 产物文件名固定）
function findTranscriptFile(dir) {
  if (!existsSync(dir)) return '';
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      const found = findTranscriptFile(full);
      if (found) return found;
    } else if (entry === 'transcript.txt') {
      return full;
    }
  }
  return '';
}

async function main() {
  const argv = process.argv.slice(2);
  const token = parseStr(argv, '--minute-token', '');
  const title = parseStr(argv, '--title', '无标题');
  const outDir = parseStr(argv, '--out-dir', DEFAULT_OUT_DIR);
  const profile = parseStr(argv, '--profile', PROFILE);

  if (!token) return fail('INVALID_ARGS', '缺少必填参数 --minute-token');

  mkdirSync(outDir, { recursive: true });
  // lark-cli 的 --output-dir 只接受相对路径，故 spawn 时以 outDir 为 cwd，传相对临时子目录名；
  // lark-cli 会写成 <outDir>/.tmp-<token>/artifact-{title}-{token}/transcript.txt，之后统一命名迁移
  const tmpRel = '.tmp-' + token;
  const tmpDir = join(outDir, tmpRel);

  let res;
  try {
    res = await lark(['--profile', profile, 'minutes', '+detail', '--minute-tokens', token,
      '--transcript', '--output-dir', tmpRel, '--format', 'json'], { cwd: outDir });
  } catch (e) {
    return fail('LARK_ERROR', e && e.message ? e.message : String(e));
  }

  if (!res || res.ok !== true) {
    const mapped = mapLarkError(res);
    // 清理残留临时目录（权限类错误时 lark-cli 可能已创建目录）
    rmSync(tmpDir, { recursive: true, force: true });
    return fail(mapped.code, mapped.message);
  }

  // lark-cli 成功但未产出文件（如妙记产物为空）也视为失败，可重试
  const srcFile = findTranscriptFile(tmpDir);
  if (!srcFile) {
    rmSync(tmpDir, { recursive: true, force: true });
    return fail('LARK_ERROR', 'lark-cli 未产出逐字稿文件（妙记可能仍在生成中，请稍后重试）');
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  const target = join(outDir, date + '-' + sanitizeTitle(title) + '-' + token + '.txt');

  try {
    renameSync(srcFile, target);
    rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    return fail('LARK_ERROR', '逐字稿文件落盘失败: ' + (e && e.message ? e.message : String(e)));
  }

  const content = readFileSync(target, 'utf8');
  const lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  console.log(JSON.stringify({ ok: true, file: target, title, chars: content.length, lines }));
  process.exit(0);
}

main().catch((e) => {
  fail('LARK_ERROR', 'transcript 脚本异常: ' + (e && e.message ? e.message : String(e)));
});
