require('dotenv').config();
console.log('[arckatech-worker] worker iniciado — aguardando filas BullMQ (placeholder).');

// Placeholder: aqui entrarão os processors do BullMQ
// (rule engine, motor de averbação, batchRunner, etc.)
setInterval(() => {
  console.log('[arckatech-worker] heartbeat', new Date().toISOString());
}, 30000);
