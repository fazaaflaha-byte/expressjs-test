'use strict';

// /api/redis 路由：连接状态 + 笔记 CRUD。
// 所有数据都存在 Redis 中，没有引入其他数据库。

const express = require('express');
const store = require('../lib/redis-store');

const router = express.Router();

// API 不走缓存
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// 连接状态：Connected/Disconnected、PING 结果与响应延迟
router.get('/status', async (_req, res) => {
  res.json(await store.getStatus());
});

// 读取全部笔记（含创建时间和剩余 TTL）
router.get('/notes', async (_req, res) => {
  res.json(await store.listNotes());
});

// 新建笔记：标题、内容、可选 TTL
router.post('/notes', async (req, res) => {
  const note = await store.createNote(req.body || {});
  res.status(201).json({ note });
});

// 修改笔记的标题和内容（保留原有剩余 TTL）
router.put('/notes/:id', async (req, res) => {
  const note = await store.updateNote(req.params.id, req.body || {});
  res.json({ note });
});

// 删除笔记
router.delete('/notes/:id', async (req, res) => {
  await store.deleteNote(req.params.id);
  res.json({ ok: true, id: req.params.id });
});

// 统一错误格式：400 校验失败、404 不存在、503 Redis 不可用、其余 500
router.use((error, _req, res, _next) => {
  const status = Number(error.status) || 500;
  if (status >= 500) {
    console.error('[redis-api]', error);
  }
  res.status(status).json({
    error: status === 500 ? 'Terjadi kesalahan di server' : error.message,
    ...(status === 500 ? {} : { code: error.name }),
  });
});

module.exports = router;
