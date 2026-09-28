import express from 'express';
import fs from 'fs';
import https from 'https';
import { normalizeCnpj, isCnpjFormatValid } from '../utils/cnpj';
import { TLSSocket } from 'tls';
import { MockSefazService } from './mockSefazService';
import { MockProvider } from './fixtures';

const app = express();
const service = new MockSefazService();
const port = Number(process.env.MOCK_SEFAZ_PORT || 3400);

app.use(express.text({ type: ['application/xml', 'text/xml', 'text/plain'], limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

function extractTag(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i'));
  return match?.[1]?.trim();
}

function providerFromParam(value: string): MockProvider | null {
  const normalized = value.toUpperCase();
  return normalized === 'NFE' || normalized === 'CTE' || normalized === 'MDFE'
    ? normalized
    : null;
}

app.get('/health', (_req, res) => {
  return res.json({
    status: 'ONLINE',
    service: 'ARCKATECH Mock SEFAZ',
    environment: 'HOMOLOGACAO',
    timestamp: new Date().toISOString()
  });
});

app.post('/distribution/:provider', (req, res) => {
  const provider = providerFromParam(req.params.provider);
  if (!provider) {
    return res.status(400).json({ status: 'erro', mensagem: 'provider deve ser NFE, CTE ou MDFE.' });
  }

  const rawBody = typeof req.body === 'string' ? req.body : '';
  const cnpj =
    extractTag(rawBody, 'CNPJ') ||
    (typeof req.body === 'object' ? String(req.body.cnpj || '') : '');
  const ultNsu =
    extractTag(rawBody, 'ultNSU') ||
    (typeof req.body === 'object' ? String(req.body.ult_nsu || '0') : '0');

  if (!isCnpjFormatValid(cnpj)) {
    return res.status(400).json({ status: 'erro', mensagem: 'CNPJ inválido no pedido de distribuição.' });
  }

  // No modo rápido, o header simula a identidade do certificado do cliente. Quando o Mock
  // for executado atrás de mTLS, o proxy/agente poderá preencher a mesma identidade a partir
  // do certificado apresentado, sem alterar o contrato de distribuição.
  const tlsSocket = req.socket as TLSSocket;
  const peerCertificate =
    typeof tlsSocket.getPeerCertificate === 'function' ? tlsSocket.getPeerCertificate() : undefined;
  const certificateCnpjFromTls = peerCertificate?.subject?.CN
    ? normalizeCnpj(peerCertificate.subject.CN)
    : '';
  const certificateCnpjFromHeader = normalizeCnpj(req.headers['x-mock-certificate-cnpj'] || '');
  const certificateCnpj = certificateCnpjFromTls || certificateCnpjFromHeader;

  if (certificateCnpj && certificateCnpj !== normalizeCnpj(cnpj)) {
    return res.status(403).type('application/xml').send(
      '<?xml version="1.0"?><retDistDFeInt><cStat>280</cStat><xMotivo>Certificado nao pertence ao CNPJ consultado</xMotivo></retDistDFeInt>'
    );
  }

  const forced = req.headers['x-mock-scenario'];
  const forceScenario =
    forced === '137' || forced === '138' || forced === '656'
      ? forced
      : undefined;

  const result = service.distribute({
    provider,
    cnpj,
    ult_nsu: ultNsu,
    force_scenario: forceScenario
  });

  return res.status(result.httpStatus).type('application/xml').send(result.xml);
});

app.post('/admin/reset', (_req, res) => {
  service.reset();
  return res.json({ status: 'sucesso' });
});

const tlsKey = process.env.MOCK_SEFAZ_TLS_KEY;
const tlsCert = process.env.MOCK_SEFAZ_TLS_CERT;
const tlsCa = process.env.MOCK_SEFAZ_TLS_CA;

if (tlsKey && tlsCert && tlsCa) {
  https
    .createServer(
      {
        key: fs.readFileSync(tlsKey),
        cert: fs.readFileSync(tlsCert),
        ca: fs.readFileSync(tlsCa),
        requestCert: true,
        rejectUnauthorized: true
      },
      app
    )
    .listen(port, () => {
      console.log(`ARCKATECH Mock SEFAZ mTLS rodando em https://localhost:${port}`);
      console.log('Providers: NFE, CTE, MDFE');
    });
} else {
  app.listen(port, () => {
    console.log(`ARCKATECH Mock SEFAZ rodando em http://localhost:${port}`);
    console.log('mTLS desativado; use x-mock-certificate-cnpj para simular a identidade do certificado.');
    console.log('Providers: NFE, CTE, MDFE');
  });
}
