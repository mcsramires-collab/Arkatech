import { createHash } from 'crypto';
import { MockGenerationOptions, MockGeneratorService } from './mockGenerator';

/** Stable fixture API. Same seed, date and options always yield the same XML. */
export class TestLabFixtureGenerator {
  constructor(readonly seed = 'arckatech-standard-v1', readonly referenceDate = '2026-09-28T12:00:00.000Z') {
    if (!Number.isFinite(Date.parse(referenceDate))) throw new Error('TEST_LAB_INVALID_REFERENCE_DATE');
  }
  xml(options: MockGenerationOptions, caseKey = 'default'): string {
    const number = 100000 + createHash('sha256').update(this.seed + ':' + caseKey).digest().readUInt32BE(0) % 900000;
    return MockGeneratorService.generateMockXML({
      documentNumber: number, valorCarga: 1000, emissionDate: this.referenceDate,
      tpAmbSefaz: 2, cStatSefaz: '100', incluirProtocoloSefaz: true, ...options
    });
  }
}
