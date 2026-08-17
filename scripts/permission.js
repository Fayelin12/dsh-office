'use strict';

/**
 * permission.js — 申请妙记查看权限（供 DSH 办公室插件会议卡片「申请权限」按钮使用）
 *
 * 用法：node permission.js --minute-token <token> [--profile NAME]
 *   --minute-token  妙记 token（必填）
 *   --profile       lark-cli profile 名（授权时用的 --profile），默认读 env LARK_PROFILE 或 'default'
 *
 * 输出：单行 JSON（stdout 只有这一行 JSON）：
 *   { ok: true, minute_token }            申请已发出（等待妙记 owner 批准）
 *   { ok: false, error: { code, message } }
 *     code：AUTH_REQUIRED（lark-cli 未授权）| NO_PERMISSION | LARK_ERROR | INVALID_ARGS
 *
 * 依赖：全局安装 @larksuite/cli 并完成用户授权（含 minutes:permission:apply scope）。
 * 本文件为开箱示例：lark-cli 调用封装共用 scripts/lark-cli.js（与 transcript.js 同源）。
 */

import { PROFILE, fail, lark, mapLarkError, parseStr } from './lark-cli.js';

async function main() {
  const argv = process.argv.slice(2);
  const token = parseStr(argv, '--minute-token', '');
  const profile = parseStr(argv, '--profile', PROFILE);

  if (!token) return fail('INVALID_ARGS', '缺少必填参数 --minute-token');

  let res;
  try {
    res = await lark(['--profile', profile, 'minutes', '+apply-permission',
      '--minute-token', token, '--perm', 'view', '--as', 'user', '--format', 'json']);
  } catch (e) {
    return fail('LARK_ERROR', e && e.message ? e.message : String(e));
  }

  if (!res || res.ok !== true) {
    const mapped = mapLarkError(res);
    return fail(mapped.code, mapped.message);
  }
  console.log(JSON.stringify({ ok: true, minute_token: token }));
  process.exit(0);
}

main().catch((e) => {
  fail('LARK_ERROR', 'permission 脚本异常: ' + (e && e.message ? e.message : String(e)));
});
