import fs from 'fs';
import http from 'http';
import https from 'https';
import zlib from 'zlib';
import { XMLParser } from 'fast-xml-parser';
import { normalizeCnpj } from '../src/utils/cnpj';

type Provider = 'NFE' | 'CTE' | 'MDFE';

interface HttpResult {
  statusCode: number;
  body: string;
}

interface RequestTlsOptions {
  pfx?: Buffer;
  passphrase?: string;
  ca?: Buffer;
}

function request(
  method: string,
  target: string,
  headers: Record<string, string>,
  body?: string,
  tls?: RequestTlsOptions
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const isHttps = url.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          ...headers,
          ...(body ? { 'content-length': Buffer.byteLength(body).toString() } : {})
        },
        ...(isHttps && tls
          ? {
              pfx: tls.pfx,
              passphrase: tls.passphrase,
              ca: tls.ca,
              rejectUnauthorized: true
            }
          : {})
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  return value;
}

function addOneHour(): string {
  return new Date(Date.now() + 60 * 60 * 1000).toISOString();
}

function extractDocZip(parsed: any): Array<{ nsu: string; xml: string }> {
  const raw = parsed?.retDistDFeInt?.loteDistDFeInt?.docZip;
  if (!raw) return [];

  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((item: any) => {
    const base64 = typeof item === 'string' ? item : item['#text'];
    if (!base64) throw new Error('docZip sem conteudo Base64.');
    return {
      nsu: String(item?.['@_NSU'] ?? ''),
      xml: zlib.gunzipSync(Buffer.from(String(base64), 'base64')).toString('utf8')
    };
  });
}

async function main() {
  const apiUrl = required('ARCKATECH_API_URL').replace(/\/$/, '');
  const connectorToken = required('CONNECTOR_TOKEN');
  const mockUrl = (process.env.MOCK_SEFAZ_URL || 'http://localhost:3400').replace(/\/$/, '');
  const cnpj = normalizeCnpj(process.env.MOCK_CNPJ || '12345678000190');

  const pfxPath = process.env.MOCK_CLIENT_PFX_PATH;
  const caPath = process.env.MOCK_SEFAZ_CA_PATH;
  const tls: RequestTlsOptions | undefined =
    pfxPath
      ? {
          pfx: fs.readFileSync(pfxPath),
          passphrase: process.env.MOCK_CLIENT_PFX_PASSWORD,
          ca: caPath ? fs.readFileSync(caPath) : undefined
        }
      : undefined;

  const authHeaders = {
    authorization: `Bearer ${connectorToken}`,
    accept: 'application/json'
  };

  const configResponse = await request(
    'GET',
    `${apiUrl}/api/v1/connector/sync-config`,
    authHeaders
  );
  if (configResponse.statusCode !== 200) {
    throw new Error(`Falha ao obter sync-config: HTTP ${configResponse.statusCode} - ${configResponse.body}`);
  }

  const config = JSON.parse(configResponse.body);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true
  });

  const enabledProviders: Provider[] = (['NFE', 'CTE', 'MDFE'] as Provider[]).filter(
    (provider) => config.providers?.[provider.toLowerCase()] === true
  );

  for (const provider of enabledProviders) {
    const ultNsu = config.sync_state?.[provider]?.ult_nsu || '000000000000000';
    const requestXml = `<?xml version="1.0" encoding="UTF-8"?>
<distDFeInt versao="1.01">
  <tpAmb>2</tpAmb>
  <CNPJ>${cnpj}</CNPJ>
  <distNSU><ultNSU>${ultNsu}</ultNSU></distNSU>
</distDFeInt>`;

    const mockHeaders: Record<string, string> = {
      'content-type': 'application/xml',
      accept: 'application/xml'
    };
    if (!tls) mockHeaders['x-mock-certificate-cnpj'] = cnpj;

    const distribution = await request(
      'POST',
      `${mockUrl}/distribution/${provider}`,
      mockHeaders,
      requestXml,
      tls
    );

    if (distribution.statusCode !== 200) {
      throw new Error(`${provider}: Mock SEFAZ HTTP ${distribution.statusCode} - ${distribution.body}`);
    }

    const parsed = parser.parse(distribution.body);
    const ret = parsed.retDistDFeInt;
    const cStat = Number(ret?.cStat);
    const xMotivo = String(ret?.xMotivo || '');
    const returnedUltNsu = String(ret?.ultNSU || ultNsu);
    const maxNsu = String(ret?.maxNSU || returnedUltNsu);
    const docs = extractDocZip(parsed);

    let processedCount = 0;

    if (cStat === 138 && docs.length > 0) {
      const ingestionPayload = JSON.stringify({
        provider,
        documents: docs
      });

      const ingestion = await request(
        'POST',
        `${apiUrl}/api/v1/connector/fiscal-documents`,
        { ...authHeaders, 'content-type': 'application/json' },
        ingestionPayload
      );

      if (ingestion.statusCode !== 200) {
        throw new Error(`${provider}: falha ao enviar documentos: HTTP ${ingestion.statusCode} - ${ingestion.body}`);
      }

      const ingestionBody = JSON.parse(ingestion.body);
      processedCount = Number(ingestionBody.processed || 0);
    }

    const syncStatus =
      cStat === 138
        ? 'OK'
        : cStat === 137
          ? 'NO_DOCUMENTS'
          : cStat === 656
            ? 'RATE_LIMITED'
            : 'ERROR';

    const syncPayload = JSON.stringify({
      provider,
      status: syncStatus,
      ult_nsu: returnedUltNsu,
      max_nsu: maxNsu,
      cstat: cStat,
      message: xMotivo,
      document_count: docs.length,
      ...(cStat === 137 || cStat === 656 ? { next_sync_after: addOneHour() } : {})
    });

    const syncResult = await request(
      'POST',
      `${apiUrl}/api/v1/connector/sync-result`,
      { ...authHeaders, 'content-type': 'application/json' },
      syncPayload
    );

    if (syncResult.statusCode !== 200) {
      throw new Error(`${provider}: falha ao salvar sync-result: HTTP ${syncResult.statusCode} - ${syncResult.body}`);
    }

    console.log(
      `[${provider}] cStat=${cStat} docs=${docs.length} processados=${processedCount} ultNSU=${returnedUltNsu} maxNSU=${maxNsu}`
    );
  }
}

main().catch((error) => {
  console.error('[mock-connector-e2e]', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
