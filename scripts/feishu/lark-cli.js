'use strict';

/**
 * lark-cli.js — 调用 lark-cli 的封装（spawn node + run.js，返回解析后的 JSON）
 *
 * run.js 路径探测：优先 env LARK_CLI_RUN_JS，否则按常见全局安装位置探测
 *（与 lib/lark.js 的 resolveLarkCliRunJs 同逻辑，不含本机私有路径）。
 */

const { spawn } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

// lark-cli 的 Node 入口：优先读 env LARK_CLI_RUN_JS，否则探测常见全局安装位置
function resolveRunJs() {
  if (process.env.LARK_CLI_RUN_JS && existsSync(process.env.LARK_CLI_RUN_JS)) return process.env.LARK_CLI_RUN_JS;
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

function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['OPENCLAW_STATE_DIR', 'OPENCLAW_WEB_SEARCH_PROVIDER', 'OPENCLAW_HOME', 'HERMES_HOME', 'OPENCLAW_CONFIG_PATH']) {
    delete env[k];
  }
  return env;
}

/**
 * 执行 lark-cli 命令，返回解析后的 JSON（或原始字符串）。
 * @param {string[]} args - 命令参数（不含 node/run.js）
 */
function run(args) {
  return new Promise((resolve, reject) => {
    const runJs = resolveRunJs();
    if (!runJs) {
      reject(new Error('未找到 lark-cli（@larksuite/cli）。请先全局安装：npm install -g @larksuite/cli'));
      return;
    }
    const child = spawn(process.execPath, [runJs, ...args], { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      if (code === 0) {
        try { resolve(JSON.parse(out)); } catch { resolve(out); }
      } else {
        reject(new Error(`lark-cli exit ${code}: ${(err || out).slice(0, 400)}`));
      }
    });
    child.on('error', reject);
  });
}

module.exports = { run };
