require('dotenv').config();

const express = require('express');
const compression = require('compression');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3000;
const APP_NAME = process.env.APP_NAME || 'Halloworld';
const APP_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = APP_ENV === 'production';

// Root directory untuk file statis, bisa diatur lewat STATIC_ROOT.
// Absolute path (/x/b, C:\x\b) dipakai apa adanya,
// relative path dihitung dari folder tempat index.js berada.
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

app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
  console.log(`Mode: ${APP_ENV}${IS_PRODUCTION ? ' (production)' : ''}`);
});
