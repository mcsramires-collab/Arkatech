import zlib from 'zlib';
import { normalizeCnpj } from '../utils/cnpj';
import { MOCK_DOCUMENTS, MockDfeDocument, MockProvider } from './fixtures';

export interface MockDistributionRequest {
  provider: MockProvider;
  cnpj: string;
  ult_nsu: string;
  force_scenario?: '137' | '138' | '656';
}

interface ConsumerState {
  expectedUltNsu: string;
  noDocumentsAt?: number;
  blockedUntil?: number;
}

export interface MockDistributionResponse {
  httpStatus: number;
  cStat: 137 | 138 | 656;
  xMotivo: string;
  ultNSU: string;
  maxNSU: string;
  documents: MockDfeDocument[];
  xml: string;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_BATCH = 50;

function formatNsu(value: number | string): string {
  return String(value).replace(/\D/g, '').padStart(15, '0');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export class MockSefazService {
  private states = new Map<string, ConsumerState>();

  reset(): void {
    this.states.clear();
  }

  private key(provider: MockProvider, cnpj: string): string {
    return `${provider}:${normalizeCnpj(cnpj)}`;
  }

  private buildXml(params: {
    cStat: 137 | 138 | 656;
    xMotivo: string;
    ultNSU: string;
    maxNSU: string;
    documents: MockDfeDocument[];
  }): string {
    const docZip = params.documents
      .map((doc) => {
        const compressed = zlib.gzipSync(Buffer.from(doc.xml, 'utf8')).toString('base64');
        return `<docZip NSU="${formatNsu(doc.nsu)}" schema="${escapeXml(doc.schema)}">${compressed}</docZip>`;
      })
      .join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<retDistDFeInt versao="1.01">
  <tpAmb>2</tpAmb>
  <verAplic>ARCKATECH-MOCK-1.0</verAplic>
  <cStat>${params.cStat}</cStat>
  <xMotivo>${escapeXml(params.xMotivo)}</xMotivo>
  <dhResp>${new Date().toISOString()}</dhResp>
  <ultNSU>${params.ultNSU}</ultNSU>
  <maxNSU>${params.maxNSU}</maxNSU>
  <loteDistDFeInt>${docZip}</loteDistDFeInt>
</retDistDFeInt>`;
  }

  distribute(input: MockDistributionRequest, now = Date.now()): MockDistributionResponse {
    const cnpj = normalizeCnpj(input.cnpj);
    const docs = MOCK_DOCUMENTS[input.provider] ?? [];
    const maxNsuNumber = docs.reduce((max, doc) => Math.max(max, doc.nsu), 0);
    const maxNSU = formatNsu(maxNsuNumber);
    const requestedUlt = formatNsu(input.ult_nsu || '0');
    const key = this.key(input.provider, cnpj);
    const state = this.states.get(key) ?? { expectedUltNsu: formatNsu(0) };

    const response = (
      cStat: 137 | 138 | 656,
      xMotivo: string,
      ultNSU: string,
      documents: MockDfeDocument[]
    ): MockDistributionResponse => ({
      httpStatus: 200,
      cStat,
      xMotivo,
      ultNSU,
      maxNSU,
      documents,
      xml: this.buildXml({ cStat, xMotivo, ultNSU, maxNSU, documents })
    });

    if (input.force_scenario === '656') {
      state.blockedUntil = now + ONE_HOUR_MS;
      this.states.set(key, state);
      return response(656, 'Rejeicao: Consumo Indevido. Tente apos 1 hora', state.expectedUltNsu, []);
    }

    if (state.blockedUntil && now < state.blockedUntil) {
      return response(656, 'Rejeicao: Consumo Indevido. CNPJ temporariamente bloqueado', state.expectedUltNsu, []);
    }

    if (state.noDocumentsAt && now - state.noDocumentsAt < ONE_HOUR_MS) {
      state.blockedUntil = state.noDocumentsAt + ONE_HOUR_MS;
      this.states.set(key, state);
      return response(656, 'Rejeicao: Consumo Indevido. Deve ser aguardado 1 hora apos cStat 137', state.expectedUltNsu, []);
    }

    if (requestedUlt !== state.expectedUltNsu) {
      state.blockedUntil = now + ONE_HOUR_MS;
      this.states.set(key, state);
      return response(656, 'Rejeicao: Consumo Indevido. Deve ser utilizado o ultNSU retornado anteriormente', state.expectedUltNsu, []);
    }

    if (input.force_scenario === '137') {
      state.noDocumentsAt = now;
      this.states.set(key, state);
      return response(137, 'Nenhum documento localizado', state.expectedUltNsu, []);
    }

    const requestedNumber = Number(requestedUlt);
    const available = docs.filter((doc) => doc.nsu > requestedNumber).slice(0, MAX_BATCH);

    if (available.length === 0 && input.force_scenario !== '138') {
      state.noDocumentsAt = now;
      this.states.set(key, state);
      return response(137, 'Nenhum documento localizado', state.expectedUltNsu, []);
    }

    const selected =
      input.force_scenario === '138' && available.length === 0
        ? docs.slice(0, Math.min(MAX_BATCH, docs.length))
        : available;

    const lastNsu = selected.length > 0 ? selected[selected.length - 1]!.nsu : requestedNumber;
    const ultNSU = formatNsu(lastNsu);

    state.expectedUltNsu = ultNSU;
    state.noDocumentsAt = undefined;
    state.blockedUntil = undefined;
    this.states.set(key, state);

    return response(138, 'Documentos localizados', ultNSU, selected);
  }
}
