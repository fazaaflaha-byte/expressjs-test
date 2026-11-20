'use strict';

// Redis 存储层：只使用 Redis 一个数据源，不引入其他数据库。
// 连接管理带自动重连；Redis 不可用时接口返回 503，而不是让进程崩溃。

const crypto = require('crypto');
const { createClient } = require('redis');

const {
  ValidationError,
  resolveTtl,
  normalizeText,
  isValidId,
  noteKey,
  safeParseNote,
  withTtl,
  MAX_BODY,
} = require('./note-helpers');

// 变量名同时兼容 REDIS_URL 与用户要求的 redisurl。
const REDIS_URL = String(process.env.REDIS_URL || process.env.redisurl || '').trim();

const RECONNECT_DELAY_MS = 5_000;
const WATCHDOG_INTERVAL_MS = 5_000;
const CONNECT_TIMEOUT_MS = 5_000;
const PING_TIMEOUT_MS = 2_000;
const SCAN_BATCH = 100;

let client = null;
let starting = false;
let retryTimer = null;
let watchdogTimer = null;
let lastError = null;

class NotFoundError extends Error {
  constructor(message = 'Catatan tidak ditemukan') {
    super(message);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

class ServiceUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ServiceUnavailableError';
    this.status = 503;
  }
}

function log(...args) {
  console.log('[redis]', ...args);
}

// 某些底层错误（如 AggregateError）没有 message，需要回退到 code/name。
function describeError(error) {
  if (!error) return 'belum terhubung ke Redis';
  return error.message || error.code || error.name || 'koneksi Redis gagal';
}

function scheduleRetry() {
  if (retryTimer || !REDIS_URL) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    start();
  }, RECONNECT_DELAY_MS);
  if (typeof retryTimer.unref === 'function') retryTimer.unref();
}

function createRedisClient() {
  const c = createClient({
    url: REDIS_URL,
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      // 先自行重试几次，全部失败后交给我们安排下一轮重连。
      reconnectStrategy: (retries) => (retries >= 3 ? false : Math.min(200 * 2 ** retries, 2_000)),
    },
  });

  c.on('error', (error) => {
    lastError = error;
  });

  c.on('ready', () => {
    lastError = null;
    log('terhubung ke Redis');
  });

  // node-redis 在重连策略放弃时只发出 'terminated'（不发 'end'），
  // 两个事件都要处理，否则客户端终止后永远不会重建。
  c.on('terminated', (cause) => {
    if (cause instanceof Error && (cause.message || cause.code)) lastError = cause;
    if (client === c) {
      client = null;
      try {
        c.destroy();
      } catch {
        // 已经关闭，忽略
      }
      scheduleRetry();
    }
  });

  c.on('end', () => {
    if (client === c) {
      client = null;
      scheduleRetry();
    }
  });

  return c;
}

// 看门狗：每 5 秒确认一次，任何事件遗漏导致的“卡死”都会被自动修复。
function ensureConnection() {
  if (!REDIS_URL || starting) return;
  if (client && client.isReady) return;

  if (client) {
    // 仍在库内部重连中，先不打扰
    if (client.isOpen) return;
    const dead = client;
    client = null;
    try {
      dead.destroy();
    } catch {
      // 忽略
    }
  }

  start();
}

function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(ensureConnection, WATCHDOG_INTERVAL_MS);
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
}

// 启动连接（幂等）：启动时调用一次，失败后每 5 秒自动重试。
function start() {
  if (!REDIS_URL) {
    log('REDIS_URL belum diset di .env, fitur catatan dinonaktifkan');
    return;
  }
  startWatchdog();
  if (starting || (client && client.isOpen)) return;

  starting = true;
  const c = createRedisClient();
  client = c;

  c.connect()
    .catch((error) => {
      lastError = error;
      if (client === c) client = null;
      log('gagal menyambung:', error.message, `— coba lagi dalam ${RECONNECT_DELAY_MS / 1000}dtk`);
      c.disconnect().catch(() => {});
      scheduleRetry();
    })
    .finally(() => {
      starting = false;
    });
}

async function stop() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  if (client) {
    const c = client;
    client = null;
    try {
      await c.quit();
    } catch {
      await c.disconnect().catch(() => {});
    }
  }
}

function readyClient() {
  if (!REDIS_URL) {
    throw new ServiceUnavailableError('REDIS_URL belum diset di .env');
  }
  if (!client || !client.isReady) {
    throw new ServiceUnavailableError(`Redis tidak tersedia: ${describeError(lastError)}`);
  }
  return client;
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 隐藏密码，避免把凭据回显到前端或日志里。
function maskUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(format URL tidak valid)';
  }
}

async function getStatus() {
  const configured = Boolean(REDIS_URL);
  const connected = Boolean(client && client.isReady);

  let ping = null;
  let latencyMs = null;
  let error = null;

  if (!configured) {
    error = 'REDIS_URL belum diset di .env';
  } else if (!connected) {
    error = describeError(lastError);
  } else {
    const startedAt = process.hrtime.bigint();
    try {
      await withTimeout(client.ping(), PING_TIMEOUT_MS, 'PING timeout');
      latencyMs = Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 100) / 100;
      ping = 'PONG';
    } catch (err) {
      error = err.message;
    }
  }

  return {
    configured,
    connected,
    ping,
    latencyMs,
    error,
    url: maskUrl(REDIS_URL),
    checkedAt: new Date().toISOString(),
  };
}

async function scanNoteKeys(c) {
  const keys = [];
  let cursor = '0';

  do {
    const reply = await c.scan(cursor, { MATCH: `${noteKey('')}*`, COUNT: SCAN_BATCH });
    cursor = String(reply.cursor);
    keys.push(...reply.keys);
  } while (cursor !== '0');

  return keys;
}

async function listNotes() {
  const c = readyClient();
  const keys = await scanNoteKeys(c);
  if (keys.length === 0) return { total: 0, notes: [] };

  // 一次 pipeline 读取所有 key 的 TTL 和内容，减少往返次数。
  const multi = c.multi();
  for (const key of keys) multi.pTTL(key);
  for (const key of keys) multi.get(key);
  const replies = await multi.exec();

  const notes = [];
  for (let i = 0; i < keys.length; i += 1) {
    const ttlMs = Number(replies[i]);
    const raw = replies[keys.length + i];

    // -2 表示扫描之后 key 已经过期；损坏的 JSON 直接跳过。
    if (ttlMs === -2 || raw === null || raw === undefined) continue;
    const note = safeParseNote(raw);
    if (!note) continue;

    notes.push(withTtl(note, ttlMs));
  }

  notes.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return { total: notes.length, notes };
}

async function createNote(input = {}) {
  const title = normalizeText(input.title, 'Judul');
  const body = normalizeText(input.body, 'Isi catatan', { required: false, max: MAX_BODY });
  const ttlMs = resolveTtl(input.ttl);

  const c = readyClient();
  const now = new Date().toISOString();
  const note = { id: crypto.randomUUID(), title, body, createdAt: now, updatedAt: now };

  const key = noteKey(note.id);
  if (ttlMs === null) {
    await c.set(key, JSON.stringify(note));
  } else {
    await c.set(key, JSON.stringify(note), { expiration: { type: 'PX', value: ttlMs } });
  }

  return withTtl(note, ttlMs === null ? -1 : ttlMs);
}

async function updateNote(id, input = {}) {
  if (!isValidId(id)) throw new ValidationError('ID catatan tidak valid');

  const c = readyClient();
  const key = noteKey(id);
  const raw = await c.get(key);
  if (!raw) throw new NotFoundError();

  const existing = safeParseNote(raw);
  if (!existing) throw new NotFoundError();

  const title =
    input.title === undefined ? existing.title : normalizeText(input.title, 'Judul');
  const body =
    input.body === undefined
      ? existing.body
      : normalizeText(input.body, 'Isi catatan', { required: false, max: MAX_BODY });

  const updated = { ...existing, id, title, body, updatedAt: new Date().toISOString() };

  // XX：只有 key 仍然存在才写入；KEEPTTL：保留原有的剩余过期时间。
  const result = await c.set(key, JSON.stringify(updated), {
    condition: 'XX',
    expiration: 'KEEPTTL',
  });
  if (result === null) throw new NotFoundError();

  const ttlMs = Number(await c.pTTL(key));
  return withTtl(updated, ttlMs === -2 ? -1 : ttlMs);
}

async function deleteNote(id) {
  if (!isValidId(id)) throw new ValidationError('ID catatan tidak valid');

  const c = readyClient();
  const removed = await c.del(noteKey(id));
  if (removed === 0) throw new NotFoundError();
  return { id };
}

module.exports = {
  start,
  stop,
  getStatus,
  listNotes,
  createNote,
  updateNote,
  deleteNote,
  NotFoundError,
  ServiceUnavailableError,
};
