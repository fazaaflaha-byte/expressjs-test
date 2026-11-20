'use strict';

// 纯函数工具：输入校验、TTL 解析、键名生成与展示格式。
// 这个文件不接触 Redis，方便单元测试。

const NOTE_PREFIX = 'halloworld:note:';
const MAX_TITLE = 200;
const MAX_BODY = 20_000;

// 页面提供的 TTL 选项：1 分钟、5 分钟、1 小时、1 天或永久。
// 值 null 表示不设置过期时间。
const TTL_OPTIONS = Object.freeze({
  '1m': 60_000,
  '5m': 5 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  permanent: null,
});

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

// 把前端的 TTL 选择转换成毫秒；永久或空值返回 null。
function resolveTtl(value) {
  if (value === undefined || value === null || value === '') return null;

  const key = String(value).trim().toLowerCase();
  if (key === 'permanent' || key === 'permanen' || key === 'never') return null;

  if (!Object.prototype.hasOwnProperty.call(TTL_OPTIONS, key)) {
    throw new ValidationError(
      `TTL tidak valid: "${value}". Pilihan: 1m, 5m, 1h, 1d, permanent`
    );
  }

  return TTL_OPTIONS[key];
}

// 校验并规范化文本字段。required=false 时允许空字符串。
function normalizeText(value, field, { required = true, max = MAX_TITLE } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} wajib diisi`);
    return '';
  }

  if (typeof value !== 'string') {
    throw new ValidationError(`${field} harus berupa teks`);
  }

  const text = value.trim();
  if (required && text === '') throw new ValidationError(`${field} tidak boleh kosong`);
  if (text.length > max) throw new ValidationError(`${field} maksimal ${max} karakter`);

  return text;
}

// 只允许字母、数字、下划线和连字符，避免把任意字符串拼进 Redis key。
function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

function noteKey(id) {
  return `${NOTE_PREFIX}${id}`;
}

// 解析 Redis 中存的 JSON；数据损坏时返回 null 而不是抛错。
function safeParseNote(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || typeof data.id !== 'string') return null;

    return {
      id: data.id,
      title: typeof data.title === 'string' ? data.title : String(data.title ?? ''),
      body: typeof data.body === 'string' ? data.body : String(data.body ?? ''),
      createdAt: data.createdAt || null,
      updatedAt: data.updatedAt || data.createdAt || null,
    };
  } catch {
    return null;
  }
}

// 把剩余毫秒数变成 "1 hari 2 jam 3 menit 4 detik" 这样的印尼语文本。
function formatRemaining(ms) {
  if (ms === null || ms === undefined) return 'permanen';
  if (!Number.isFinite(ms) || ms <= 0) return 'kedaluwarsa';

  let rest = Math.ceil(ms / 1000);
  const parts = [];
  const units = [
    ['hari', 86_400],
    ['jam', 3_600],
    ['menit', 60],
    ['detik', 1],
  ];

  for (const [label, size] of units) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count} ${label}`);
      rest -= count * size;
    }
  }

  return parts.join(' ');
}

// 给笔记对象附加 TTL 信息。ttlMs=-1 表示 Redis 中的键没有过期时间。
function withTtl(note, ttlMs) {
  const permanent = ttlMs === null || ttlMs === undefined || ttlMs === -1;
  const remainingMs = permanent ? null : Math.max(0, Number(ttlMs));

  return {
    ...note,
    ttl: {
      permanent,
      remainingMs,
      remainingText: formatRemaining(remainingMs),
    },
  };
}

module.exports = {
  NOTE_PREFIX,
  MAX_TITLE,
  MAX_BODY,
  TTL_OPTIONS,
  ValidationError,
  resolveTtl,
  normalizeText,
  isValidId,
  noteKey,
  safeParseNote,
  formatRemaining,
  withTtl,
};
