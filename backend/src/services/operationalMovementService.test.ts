import { dbStore } from './dbStore';
import { OperationalMovementService } from './operationalMovementService';

const cte = (numero: string, ufIni: string, ufFim: string, produto: string, cnpj: string) => `<?xml version="1.0" encoding="UTF-8"?>
<CTe>
  <infCte Id="CTe352609123456780001905700100000${numero.padStart(6, '0')}1100000000">
    <ide><cUF>35</cUF><nCT>${numero}</nCT><serie>1</serie><dhEmi>2026-09-30T14:00:00-03:00</dhEmi><UFIni>${ufIni}</UFIni><UFFim>${ufFim}</UFFim><tpAmb>2</tpAmb></ide>
    <emit><CNPJ>${cnpj}</CNPJ></emit>
    <rem><CNPJ>11111111000191</CNPJ></rem>
    <dest><CNPJ>22222222000192</CNPJ></dest>
    <vPrest><vRec>1200.00</vRec></vPrest>
    <infCTeNorm><infCarga><vCarga>1200.00</vCarga><proPred>${produto}</proPred></infCarga></infCTeNorm>
    <compl><xObs>DATA_EMBARQUE=30/09/2026</xObs></compl>
  </infCte>
</CTe>`;

describe('OperationalMovementService', () => {
  test('monta movimentação a partir do XML real e isola seguradoras', async () => {
    await dbStore.runTestLabEphemeral(() => {
      dbStore.tenants = [
        { id: 'tenant-a', cnpj: '12345678000190', razao_social: 'Transportadora A', nome_fantasia: 'TA', status: 'ATIVO', ambiente: 'teste', client_id: 'a', client_secret_hash: 'a', role: 'TRANSPORTADOR', token_duration_hours: 8, created_at: new Date().toISOString() },
        { id: 'tenant-b', cnpj: '98765432000110', razao_social: 'Transportadora B', status: 'ATIVO', ambiente: 'teste', client_id: 'b', client_secret_hash: 'b', role: 'TRANSPORTADOR', token_duration_hours: 8, created_at: new Date().toISOString() }
      ] as any;
      dbStore.policies = [
        { id: 'policy-a', numero_apolice: 'POL-A', ramo: 'RCTRC', tenant_id: 'tenant-a', insurer_id: 'insurer-a', broker_id: 'broker-a', status: 'ATIVA', permitir_inativo_vencido: false, vigencia_inicio: '2026-01-01', vigencia_fim: '2027-01-01', aceita_averbacao_como_destinatario: false },
        { id: 'policy-b', numero_apolice: 'POL-B', ramo: 'RCTRC', tenant_id: 'tenant-b', insurer_id: 'insurer-b', broker_id: 'broker-b', status: 'ATIVA', permitir_inativo_vencido: false, vigencia_inicio: '2026-01-01', vigencia_fim: '2027-01-01', aceita_averbacao_como_destinatario: false }
      ] as any;
      dbStore.rawXmlStore = [
        { id: 'raw-a', tenant_id: 'tenant-a', content_xml: cte('101', 'SP', 'RJ', 'Eletrônicos', '12345678000190'), hash_sha256: 'a', encrypted_aes256: false, created_at: new Date().toISOString() },
        { id: 'raw-b', tenant_id: 'tenant-b', content_xml: cte('202', 'MG', 'PR', 'Alimentos', '98765432000110'), hash_sha256: 'b', encrypted_aes256: false, created_at: new Date().toISOString() }
      ] as any;
      dbStore.averbacoes = [
        { id: 'avb-a', protocolo_interno_averbacao: 'PI-A', numero_averbacao: 'AVB-A', tenant_id: 'tenant-a', policy_id: 'policy-a', status: 'SUCESSO', codigo_resposta: 'SUC-2000', mensagem_resposta: 'ok', valor_carga: 1200, valor_considerado_averbacao: 1200, regras_internas_aplicadas: [], tp_amb_sefaz: 2, tipo_documento: 'CTE', chave_documento: 'KEY-A', numero_documento: '101', raw_xml_id: 'raw-a', ambiente: 'teste', timestamp: '2026-09-30T17:01:00.000Z', created_at: '2026-09-30T17:01:00.000Z' },
        { id: 'avb-b', protocolo_interno_averbacao: 'PI-B', numero_averbacao: 'AVB-B', tenant_id: 'tenant-b', policy_id: 'policy-b', status: 'SUCESSO', codigo_resposta: 'SUC-2000', mensagem_resposta: 'ok', valor_carga: 1200, valor_considerado_averbacao: 1200, regras_internas_aplicadas: [], tp_amb_sefaz: 2, tipo_documento: 'CTE', chave_documento: 'KEY-B', numero_documento: '202', raw_xml_id: 'raw-b', ambiente: 'teste', timestamp: '2026-09-30T17:01:00.000Z', created_at: '2026-09-30T17:01:00.000Z' }
      ] as any;
      dbStore.fiscalDocuments = [
        { id: 'doc-a', tenant_id: 'tenant-a', source: 'TMS', capture_mode: 'INTEGRATION', status: 'AVERBADO', content_hash_sha256: 'a', raw_xml_id: 'raw-a', tipo_documento: 'CTE', chave_documento: 'KEY-A', policy_ids_attempted: ['policy-a'], averbacao_ids: ['avb-a'], received_at: '2026-09-30T17:00:00.000Z' },
        { id: 'doc-b', tenant_id: 'tenant-b', source: 'SEFAZ', capture_mode: 'DISTRIBUTION', status: 'AVERBADO', content_hash_sha256: 'b', raw_xml_id: 'raw-b', tipo_documento: 'CTE', chave_documento: 'KEY-B', policy_ids_attempted: ['policy-b'], averbacao_ids: ['avb-b'], received_at: '2026-09-30T17:00:00.000Z' }
      ] as any;

      const result = OperationalMovementService.listForInsurer('insurer-a');
      expect(result.summary.total).toBe(1);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
        tenant_id: 'tenant-a',
        segurado_nome: 'TA',
        uf_origem: 'SP',
        uf_destino: 'RJ',
        produto_predominante: 'Eletrônicos',
        data_embarque: '30/09/2026',
        source: 'TMS',
        status: 'AVERBADO'
      });
      expect(result.rows[0]?.tenant_id).not.toBe('tenant-b');
    });
  });
});
