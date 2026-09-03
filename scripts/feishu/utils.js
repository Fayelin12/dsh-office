/**
 * utils.js — 通用工具函数模块（飞书消息采集共用）
 *
 * 职责：
 *   - 统一时间戳格式化（东八区 ISO 格式）
 *   - 统一日志输出（INFO / ERROR 级别）
 *   - HTTPS 请求封装（embedding 调用用）
 *   - Float32Array ↔ JSON 序列化（向量写入 sqlite-vec 用）
 */

'use strict';

const https = require('https');

// ===== 时间戳 =====

/**
 * 格式化时间戳为日志用 ISO 字符串（东八区）。
 * @returns {string}
 */
function timestamp() {
  return new Date().toLocaleString('sv', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T') + '+08:00';
}

// ===== 日志输出 =====

/**
 * 统一日志输出（INFO 级别）。
 * @param {string} module - 模块名称
 * @param {string} message - 日志消息
 * @param {object} [fields] - 附加 key=value 字段
 */
function logInfo(module, message, fields) {
  const parts = [`[INFO] [${timestamp()}] [${module}] ${message}`];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      parts.push(`${k}=${v}`);
    }
  }
  console.log(parts.join(' | '));
}

/**
 * 统一日志输出（ERROR 级别）。
 * @param {string} module - 模块名称
 * @param {string} message - 日志消息
 * @param {object} [fields] - 附加 key=value 字段
 */
function logError(module, message, fields) {
  const parts = [`[ERROR] [${timestamp()}] [${module}] ${message}`];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      parts.push(`${k}=${v}`);
    }
  }
  console.error(parts.join(' | '));
}

// ===== HTTPS 工具 =====

/**
 * 通用 HTTPS 请求封装。
 * @param {object} options
 * @param {string} options.hostname
 * @param {string} options.path
 * @param {string} options.method
 * @param {object} [options.headers]
 * @param {string} [options.body]
 * @param {number} [options.timeout=30000]
 * @returns {Promise<object>} 解析后的 JSON 响应
 */
function httpsRequest(options) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: options.hostname,
      path: options.path,
      method: options.method,
      headers: options.headers,
      timeout: options.timeout || 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        // 非 2xx 状态码：直接报错（附带状态码和路径，方便定位）
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode} | ${options.method} ${options.path} | body=${data.substring(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON 解析失败 | HTTP ${res.statusCode} | ${options.method} ${options.path} | data=${data.substring(0, 150)}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`请求超时 | ${options.method} ${options.path}`)); });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ===== 向量序列化 =====

/**
 * Float32Array → JSON 数组字符串。
 * 用于 sqlite-vec 向量写入（vec0 虚拟表要求向量以 JSON 数组字符串格式传入）。
 *
 * @param {Float32Array} arr - 浮点向量
 * @returns {string} JSON 数组字符串，如 '[-0.200, 0.250, ...]'
 */
function float32ToJson(arr) {
  if (!arr || arr.length === 0) return '[]';
  // 手动拼接避免 JSON.stringify 对 Float32Array 的遍历开销和精度差异
  let result = '[';
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) result += ', ';
    result += arr[i];
  }
  result += ']';
  return result;
}

module.exports = { timestamp, logInfo, logError, httpsRequest, float32ToJson };
