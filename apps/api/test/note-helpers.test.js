'use strict';

// 纯逻辑测试：不依赖真实 Redis，覆盖输入校验、TTL 解析与展示格式。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ValidationError,
  resolveTtl,
  normalizeText,
  isValidId,
  noteKey,
  safeParseNote,
  formatRemaining,
  withTtl,
  MAX_TITLE,
  MAX_BODY,
} = require('../lib/note-helpers');

test('resolveTtl memetakan semua pilihan TTL ke milidetik', () => {
  assert.equal(resolveTtl('1m'), 60_000);
  assert.equal(resolveTtl('5m'), 300_000);
  assert.equal(resolveTtl('1h'), 3_600_000);
  assert.equal(resolveTtl('1d'), 86_400_000);
  assert.equal(resolveTtl('permanent'), null);
  assert.equal(resolveTtl('PERMANENT'), null);
  assert.equal(resolveTtl('permanen'), null);
  assert.equal(resolveTtl(' 1h '), 3_600_000);
});

test('resolveTtl menganggap nilai kosong sebagai permanen', () => {
  assert.equal(resolveTtl(undefined), null);
  assert.equal(resolveTtl(null), null);
  assert.equal(resolveTtl(''), null);
});

test('resolveTtl menolak nilai yang tidak dikenal', () => {
  for (const bad of ['2m', '1w', 'abc', 60, {}, '10s']) {
    assert.throws(() => resolveTtl(bad), (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.status, 400);
      assert.match(error.message, /TTL/);
      return true;
    });
  }
});

test('normalizeText memangkas spasi dan menolak input tidak valid', () => {
  assert.equal(normalizeText('  Halo dunia  ', 'Judul'), 'Halo dunia');

  assert.throws(() => normalizeText('', 'Judul'), ValidationError);
  assert.throws(() => normalizeText('   ', 'Judul'), ValidationError);
  assert.throws(() => normalizeText(42, 'Judul'), ValidationError);
  assert.throws(() => normalizeText('x'.repeat(MAX_TITLE + 1), 'Judul'), ValidationError);
  assert.equal(normalizeText('x'.repeat(MAX_TITLE), 'Judul').length, MAX_TITLE);
});

test('normalizeText mengizinkan isi kosong bila tidak wajib', () => {
  assert.equal(normalizeText(undefined, 'Isi', { required: false }), '');
  assert.equal(normalizeText(null, 'Isi', { required: false }), '');
  assert.equal(normalizeText('', 'Isi', { required: false }), '');
  assert.throws(
    () => normalizeText('y'.repeat(MAX_BODY + 1), 'Isi', { required: false }),
    ValidationError
  );
});

test('isValidId hanya menerima id aman', () => {
  assert.equal(isValidId('9f1c2b3a-4d5e-6f70-8192-a3b4c5d6e7f8'), true);
  assert.equal(isValidId('abc_123-XYZ'), true);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId('ada spasi'), false);
  assert.equal(isValidId('catatan:*'), false);
  assert.equal(isValidId('x'.repeat(129)), false);
  assert.equal(isValidId(123), false);
  assert.equal(isValidId(null), false);
});

test('noteKey memakai prefix yang konsisten', () => {
  assert.equal(noteKey('abc'), 'halloworld:note:abc');
});

test('safeParseNote menolak data rusak tanpa melempar error', () => {
  const note = { id: 'abc', title: 'Judul', body: 'Isi', createdAt: '2026-01-01T00:00:00.000Z' };
  const parsed = safeParseNote(JSON.stringify(note));
  assert.deepEqual(parsed, {
    id: 'abc',
    title: 'Judul',
    body: 'Isi',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(safeParseNote('bukan json'), null);
  assert.equal(safeParseNote(''), null);
  assert.equal(safeParseNote(null), null);
  assert.equal(safeParseNote(undefined), null);
  assert.equal(safeParseNote('{"title":"tanpa id"}'), null);
  assert.equal(safeParseNote('null'), null);
});

test('formatRemaining menghasilkan teks Indonesia yang ringkas', () => {
  assert.equal(formatRemaining(null), 'permanen');
  assert.equal(formatRemaining(undefined), 'permanen');
  assert.equal(formatRemaining(0), 'kedaluwarsa');
  assert.equal(formatRemaining(-5), 'kedaluwarsa');
  assert.equal(formatRemaining(1_000), '1 detik');
  assert.equal(formatRemaining(60_000), '1 menit');
  assert.equal(formatRemaining(90_000), '1 menit 30 detik');
  assert.equal(formatRemaining(86_400_000 + 3_600_000 + 60_000), '1 hari 1 jam 1 menit');
});

test('withTtl membentuk objek ttl untuk permanen dan sementara', () => {
  const note = { id: 'abc', title: 'T', body: 'B', createdAt: 'x' };

  const permanent = withTtl(note, -1);
  assert.equal(permanent.ttl.permanent, true);
  assert.equal(permanent.ttl.remainingMs, null);
  assert.equal(permanent.ttl.remainingText, 'permanen');

  const temporary = withTtl(note, 5_000);
  assert.equal(temporary.ttl.permanent, false);
  assert.equal(temporary.ttl.remainingMs, 5_000);
  assert.equal(temporary.ttl.remainingText, '5 detik');

  assert.equal(withTtl(note, undefined).ttl.permanent, true);
});
