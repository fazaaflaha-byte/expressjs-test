const path = require('path');

// .env tinggal di root project (dua level di atas apps/api), bukan di folder ini.
// Tanpa path eksplisit, dotenv akan mencari berdasarkan process.cwd() dan gagal
// menemukannya ketika server dijalankan dari apps/api.
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const express = require('express');
const compression = require('compression');

const redisStore = require('./lib/redis-store');
const redisNotesRouter = require('./routes/redis-notes');

const app = express();

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const APP_NAME = process.env.APP_NAME || 'Halloworld';
const APP_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = APP_ENV === 'production';

// Root directory untuk file statis, bisa diatur lewat STATIC_ROOT.
// Absolute path dipakai apa adanya; relative path dihitung dari folder index.js,
// sehingga "public" mengarah ke apps/api/public setelah project dipindah.
const STATIC_ROOT = path.resolve(
  __dirname,
  process.env.STATIC_ROOT || 'public'
);

// Di balik reverse proxy (nginx, load balancer, Railway, dsb),
// header X-Forwarded-* perlu dipercaya agar req.ip dan protokol benar.
if (IS_PRODUCTION) {
  app.set('trust proxy', 1);
}

// Sembunyikan header X-Powered-By: Express saat production
app.disable('x-powered-by');
app.set('env', APP_ENV);

// Kompresi gzip untuk semua response
app.use(compression());

// Body parser kecil, hanya dipakai endpoint tombol
app.use(express.json());

// Log setiap request ke terminal.
function timestamp() {
  return new Date().toLocaleTimeString('id-ID', { hour12: false });
}

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    console.log(
      `[${timestamp()}] ${req.method} ${req.originalUrl} ` +
        `→ ${res.statusCode} (${durationMs.toFixed(1)}ms)`
    );
  });

  next();
});

// Cache agresif untuk aset statis saat production, tapi HTML tidak boleh
// di-cache lama — kalau tidak, perubahan halaman tidak pernah sampai ke user.
app.use(
  express.static(STATIC_ROOT, {
    maxAge: IS_PRODUCTION ? '1y' : 0,
    immutable: IS_PRODUCTION,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  })
);

// API selalu no-cache agar konfigurasi terbaru langsung terlihat
app.get('/api/info', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    appName: APP_NAME,
    appEnv: APP_ENV,
    port: Number(PORT),
    nodeVersion: process.version,
    isProduction: IS_PRODUCTION,
  });
});

// 健康检查：同时报告 Redis 是否可用，但 Redis 掉线不会让该接口失败。
app.get('/health', async (_req, res) => {
  const redis = await redisStore.getStatus();
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    redis: { connected: redis.connected, ping: redis.ping },
  });
});

// Redis 笔记功能（连接状态 + CRUD）
app.use('/api/redis', redisNotesRouter);

// Endpoint tombol: satu-satunya tugasnya adalah mencetak baris log
// yang mencolok di terminal server setiap kali tombol ditekan.
app.post('/api/click', (req, res) => {
  res.set('Cache-Control', 'no-store');

  const dari = req.body && req.body.asal ? String(req.body.asal) : 'halaman';
  const jumlah = req.body && Number(req.body.jumlah) ? Number(req.body.jumlah) : 1;

  console.log('');
  console.log('==========================================');
  console.log(`  TOMBOL DITEKAN  (${timestamp()})`);
  console.log(`  Asal   : ${dari}`);
  console.log(`  Klik ke: ${jumlah}`);
  console.log(`  IP     : ${req.ip}`);
  console.log('==========================================');
  console.log('');

  res.json({
    ok: true,
    pesan: 'Klik tercatat di terminal',
    waktu: new Date().toISOString(),
    klikKe: jumlah,
  });
});

// 启动时连接 Redis；连接失败不阻塞服务，后台每 5 秒自动重试
redisStore.start();

const server = app.listen(PORT, HOST, () => {
  console.log(`Server berjalan di http://${HOST}:${PORT}`);
  console.log(`Mode: ${APP_ENV}${IS_PRODUCTION ? ' (production)' : ''}`);
  console.log('Tekan tombol di halaman web untuk melihat log di terminal.');
});

// 优雅退出：关闭 HTTP 服务并断开 Redis
function shutdown(signal) {
  console.log(`\n${signal} diterima, menutup server…`);
  server.close(async () => {
    await redisStore.stop();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
