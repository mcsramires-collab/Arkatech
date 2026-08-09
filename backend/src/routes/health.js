const express = require('express');
const { Pool } = require('pg');
const Redis = require('ioredis');

const router = express.Router();

router.get('/', async (_req, res) => {
  const status = { api: 'ok', database: 'unknown', redis: 'unknown' };

  try {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query('SELECT 1');
    await pool.end();
    status.database = 'ok';
  } catch (err) {
    status.database = `erro: ${err.message}`;
  }

  try {
    const redis = new Redis({
      host: process.env.REDIS_HOST,
      port: process.env.REDIS_PORT,
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await redis.connect();
    await redis.ping();
    redis.disconnect();
    status.redis = 'ok';
  } catch (err) {
    status.redis = `erro: ${err.message}`;
  }

  const allOk = status.database === 'ok' && status.redis === 'ok';
  res.status(allOk ? 200 : 503).json(status);
});

module.exports = router;
