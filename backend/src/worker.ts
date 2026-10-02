import dotenv from 'dotenv';

dotenv.config();

const API_BASE_URL = (process.env.ARCKATECH_API_BASE_URL || 'http://localhost:3000/api/v1').replace(/\/$/, '');
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || '';
const POLL_MS = Math.max(1000, Number(process.env.INSURER_DISPATCH_POLL_MS || 5000));
const BATCH_LIMIT = Math.max(1, Math.min(Number(process.env.INSURER_DISPATCH_BATCH_LIMIT || 20), 100));

let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!INTERNAL_API_KEY) {
      console.error('[worker] INTERNAL_API_KEY não configurada; despacho de seguradora não pode ser processado.');
      return;
    }

    const response = await fetch(`${API_BASE_URL}/internal/insurer-dispatches/process`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-internal-api-key': INTERNAL_API_KEY
      },
      body: JSON.stringify({ limit: BATCH_LIMIT })
    });

    const body = await response.text();
    if (!response.ok) {
      console.error(`[worker] API respondeu HTTP ${response.status}: ${body}`);
      return;
    }

    try {
      const parsed = JSON.parse(body) as { processed?: number; confirmed?: number; retried?: number; failed?: number; blocked?: number };
      if ((parsed.processed || 0) > 0) {
        console.log(
          `[worker] insurer-dispatch processed=${parsed.processed || 0} confirmed=${parsed.confirmed || 0} retried=${parsed.retried || 0} failed=${parsed.failed || 0} blocked=${parsed.blocked || 0}`
        );
      }
    } catch {
      console.log(`[worker] insurer-dispatch: ${body}`);
    }
  } catch (error) {
    console.error('[worker] Falha ao chamar processador de despacho:', error);
  } finally {
    running = false;
  }
}

console.log(`[worker] iniciado; API=${API_BASE_URL}; intervalo=${POLL_MS}ms; lote=${BATCH_LIMIT}`);
void tick();
const timer = setInterval(() => void tick(), POLL_MS);
timer.unref?.();

process.on('SIGTERM', () => {
  clearInterval(timer);
  process.exit(0);
});
process.on('SIGINT', () => {
  clearInterval(timer);
  process.exit(0);
});
