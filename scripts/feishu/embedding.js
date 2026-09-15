/**
 * embedding.js — 向量嵌入服务封装（OpenAI 兼容 API）
 *
 * 职责：
 *   - 封装 OpenAI 兼容的 Embedding API
 *   - 提供 embed(text) → Float32Array 统一接口
 *   - 未来切换到其它模型只需改环境变量（EMBEDDING_*），接口不变
 *
 * API 约定：
 *   - embed(text) 返回 Float32Array，维度由配置决定
 *   - 所有 API 调用有超时保护（默认 10 秒）
 *   - 非 429 错误重试 1 次
 *   - 错误信息通过 logError 记录，不抛异常
 *
 * 配置（由 ingestor.js 从环境变量读取后经 init 传入；字段均可选，缺省走默认值）：
 *   - apiKey     EMBEDDING_API_KEY（空 = 不向量化，ingestor 会跳过调用）
 *   - endpoint   EMBEDDING_ENDPOINT
 *   - model      EMBEDDING_MODEL
 *   - dimensions EMBEDDING_DIMENSIONS
 */

'use strict';

const { logInfo, logError, httpsRequest } = require('./utils.js');

// ===== 默认值（与 feishu-config 的 embedding 段默认一致） =====
const DEFAULT_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings';
const DEFAULT_MODEL = 'qwen3.7-text-embedding';
const DEFAULT_DIMENSIONS = 1024;
const DEFAULT_TIMEOUT_MS = 10000;

// ===== 内部状态 =====

/** embedding 配置引用 */
let config = null;

// ===== 公开接口 =====

/**
 * 初始化嵌入服务。
 *
 * @param {object} cfg - embedding 配置
 * @param {string} cfg.apiKey - API Key（空 = 不向量化）
 * @param {string} [cfg.endpoint] - OpenAI 兼容 endpoint
 * @param {string} [cfg.model] - 模型名
 * @param {number} [cfg.dimensions] - 向量维度
 */
function init(cfg) {
  config = cfg;
  logInfo('embedding', `嵌入服务初始化 | model=${cfg.model || DEFAULT_MODEL} dimensions=${cfg.dimensions || DEFAULT_DIMENSIONS}`);
}

/**
 * 将文本转为向量。
 *
 * @param {string} text - 待嵌入的文本
 * @returns {Promise<Float32Array>} 浮点向量，维度由配置决定
 */
async function embed(text) {
  if (!config) {
    logError('embedding', '嵌入服务未初始化');
    return new Float32Array(0);
  }

  if (!text || text.trim().length === 0) {
    logError('embedding', '嵌入文本为空');
    return new Float32Array(0);
  }

  const endpoint = config.endpoint || DEFAULT_ENDPOINT;
  const model = config.model || DEFAULT_MODEL;
  const dimensions = config.dimensions || DEFAULT_DIMENSIONS;
  const timeoutMs = config.timeout_ms || DEFAULT_TIMEOUT_MS;

  // 解析 endpoint URL 为 hostname + path
  let hostname, path;
  try {
    const urlObj = new URL(endpoint);
    hostname = urlObj.hostname;
    path = urlObj.pathname + (urlObj.search || '');
  } catch (_) {
    logError('embedding', `无效的 endpoint | endpoint=${endpoint}`);
    return new Float32Array(0);
  }

  const body = JSON.stringify({
    model: model,
    input: text,
    dimensions: dimensions,
  });

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey || ''}`,
  };

  // 请求函数（含重试逻辑）
  const doRequest = async (attempt) => {
    try {
      const response = await httpsRequest({
        hostname: hostname,
        path: path,
        method: 'POST',
        headers: headers,
        body: body,
        timeout: timeoutMs,
      });

      // 检查 API 错误
      if (response.error) {
        const errMsg = response.error.message || JSON.stringify(response.error);
        throw new Error(`API 返回错误: ${errMsg}`);
      }

      // 解析 embedding 数据
      if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        throw new Error('API 返回数据为空或格式异常');
      }

      const embArray = response.data[0].embedding;
      if (!embArray || !Array.isArray(embArray)) {
        throw new Error('API 返回的 embedding 数据格式异常');
      }

      return new Float32Array(embArray);
    } catch (err) {
      // 429 不重试，其他错误在 attempt < 2 时重试
      if (err.message.includes('429') || err.message.includes('Too Many Requests')) {
        throw err;
      }
      if (attempt < 2) {
        logInfo('embedding', `嵌入请求失败，准备重试 | attempt=${attempt} error=${err.message}`);
        throw err; // 外层 catch 会执行重试
      }
      throw err;
    }
  };

  // 执行请求（最多 2 次尝试）
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await doRequest(attempt);
    } catch (err) {
      if (attempt < 2 && !err.message.includes('429')) {
        // 非 429 错误，重试
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      logError('embedding', `嵌入请求最终失败 | error=${err.message} text_len=${text.length}`);
      return new Float32Array(0);
    }
  }

  return new Float32Array(0);
}

/**
 * 批量嵌入（减少 API 调用次数）。
 *
 * @param {string[]} texts - 文本数组（最多 20 条）
 * @returns {Promise<Float32Array[]>} 向量数组
 */
async function embedBatch(texts) {
  if (!config) {
    logError('embedding', '嵌入服务未初始化');
    return [];
  }

  if (!texts || texts.length === 0) {
    return [];
  }

  // 限制批量大小，最多 20 条一批
  const batch = texts.slice(0, 20);
  const endpoint = config.endpoint || DEFAULT_ENDPOINT;
  const model = config.model || DEFAULT_MODEL;
  const dimensions = config.dimensions || DEFAULT_DIMENSIONS;
  const timeoutMs = config.timeout_ms || DEFAULT_TIMEOUT_MS;

  // 解析 endpoint URL
  let hostname, path;
  try {
    const urlObj = new URL(endpoint);
    hostname = urlObj.hostname;
    path = urlObj.pathname + (urlObj.search || '');
  } catch (_) {
    logError('embedding', `无效的 endpoint | endpoint=${endpoint}`);
    return [];
  }

  const body = JSON.stringify({
    model: model,
    input: batch,
    dimensions: dimensions,
  });

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey || ''}`,
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await httpsRequest({
        hostname: hostname,
        path: path,
        method: 'POST',
        headers: headers,
        body: body,
        timeout: timeoutMs,
      });

      if (response.error) {
        throw new Error(`API 返回错误: ${response.error.message || JSON.stringify(response.error)}`);
      }

      if (!response.data || !Array.isArray(response.data)) {
        throw new Error('批量 API 返回数据格式异常');
      }

      return response.data.map((item) => {
        if (item.embedding && Array.isArray(item.embedding)) {
          return new Float32Array(item.embedding);
        }
        return new Float32Array(0);
      });
    } catch (err) {
      if (attempt < 2 && !err.message.includes('429')) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      logError('embedding', `批量嵌入请求失败 | error=${err.message} batch_size=${batch.length}`);
      return [];
    }
  }

  return [];
}

/**
 * 获取当前配置的向量维度。
 *
 * @returns {number} 向量维度
 */
function getDimension() {
  return config ? (config.dimensions || DEFAULT_DIMENSIONS) : DEFAULT_DIMENSIONS;
}

module.exports = { init, embed, embedBatch, getDimension };
