import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import {
  Tenant,
  Insurer,
  Broker,
  Policy,
  PolicyRule,
  ResponseTemplate,
  Averbacao,
  RawXMLStore,
  RecoverySession,
  BatchTestRun
} from '../types';

class DBStore {
  public tenants: Tenant[] = [];
  public insurers: Insurer[] = [];
  public brokers: Broker[] = [];
  public policies: Policy[] = [];
  public policyRules: PolicyRule[] = [];
  public responseTemplates: ResponseTemplate[] = [];
  public averbacoes: Averbacao[] = [];
  public rawXmlStore: RawXMLStore[] = [];
  public recoverySessions: RecoverySession[] = [];
  public batchTestRuns: BatchTestRun[] = [];

  private filePath = path.join(__dirname, '../../data_store.json');

  constructor() {
    this.init();
  }

  private init() {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        this.tenants = parsed.tenants || [];
        this.insurers = parsed.insurers || [];
        this.brokers = parsed.brokers || [];
        this.policies = parsed.policies || [];
        this.policyRules = parsed.policyRules || [];
        this.responseTemplates = parsed.responseTemplates || [];
        this.averbacoes = parsed.averbacoes || [];
        this.rawXmlStore = parsed.rawXmlStore || [];
        this.recoverySessions = parsed.recoverySessions || [];
        this.batchTestRuns = parsed.batchTestRuns || [];
        return;
      } catch (err) {
        console.error('Erro ao ler data_store.json. Inicializando com seeds padrão.', err);
      }
    }

    this.seedDefaultData();
    this.persist();
  }

  public persist() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(
          {
            tenants: this.tenants,
            insurers: this.insurers,
            brokers: this.brokers,
            policies: this.policies,
            policyRules: this.policyRules,
            responseTemplates: this.responseTemplates,
            averbacoes: this.averbacoes,
            rawXmlStore: this.rawXmlStore,
            recoverySessions: this.recoverySessions,
            batchTestRuns: this.batchTestRuns
          },
          null,
          2
        ),
        'utf-8'
      );
    } catch (err) {
      console.error('Erro ao salvar no data_store.json:', err);
    }
  }

  private seedDefaultData() {
    // 1. Templates de Resposta (Configuráveis no banco)
    this.responseTemplates = [
      {
        id: uuidv4(),
        codigo: 'SUC-2000',
        tipo: 'sucesso',
        categoria: 'SYSTEM',
        texto_padrao: 'Averbação realizada com sucesso. Número: [NUMERO_AVERBACAO], Timestamp: [TIMESTAMP].',
        texto_customizado: 'Averbação realizada com sucesso. Número: [NUMERO_AVERBACAO], Timestamp: [TIMESTAMP].',
        placeholders: ['[NUMERO_AVERBACAO]', '[TIMESTAMP]'],
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'SUC-2001',
        tipo: 'aviso',
        categoria: 'APOLICE',
        texto_padrao:
          'Averbação realizada com sucesso [NUMERO_AVERBACAO], número de averbação [NUMERO_AVERBACAO], timestamp [TIMESTAMP] OBS: Seu (cadastro ou apólice) se encuentra inativo, então a sua averbação pode ser negada pela seguradora caso não esteja com a renovação do seu contrato em dia. Antes de seguir viagem, consulte sua seguradora e/ou corretora para validar seu cadastro',
        texto_customizado:
          'Averbação realizada com sucesso [NUMERO_AVERBACAO], número de averbação [NUMERO_AVERBACAO], timestamp [TIMESTAMP] OBS: Seu (cadastro ou apólice) se encontra inativo, então a sua averbação pode ser negada pela seguradora caso não esteja com a renovação do seu contrato em dia. Antes de seguir viagem, consulte sua seguradora e/ou corretora para validar seu cadastro',
        placeholders: ['[NUMERO_AVERBACAO]', '[TIMESTAMP]'],
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4001',
        tipo: 'erro',
        categoria: 'AUTENTICACAO',
        texto_padrao: 'Token de autenticação inválido, expirado ou ausente.',
        texto_customizado: 'Token de autenticação inválido, expirado ou ausente.',
        placeholders: [],
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4002',
        tipo: 'erro',
        categoria: 'CADASTRO',
        texto_padrao:
          'ERRO 4002: O usuário para esta averbação não está ativo, fale com seu corretor ou seguradora.',
        texto_customizado:
          'ERRO 4002: O usuário para esta averbação não está ativo, fale com seu corretor ou seguradora.',
        placeholders: [],
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4003',
        tipo: 'erro',
        categoria: 'APOLICE',
        texto_padrao: 'ERRO 4003: Apólice inativa ou não localizada para o ramo e CNPJ informado.',
        texto_customizado: 'ERRO 4003: Apólice inativa ou não localizada para o ramo e CNPJ informado.',
        placeholders: [],
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4004',
        tipo: 'erro',
        categoria: 'REGRA_XML',
        texto_padrao:
          'ERRO 4004: Não foi possível seguir com a sua averbação por não ser localizada a condição [NOME_VARIAVEL] da sua averbação.',
        texto_customizado:
          'ERRO 4004: Não foi possível seguir com a sua averbação por não ser localizada a condição [NOME_VARIAVEL] da sua averbação.',
        placeholders: ['[NOME_VARIAVEL]'],
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4005',
        tipo: 'erro',
        categoria: 'REGRA_XML',
        texto_padrao: 'ERRO 4005: XML malformado ou fora dos padrões mínimos exigidos pelo Sefaz.',
        texto_customizado: 'ERRO 4005: XML malformado ou fora dos padrões mínimos exigidos pelo Sefaz.',
        placeholders: [],
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4006',
        tipo: 'erro',
        categoria: 'SYSTEM',
        texto_padrao:
          'ERRO 4006: Variável informada via link de recuperação é inválida ou expirou o tempo limite de preenchimento.',
        texto_customizado:
          'ERRO 4006: Variável informada via link de recuperação é inválida ou expirou o tempo limite de preenchimento.',
        placeholders: [],
        updated_at: new Date().toISOString()
      }
    ];

    // 2. Seguradoras e Corretoras Padrão
    const insurerPorto: Insurer = {
      id: 'ins_porto_01',
      cnpj: '61.198.164/0001-60',
      nome: 'Porto Seguro Cia de Seguros Gerais',
      created_at: new Date().toISOString()
    };
    const insurerTokio: Insurer = {
      id: 'ins_tokio_02',
      cnpj: '33.164.021/0001-00',
      nome: 'Tokio Marine Seguradora S.A.',
      created_at: new Date().toISOString()
    };
    this.insurers = [insurerPorto, insurerTokio];

    const brokerArckatech: Broker = {
      id: 'brk_arckatech_01',
      cnpj: '12.345.678/0001-90',
      nome: 'Arckatech Corretora de Seguros de Carga',
      created_at: new Date().toISOString()
    };
    this.brokers = [brokerArckatech];

    // 3. Clientes / Tenants
    const tenantExpressa: Tenant = {
      id: 'tenant_expressa_teste',
      cnpj: '11.111.111/0001-11',
      razao_social: 'Transportadora Expressa Teste Ltda',
      status: 'ATIVO',
      ambiente: 'teste',
      client_id: 'client_teste_11111111000111',
      client_secret_hash: 'secret_123',
      role: 'TRANSPORTADOR',
      token_duration_hours: 8,
      created_at: new Date().toISOString()
    };

    const tenantTranslog: Tenant = {
      id: 'tenant_translog_teste',
      cnpj: '22.222.222/0001-22',
      razao_social: 'Translog Logistica & Cargas Teste S.A.',
      status: 'ATIVO',
      ambiente: 'teste',
      client_id: 'client_teste_22222222000122',
      client_secret_hash: 'secret_123',
      role: 'TRANSPORTADOR',
      token_duration_hours: 8,
      created_at: new Date().toISOString()
    };

    const tenantInativo: Tenant = {
      id: 'tenant_inativo_teste',
      cnpj: '33.333.333/0001-33',
      razao_social: 'Transportes Inativos Teste Eireli',
      status: 'INATIVO',
      ambiente: 'teste',
      client_id: 'client_teste_33333333000133',
      client_secret_hash: 'secret_123',
      role: 'TRANSPORTADOR',
      token_duration_hours: 8,
      created_at: new Date().toISOString()
    };

    const tenantProd: Tenant = {
      id: 'tenant_prod_real',
      cnpj: '99.999.999/0001-99',
      razao_social: 'Transportes Brasil Produção S.A.',
      status: 'ATIVO',
      ambiente: 'producao',
      client_id: 'client_prod_99999999000199',
      client_secret_hash: 'secret_prod_123',
      role: 'TRANSPORTADOR',
      token_duration_hours: 12,
      created_at: new Date().toISOString()
    };

    this.tenants = [tenantExpressa, tenantTranslog, tenantInativo, tenantProd];

    // 4. Apólices
    const policy1: Policy = {
      id: 'pol_rctrc_expressa',
      numero_apolice: 'POL-RCTRC-2026-001',
      ramo: 'RCTRC',
      tenant_id: tenantExpressa.id,
      insurer_id: insurerPorto.id,
      broker_id: brokerArckatech.id,
      status: 'ATIVA',
      permitir_inativo_vencido: false,
      vigencia_inicio: '2026-01-01T00:00:00Z',
      vigencia_fim: '2026-12-31T23:59:59Z'
    };

    const policy2: Policy = {
      id: 'pol_rcdc_translog',
      numero_apolice: 'POL-RCDC-2026-002',
      ramo: 'RCDC',
      tenant_id: tenantTranslog.id,
      insurer_id: insurerTokio.id,
      broker_id: brokerArckatech.id,
      status: 'ATIVA',
      permitir_inativo_vencido: false,
      vigencia_inicio: '2026-01-01T00:00:00Z',
      vigencia_fim: '2026-12-31T23:59:59Z'
    };

    const policyExcecao: Policy = {
      id: 'pol_rcv_inativo_excecao',
      numero_apolice: 'POL-RCV-EXCECAO-999',
      ramo: 'RCV',
      tenant_id: tenantInativo.id,
      insurer_id: insurerPorto.id,
      broker_id: brokerArckatech.id,
      status: 'INATIVA',
      permitir_inativo_vencido: true, // Flag de bypass habilitada
      vigencia_inicio: '2025-01-01T00:00:00Z',
      vigencia_fim: '2025-12-31T23:59:59Z' // Apólice Vencida
    };

    const policyProd: Policy = {
      id: 'pol_prod_real',
      numero_apolice: 'POL-RCTRC-PROD-2026',
      ramo: 'RCTRC',
      tenant_id: tenantProd.id,
      insurer_id: insurerPorto.id,
      broker_id: brokerArckatech.id,
      status: 'ATIVA',
      permitir_inativo_vencido: false,
      vigencia_inicio: '2026-01-01T00:00:00Z',
      vigencia_fim: '2026-12-31T23:59:59Z'
    };

    this.policies = [policy1, policy2, policyExcecao, policyProd];

    // 5. Regras Dinâmicas por Apólice
    this.policyRules = [
      {
        id: uuidv4(),
        policy_id: policy1.id,
        tipo_doc: 'CTE',
        tag_path: 'vCarga',
        nome_variavel: 'Valor da Carga',
        obrigatoria: true,
        instrucao_recuperacao: 'Informe o valor total da carga em Reais'
      },
      {
        id: uuidv4(),
        policy_id: policy1.id,
        tipo_doc: 'CTE',
        tag_path: 'TIPO_EMBALAGEM',
        nome_variavel: 'Tipo de Embalagem',
        obrigatoria: true,
        instrucao_recuperacao: 'Informe se a carga está em Caixas, Paletes ou Container'
      },
      {
        id: uuidv4(),
        policy_id: policy2.id,
        tipo_doc: 'NFE',
        tag_path: 'vProd',
        nome_variavel: 'Valor Total dos Produtos',
        obrigatoria: true,
        instrucao_recuperacao: 'Informe o valor da NFe'
      }
    ];
  }
}

export const dbStore = new DBStore();
