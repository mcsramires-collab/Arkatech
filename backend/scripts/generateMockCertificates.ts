import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { normalizeCnpj, isCnpjFormatValid } from '../src/utils/cnpj';

const outDir = path.resolve(__dirname, '../.mock-certs');
const cnpj = normalizeCnpj(process.env.MOCK_CERT_CNPJ || '12345678000190');
const password = process.env.MOCK_PFX_PASSWORD || 'arckatech-mock';

if (!isCnpjFormatValid(cnpj)) {
  throw new Error('MOCK_CERT_CNPJ deve conter 14 posições e pode ser alfanumérico nas 12 primeiras.');
}

fs.mkdirSync(outDir, { recursive: true });

function openssl(args: string[]) {
  execFileSync('openssl', args, { stdio: 'inherit' });
}

function file(name: string) {
  return path.join(outDir, name);
}

const caKey = file('dev-ca.key');
const caCrt = file('dev-ca.crt');
const serverKey = file('server.key');
const serverCsr = file('server.csr');
const serverCrt = file('server.crt');
const serverExt = file('server.ext');
const clientKey = file('transportadora-teste.key');
const clientCsr = file('transportadora-teste.csr');
const clientCrt = file('transportadora-teste.crt');
const clientExt = file('client.ext');
const clientPfx = file('transportadora-teste.pfx');

openssl([
  'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', caKey,
  '-out', caCrt,
  '-days', '3650',
  '-sha256',
  '-subj', '/CN=Arckatech Development CA'
]);

openssl([
  'req', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', serverKey,
  '-out', serverCsr,
  '-subj', '/CN=localhost'
]);

fs.writeFileSync(
  serverExt,
  'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n',
  'utf8'
);

openssl([
  'x509', '-req',
  '-in', serverCsr,
  '-CA', caCrt,
  '-CAkey', caKey,
  '-CAcreateserial',
  '-out', serverCrt,
  '-days', '825',
  '-sha256',
  '-extfile', serverExt
]);

openssl([
  'req', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', clientKey,
  '-out', clientCsr,
  '-subj', `/CN=${cnpj}`
]);

fs.writeFileSync(clientExt, 'extendedKeyUsage=clientAuth\n', 'utf8');

openssl([
  'x509', '-req',
  '-in', clientCsr,
  '-CA', caCrt,
  '-CAkey', caKey,
  '-CAcreateserial',
  '-out', clientCrt,
  '-days', '825',
  '-sha256',
  '-extfile', clientExt
]);

openssl([
  'pkcs12', '-export',
  '-out', clientPfx,
  '-inkey', clientKey,
  '-in', clientCrt,
  '-certfile', caCrt,
  '-passout', `pass:${password}`
]);

for (const transient of [serverCsr, serverExt, clientCsr, clientExt, file('dev-ca.srl')]) {
  if (fs.existsSync(transient)) fs.unlinkSync(transient);
}

console.log('\nCertificados MOCK gerados em:', outDir);
console.log('CNPJ do certificado cliente:', cnpj);
console.log('PFX:', clientPfx);
console.log('Senha do PFX:', password);
console.log('\nATENCAO: CA/certificados exclusivos de desenvolvimento. Nao sao ICP-Brasil e nao funcionam no SEFAZ real.');
