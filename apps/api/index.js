const path = require('path');

// .env tinggal di root project (dua level di atas apps/api), bukan di folder ini.
// Tanpa path eksplisit, dotenv akan mencari berdasarkan process.cwd() dan gagal
// menemukannya ketika server dijalankan dari apps/api.
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const express = require('express');
const compression = require('compression');

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

// Log request disimpan in-memory dengan batas ukuran, supaya memori tidak
// tumbuh terus selama proses hidup. Bukan pengganti logging permanen —
// isinya hilang setiap kali proses restart.
const MAX_LOGS = 200;
const requestLogs = [];

function recordLog(entry) {
  requestLogs.push(entry);
  if (requestLogs.length > MAX_LOGS) {
    requestLogs.shift();
  }
}

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    recordLog({
      time: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(1)),
      ip: req.ip,
    });
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

// Health check untuk monitoring / load balancer
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

// Endpoint log request. Endpoint ini sendiri tidak ikut dicatat, supaya
// polling dari halaman tidak memenuhi buffer dengan dirinya sendiri.
// Dibandingkan dengan startsWith agar "/api/logs?limit=10" juga terlewati.
function isLogEndpoint(pathValue) {
  return pathValue.startsWith('/api/logs');
}

app.get('/api/logs', (req, res) => {
  res.set('Cache-Control', 'no-store');

  const limit = Math.min(Number(req.query.limit) || MAX_LOGS, MAX_LOGS);
  const entries = requestLogs.filter((entry) => !isLogEndpoint(entry.path));

  res.json({
    total: entries.length,
    max: MAX_LOGS,
    logs: entries.slice(-limit).reverse(),
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Server berjalan di http://${HOST}:${PORT}`);
  console.log(`Mode: ${APP_ENV}${IS_PRODUCTION ? ' (production)' : ''}`);
});
