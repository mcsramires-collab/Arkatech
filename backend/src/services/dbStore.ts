import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { mirrorToPostgres } from './pgMirror';
import {
  Tenant,
  Insurer,
  Broker,
  Policy,
  PolicyRule,
  DocumentRule,
  ResponseTemplate,
  Averbacao,
  RawXMLStore,
  RecoverySession,
  BatchTestRun,
  InternalUser,
  RbacProfile,
  TenantUser,
  InsurerCoverageTemplate,
  InsurerCoverage,
  DelegationPermission,
  ApprovalRequest,
  DelegationException,
  PolicyCoverageValue,
  ActivationToken,
  NotificationPreference,
  PolicyTitularityRule,
  PolicyBypassRule,
  BusinessRuleRequest,
  PolicyBusinessSettings,
  PolicySublimite,
  SupportTicket,
  RevokedToken
} from '../types';

class DBStore {
  public tenants: Tenant[] = [];
  public insurers: Insurer[] = [];
  public brokers: Broker[] = [];
  public policies: Policy[] = [];
  public policyRules: PolicyRule[] = [];
  public documentRules: DocumentRule[] = [];
  public responseTemplates: ResponseTemplate[] = [];
  public averbacoes: Averbacao[] = [];
  public rawXmlStore: RawXMLStore[] = [];
  public recoverySessions: RecoverySession[] = [];
  public batchTestRuns: BatchTestRun[] = [];
  // Fase 1 — novas entidades (visão empresa, RBAC, coberturas, delegação, ativação)
  public internalUsers: InternalUser[] = [];
  public rbacProfiles: RbacProfile[] = [];
  public tenantUsers: TenantUser[] = [];
  public insurerCoverageTemplates: InsurerCoverageTemplate[] = [];
  public insurerCoverages: InsurerCoverage[] = [];
  public delegationPermissions: DelegationPermission[] = [];
  public approvalRequests: ApprovalRequest[] = [];
  public activationTokens: ActivationToken[] = [];
  public notificationPreferences: NotificationPreference[] = [];
  public policyTitularityRules: PolicyTitularityRule[] = [];
  public policyBypassRules: PolicyBypassRule[] = [];
  public businessRuleRequests: BusinessRuleRequest[] = [];
  // Fase 2 — Ficha do Segurado real (Portal da Seguradora): demais sub-seções de Regras de
  // Negócio (blob por apólice) e Sublimites por Mercadoria (lista por apólice).
  public policyBusinessSettings: PolicyBusinessSettings[] = [];
  public policySublimites: PolicySublimite[] = [];
  // Fase 3 — Segurança/enforcement (backlog itens 1 e 2): override por segurado da matriz de
  // delegação, e valor real de cobertura adicional por apólice.
  public delegationExceptions: DelegationException[] = [];
  public policyCoverageValues: PolicyCoverageValue[] = [];
  // Fase 4 — Tela de Suporte real do Portal do Segurado (backlog item, auditoria de 27/08).
  public supportTickets: SupportTicket[] = [];
  // Fase 5 (item 3) — Login real + RBAC: revogação de sessão antes do vencimento natural
  // (ver types/index.ts, RevokedToken, para o desenho completo).
  public revokedTokens: RevokedToken[] = [];

  // Por padrão, grava dentro da própria pasta de build (comportamento antigo, ok para dev local).
  // Em produção, defina a env var DATA_DIR apontando para um diretório com volume persistente
  // mapeado no orquestrador (ex. Easypanel), para o dado sobreviver a reinícios/deploys do
  // container — sem isso, tudo em memória é perdido a cada novo deploy.
  private filePath = path.join(
    process.env.DATA_DIR || path.join(__dirname, '../../'),
    'data_store.json'
  );

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
        this.documentRules = parsed.documentRules || [];
        this.responseTemplates = parsed.responseTemplates || [];
        this.averbacoes = parsed.averbacoes || [];
        this.rawXmlStore = parsed.rawXmlStore || [];
        this.recoverySessions = parsed.recoverySessions || [];
        this.batchTestRuns = parsed.batchTestRuns || [];
        this.internalUsers = parsed.internalUsers || [];
        this.rbacProfiles = parsed.rbacProfiles || [];
        this.tenantUsers = parsed.tenantUsers || [];
        this.insurerCoverageTemplates = parsed.insurerCoverageTemplates || [];
        this.insurerCoverages = parsed.insurerCoverages || [];
        this.delegationPermissions = parsed.delegationPermissions || [];
        this.approvalRequests = parsed.approvalRequests || [];
        this.activationTokens = parsed.activationTokens || [];
        this.notificationPreferences = parsed.notificationPreferences || [];
        this.policyTitularityRules = parsed.policyTitularityRules || [];
        this.policyBypassRules = parsed.policyBypassRules || [];
        this.businessRuleRequests = parsed.businessRuleRequests || [];
        this.policyBusinessSettings = parsed.policyBusinessSettings || [];
        this.policySublimites = parsed.policySublimites || [];
        this.delegationExceptions = parsed.delegationExceptions || [];
        this.policyCoverageValues = parsed.policyCoverageValues || [];
        this.supportTickets = parsed.supportTickets || [];
        this.revokedTokens = parsed.revokedTokens || [];

        if (this.ensureDefaultResponseTemplates()) {
          this.persist();
        }
        return;
      } catch (err) {
        console.error('Erro ao ler data_store.json. Inicializando com seeds padrão.', err);
      }
    }

    this.seedDefaultData();
    this.persist();
  }

  // Fase 1 da migração para Postgres (ver claude/Plano_Migracao_Postgres.md no Project) — modo
  // "espelhamento automático": toda chamada a persist() agenda (debounced) uma passagem de
  // `mirrorToPostgres`, que copia o estado atual de todos os arrays para o Postgres. Debounce
  // evita disparar uma passagem completa a cada mutação isolada quando várias acontecem em
  // sequência rápida (ex: seed inicial, importação em lote). Se DATABASE_URL não estiver
  // configurada, `mirrorToPostgres` é um no-op — nenhuma rota depende deste espelhamento hoje.
  private mirrorDebounceTimer: NodeJS.Timeout | null = null;
  private static readonly MIRROR_DEBOUNCE_MS = 3000;

  private scheduleMirror() {
    if (this.mirrorDebounceTimer) {
      clearTimeout(this.mirrorDebounceTimer);
    }
    this.mirrorDebounceTimer = setTimeout(() => {
      this.mirrorDebounceTimer = null;
      mirrorToPostgres(this).catch((err) => {
        console.error('[dbStore] Falha não tratada ao agendar espelhamento para o Postgres:', err);
      });
    }, DBStore.MIRROR_DEBOUNCE_MS);
    // Não impede o processo Node de encerrar por causa deste timer pendente (ex: em testes/CLI).
    this.mirrorDebounceTimer.unref?.();
  }

  public persist() {
    this.scheduleMirror();
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
            documentRules: this.documentRules,
            responseTemplates: this.responseTemplates,
            averbacoes: this.averbacoes,
            rawXmlStore: this.rawXmlStore,
            recoverySessions: this.recoverySessions,
            batchTestRuns: this.batchTestRuns,
            internalUsers: this.internalUsers,
            rbacProfiles: this.rbacProfiles,
            tenantUsers: this.tenantUsers,
            insurerCoverageTemplates: this.insurerCoverageTemplates,
            insurerCoverages: this.insurerCoverages,
            delegationPermissions: this.delegationPermissions,
            approvalRequests: this.approvalRequests,
            activationTokens: this.activationTokens,
            notificationPreferences: this.notificationPreferences,
            policyTitularityRules: this.policyTitularityRules,
            policyBypassRules: this.policyBypassRules,
            businessRuleRequests: this.businessRuleRequests,
            policyBusinessSettings: this.policyBusinessSettings,
            policySublimites: this.policySublimites,
            delegationExceptions: this.delegationExceptions,
            policyCoverageValues: this.policyCoverageValues,
            supportTickets: this.supportTickets,
            revokedTokens: this.revokedTokens
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

  /**
   * Fase 5 (item 3) do "Login real + RBAC" — revoga um token de backoffice antes do vencimento
   * natural (hoje só chamado no logout real, `POST /auth/backoffice-logout`). Aproveita a
   * chamada para descartar de passagem qualquer entrada já expirada (limpeza preguiçosa, sem
   * precisar de um job/cron separado — a lista nunca cresce além dos tokens de backoffice
   * emitidos e ainda não vencidos que alguém efetivamente revogou).
   */
  public revokeToken(jti: string, expiresAtMs: number, userId: string | undefined, motivo: string) {
    const agora = Date.now();
    this.revokedTokens = this.revokedTokens.filter((rt) => rt.expires_at > agora);
    this.revokedTokens.push({ jti, expires_at: expiresAtMs, revoked_at: agora, user_id: userId, motivo });
    this.persist();
  }

  /**
   * Checa se um `jti` de token de backoffice foi revogado — chamado a cada requisição autenticada
   * via Bearer em `backofficeAuthMiddleware`/`backofficeOrInternalKeyMiddleware`, junto da
   * verificação de assinatura do JWT. Não muta `revokedTokens` (checagem tem que ser barata e
   * síncrona no meio do middleware) — a limpeza de entradas vencidas acontece em `revokeToken`.
   */
  public isTokenRevoked(jti: string | undefined): boolean {
    if (!jti) return false;
    const agora = Date.now();
    return this.revokedTokens.some((rt) => rt.jti === jti && rt.expires_at > agora);
  }

  /**
   * Lista canônica de ResponseTemplate padrão do sistema. Usada tanto no seed inicial (quando
   * ainda não existe data_store.json) quanto por ensureDefaultResponseTemplates() — necessário
   * porque seedDefaultData() só roda em banco vazio; qualquer código novo adicionado aqui depois
   * que o data_store.json já existe em produção precisa desse backfill pra aparecer, senão a
   * averbação retorna "Mensagem de retorno [CODIGO] não configurada no banco de dados" (ver
   * ResponseEngine.formatResponse).
   */
  private buildDefaultResponseTemplates(): ResponseTemplate[] {
    return [
      {
        id: uuidv4(),
        codigo: 'SUC-2000',
        tipo: 'sucesso',
        categoria: 'SISTEMA',
        texto_padrao: 'Averbação realizada com sucesso. Número: [NUMERO_AVERBACAO], Timestamp: [TIMESTAMP].',
        texto_customizado: 'Averbação realizada com sucesso. Número: [NUMERO_AVERBACAO], Timestamp: [TIMESTAMP].',
        placeholders: ['[NUMERO_AVERBACAO]', '[TIMESTAMP]'],
        explicacao_nao_tecnica: 'Seu documento foi averbado com sucesso e já pode seguir viagem.',
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
        explicacao_nao_tecnica:
          'Seu documento foi averbado, mas seu cadastro ou apólice está com pendência. A cobertura pode ser contestada em caso de sinistro.',
        orientacao_correcao: 'Fale com sua seguradora ou corretora para regularizar o cadastro/apólice antes de seguir viagem.',
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
        explicacao_nao_tecnica: 'Não foi possível confirmar sua identidade para processar a averbação.',
        orientacao_correcao: 'Gere um novo token de acesso e tente novamente.',
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
        explicacao_nao_tecnica: 'Seu cadastro está inativo em nosso sistema, por isso não foi possível averbar este documento.',
        orientacao_correcao: 'Entre em contato com sua seguradora ou corretora para reativar seu cadastro.',
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
        explicacao_nao_tecnica: 'Não encontramos uma apólice ativa para o ramo informado vinculada ao seu CNPJ.',
        orientacao_correcao: 'Confirme com sua seguradora/corretora se a apólice para este ramo está ativa e corretamente cadastrada.',
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
        explicacao_nao_tecnica: 'Faltou informar: [NOME_VARIAVEL].',
        orientacao_correcao: 'Reenvie o documento com essa informação, ou corrija diretamente pelo link/portal de recuperação.',
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
        explicacao_nao_tecnica: 'O arquivo enviado não pôde ser lido corretamente.',
        orientacao_correcao: 'Verifique se o arquivo é um XML válido, autorizado pelo Sefaz, e tente novamente.',
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4006',
        tipo: 'erro',
        categoria: 'SISTEMA',
        texto_padrao:
          'ERRO 4006: Variável informada via link de recuperação é inválida ou expirou o tempo limite de preenchimento.',
        texto_customizado:
          'ERRO 4006: Variável informada via link de recuperação é inválida ou expirou o tempo limite de preenchimento.',
        placeholders: [],
        explicacao_nao_tecnica: 'O link de correção que você usou não é mais válido.',
        orientacao_correcao: 'Solicite um novo envio do documento para gerar um novo link de correção.',
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4007',
        tipo: 'erro',
        categoria: 'REGRA_XML',
        texto_padrao: 'ERRO 4007: Este documento já foi averbado anteriormente para este ramo de apólice (averbação [NUMERO_AVERBACAO_EXISTENTE]).',
        texto_customizado: 'ERRO 4007: Este documento já foi averbado anteriormente para este ramo de apólice (averbação [NUMERO_AVERBACAO_EXISTENTE]).',
        placeholders: ['[NUMERO_AVERBACAO_EXISTENTE]'],
        explicacao_nao_tecnica: 'Este documento já está averbado — não é possível averbar o mesmo documento duas vezes no mesmo ramo.',
        orientacao_correcao: 'Consulte a averbação existente pelo número informado; nenhuma ação é necessária.',
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4008',
        tipo: 'erro',
        categoria: 'REGRA_XML',
        texto_padrao: 'ERRO 4008: O CNPJ solicitante não é o emissor nem um destinatário elegível para averbar este documento.',
        texto_customizado: 'ERRO 4008: O CNPJ solicitante não é o emissor nem um destinatário elegível para averbar este documento.',
        placeholders: [],
        explicacao_nao_tecnica: 'Seu CNPJ não consta como emissor deste documento, e sua apólice não permite averbar como destinatário.',
        orientacao_correcao: 'Confirme se o documento correto foi enviado, ou solicite à sua seguradora habilitar a averbação como destinatário.',
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4009',
        tipo: 'erro',
        categoria: 'CADASTRO',
        texto_padrao: 'ERRO 4009: Conta ainda não ativada. Aceite o Termo de Uso para acessar o portal.',
        texto_customizado: 'ERRO 4009: Conta ainda não ativada. Aceite o Termo de Uso para acessar o portal.',
        placeholders: [],
        explicacao_nao_tecnica: 'Você ainda não concluiu a ativação da sua conta.',
        orientacao_correcao: 'Acesse o link de ativação enviado por e-mail e aceite o Termo de Uso para liberar seu acesso.',
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4010',
        tipo: 'erro',
        categoria: 'APOLICE',
        texto_padrao:
          'ERRO 4010: O valor considerado para a averbação (R$ [VALOR_AVERBACAO]) ultrapassa o Limite Máximo de Garantia da apólice (R$ [LMI_APOLICE]).',
        texto_customizado:
          'ERRO 4010: O valor considerado para a averbação (R$ [VALOR_AVERBACAO]) ultrapassa o Limite Máximo de Garantia da apólice (R$ [LMI_APOLICE]).',
        placeholders: ['[VALOR_AVERBACAO]', '[LMI_APOLICE]'],
        explicacao_nao_tecnica: 'O valor da carga deste documento é maior do que o limite contratado na sua apólice.',
        orientacao_correcao:
          'Confirme o valor declarado no documento, ou fale com sua seguradora/corretora para avaliar um aumento do limite contratado.',
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4011',
        tipo: 'erro',
        categoria: 'APOLICE',
        texto_padrao: 'ERRO 4011: A apólice está fora do período de vigência (venceu em [VIGENCIA_FIM]).',
        texto_customizado: 'ERRO 4011: A apólice está fora do período de vigência (venceu em [VIGENCIA_FIM]).',
        placeholders: ['[VIGENCIA_FIM]'],
        explicacao_nao_tecnica: 'A vigência contratada da sua apólice já terminou.',
        orientacao_correcao:
          'Fale com sua seguradora/corretora para renovar a apólice, ou solicite a exceção de "permitir inativo/vencido" caso a renovação já esteja em andamento.',
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4012',
        tipo: 'erro',
        categoria: 'SISTEMA',
        texto_padrao:
          'ERRO 4012: O prazo para complementar esta pendência expirou em [EXPIRA_EM]. Reenvie o documento para gerar uma nova pendência.',
        texto_customizado:
          'ERRO 4012: O prazo para complementar esta pendência expirou em [EXPIRA_EM]. Reenvie o documento para gerar uma nova pendência.',
        placeholders: ['[EXPIRA_EM]'],
        explicacao_nao_tecnica: 'O prazo de 24 horas para complementar esta informação já passou.',
        orientacao_correcao: 'Reenvie o documento (CT-e/NF-e/MDF-e) novamente para gerar uma nova pendência de complementação.',
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4013',
        tipo: 'erro',
        categoria: 'APOLICE',
        texto_padrao:
          "ERRO 4013: O valor considerado para a averbação (R$ [VALOR_AVERBACAO]) ultrapassa o sublimite configurado para a mercadoria '[MERCADORIA]' (R$ [SUBLIMITE]).",
        texto_customizado:
          "ERRO 4013: O valor considerado para a averbação (R$ [VALOR_AVERBACAO]) ultrapassa o sublimite configurado para a mercadoria '[MERCADORIA]' (R$ [SUBLIMITE]).",
        placeholders: ['[VALOR_AVERBACAO]', '[MERCADORIA]', '[SUBLIMITE]'],
        explicacao_nao_tecnica:
          'O valor da carga deste documento é maior do que o limite específico contratado para este tipo de mercadoria.',
        orientacao_correcao:
          'Confirme o valor declarado no documento, ou fale com sua seguradora/corretora para avaliar um aumento do sublimite contratado para esta mercadoria.',
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4014',
        tipo: 'erro',
        categoria: 'APOLICE',
        texto_padrao:
          'ERRO 4014: O prazo máximo para aceite deste documento a partir de [DATA_BASE] (limite: [PRAZO_LIMITE]) já expirou.',
        texto_customizado:
          'ERRO 4014: O prazo máximo para aceite deste documento a partir de [DATA_BASE] (limite: [PRAZO_LIMITE]) já expirou.',
        placeholders: ['[DATA_BASE]', '[PRAZO_LIMITE]'],
        explicacao_nao_tecnica: 'Este documento foi enviado depois do prazo máximo aceito pela sua apólice.',
        orientacao_correcao:
          'Fale com sua seguradora/corretora para avaliar uma exceção, ou verifique se o documento correto foi enviado.',
        updated_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        codigo: 'ERR-4015',
        tipo: 'erro',
        categoria: 'APOLICE',
        texto_padrao:
          'ERRO 4015: A averbação não respeita o prazo configurado para a Data de Embarque ([DATA_EMBARQUE]) — limite: [PRAZO_LIMITE].',
        texto_customizado:
          'ERRO 4015: A averbação não respeita o prazo configurado para a Data de Embarque ([DATA_EMBARQUE]) — limite: [PRAZO_LIMITE].',
        placeholders: ['[DATA_EMBARQUE]', '[PRAZO_LIMITE]'],
        explicacao_nao_tecnica: 'Este documento foi enviado fora do prazo aceito em relação à data de embarque informada.',
        orientacao_correcao:
          'Fale com sua seguradora/corretora para avaliar uma exceção, ou verifique se a data de embarque informada está correta.',
        updated_at: new Date().toISOString()
      }
    ];
  }

  /**
   * Garante que todo código de buildDefaultResponseTemplates() exista em this.responseTemplates,
   * adicionando só os que faltarem (nunca sobrescreve um texto_customizado já editado pela
   * seguradora). Roda sempre que o dbStore carrega de um data_store.json já existente — é o
   * "backfill" que faz um código de erro novo (ex: ERR-4010/ERR-4011) aparecer em produção sem
   * precisar apagar o banco. Retorna true se algo foi adicionado (sinal pra chamar persist()).
   */
  private ensureDefaultResponseTemplates(): boolean {
    const existentes = new Set(this.responseTemplates.map((t) => t.codigo));
    const faltando = this.buildDefaultResponseTemplates().filter((t) => !existentes.has(t.codigo));
    if (faltando.length === 0) return false;
    this.responseTemplates.push(...faltando);
    return true;
  }

  private seedDefaultData() {
    // 1. Templates de Resposta (Configuráveis no banco)
    this.responseTemplates = this.buildDefaultResponseTemplates();

    // 1.1 Regras de Obrigatoriedade de Tag POR TIPO DE DOCUMENTO (padrão Sefaz)
    // Estas regras valem para TODOS os documentos daquele tipo, independente da apólice/seguradora.
    const sefazDefaults: Omit<DocumentRule, 'id' | 'created_at'>[] = [
      // CT-e
      { tipo_documento: 'CTE', tag_path: 'nCT', nome_variavel: 'Número do CT-e', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      { tipo_documento: 'CTE', tag_path: 'dhEmi', nome_variavel: 'Data/Hora de Emissão', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      { tipo_documento: 'CTE', tag_path: 'vCarga', nome_variavel: 'Valor da Carga', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      { tipo_documento: 'CTE', tag_path: 'CFOP', nome_variavel: 'CFOP', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      { tipo_documento: 'CTE', tag_path: 'cUF', nome_variavel: 'Código da UF', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      // NF-e
      { tipo_documento: 'NFE', tag_path: 'nNF', nome_variavel: 'Número da NF-e', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      { tipo_documento: 'NFE', tag_path: 'dhEmi', nome_variavel: 'Data/Hora de Emissão', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      { tipo_documento: 'NFE', tag_path: 'vProd', nome_variavel: 'Valor dos Produtos', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      { tipo_documento: 'NFE', tag_path: 'vNF', nome_variavel: 'Valor Total da NF-e', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      // NFS-e
      { tipo_documento: 'NFSE', tag_path: 'numero', nome_variavel: 'Número da NFS-e', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      { tipo_documento: 'NFSE', tag_path: 'vServicos', nome_variavel: 'Valor dos Serviços', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      // MDF-e
      { tipo_documento: 'MDFE', tag_path: 'nMDF', nome_variavel: 'Número do MDF-e', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      { tipo_documento: 'MDFE', tag_path: 'dhEmi', nome_variavel: 'Data/Hora de Emissão', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      { tipo_documento: 'MDFE', tag_path: 'vCarga', nome_variavel: 'Valor Total da Carga', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      { tipo_documento: 'MDFE', tag_path: 'UFIni', nome_variavel: 'UF de Início da Viagem', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' },
      { tipo_documento: 'MDFE', tag_path: 'UFFim', nome_variavel: 'UF de Fim da Viagem', obrigatoria: true, origem: 'SEFAZ_PADRAO', observacao: 'Obrigatória Sefaz' }
    ];

    this.documentRules = sefazDefaults.map((r) => ({
      ...r,
      id: uuidv4(),
      created_at: new Date().toISOString()
    }));

    // 2. Seguradoras e Corretoras Padrão
    // Cada seguradora/corretora agora também existe como um `tenant` (role SEGURADORA/CORRETORA),
    // e os registros de Insurer/Broker se vinculam a esse tenant via tenant_id.
    const tenantPorto: Tenant = {
      id: 'tenant_seguradora_porto',
      cnpj: '61.198.164/0001-60',
      razao_social: 'Porto Seguro Cia de Seguros Gerais',
      status: 'ATIVO',
      ambiente: 'teste',
      client_id: 'client_teste_seguradora_porto',
      client_secret_hash: 'secret_123',
      role: 'SEGURADORA',
      token_duration_hours: 8,
      created_at: new Date().toISOString(),
      conta_ativada: true
    };
    const tenantTokio: Tenant = {
      id: 'tenant_seguradora_tokio',
      cnpj: '33.164.021/0001-00',
      razao_social: 'Tokio Marine Seguradora S.A.',
      status: 'ATIVO',
      ambiente: 'teste',
      client_id: 'client_teste_seguradora_tokio',
      client_secret_hash: 'secret_123',
      role: 'SEGURADORA',
      token_duration_hours: 8,
      created_at: new Date().toISOString(),
      conta_ativada: true
    };
    const tenantCorretoraArckatech: Tenant = {
      id: 'tenant_corretora_arckatech',
      cnpj: '12.345.678/0001-90',
      razao_social: 'Arckatech Corretora de Seguros de Carga',
      status: 'ATIVO',
      ambiente: 'teste',
      client_id: 'client_teste_corretora_arckatech',
      client_secret_hash: 'secret_123',
      role: 'CORRETORA',
      token_duration_hours: 8,
      created_at: new Date().toISOString(),
      conta_ativada: true
    };

    const insurerPorto: Insurer = {
      id: 'ins_porto_01',
      tenant_id: tenantPorto.id,
      cnpj: tenantPorto.cnpj,
      nome: tenantPorto.razao_social,
      razao_social: 'Porto Seguro Cia de Seguros Gerais',
      nome_fantasia: 'Porto Seguro',
      created_at: new Date().toISOString()
    };
    const insurerTokio: Insurer = {
      id: 'ins_tokio_02',
      tenant_id: tenantTokio.id,
      cnpj: tenantTokio.cnpj,
      nome: tenantTokio.razao_social,
      razao_social: 'Tokio Marine Seguradora S.A.',
      nome_fantasia: 'Tokio Marine',
      created_at: new Date().toISOString()
    };
    this.insurers = [insurerPorto, insurerTokio];

    const brokerArckatech: Broker = {
      id: 'brk_arckatech_01',
      tenant_id: tenantCorretoraArckatech.id,
      cnpj: tenantCorretoraArckatech.cnpj,
      nome: tenantCorretoraArckatech.razao_social,
      razao_social: 'Arckatech Corretora de Seguros de Carga',
      nome_fantasia: 'Arckatech Corretora',
      corretor_responsavel_nome: 'Fernanda Lima',
      corretor_responsavel_email: 'fernanda.lima@arckatechcorretora.com.br',
      corretor_responsavel_telefone_fixo: '(11) 4002-8900',
      corretor_responsavel_celular: '(11) 98888-7766',
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
      created_at: new Date().toISOString(),
      conta_ativada: true
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
      created_at: new Date().toISOString(),
      conta_ativada: true
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
      created_at: new Date().toISOString(),
      conta_ativada: true
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
      created_at: new Date().toISOString(),
      conta_ativada: true
    };

    // 5º transportador de teste — conta ainda NÃO ativada (testa o fluxo de Termo de Uso/aceite)
    const tenantPendenteAtivacao: Tenant = {
      id: 'tenant_pendente_ativacao',
      cnpj: '55.666.777/0001-55',
      razao_social: 'Nova Rota Transportes Ltda',
      status: 'ATIVO',
      ambiente: 'teste',
      client_id: 'client_teste_novarota',
      client_secret_hash: 'secret_123',
      role: 'TRANSPORTADOR',
      token_duration_hours: 8,
      created_at: new Date().toISOString(),
      contato_nome: 'Bruno Castro',
      contato_email: 'bruno.castro@novarotateste.com.br',
      conta_ativada: false
    };

    this.tenants = [
      tenantPorto,
      tenantTokio,
      tenantCorretoraArckatech,
      tenantExpressa,
      tenantTranslog,
      tenantInativo,
      tenantProd,
      tenantPendenteAtivacao
    ];

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
      vigencia_fim: '2026-12-31T23:59:59Z',
      lmi: 300000,
      aceita_averbacao_como_destinatario: false
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
      vigencia_fim: '2026-12-31T23:59:59Z',
      lmi: 500000,
      aceita_averbacao_como_destinatario: true
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
      vigencia_fim: '2025-12-31T23:59:59Z', // Apólice Vencida
      lmi: 150000,
      aceita_averbacao_como_destinatario: false
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
      vigencia_fim: '2026-12-31T23:59:59Z',
      lmi: 1000000,
      aceita_averbacao_como_destinatario: false
    };

    this.policies = [policy1, policy2, policyExcecao, policyProd];

    // Apólice do 5º transportador (fica visível só depois que ele ativar a conta)
    this.policies.push({
      id: 'pol_rctrc_novarota',
      numero_apolice: 'POL-RCTRC-2026-005',
      ramo: 'RCTRC',
      tenant_id: tenantPendenteAtivacao.id,
      insurer_id: insurerPorto.id,
      broker_id: brokerArckatech.id,
      status: 'ATIVA',
      permitir_inativo_vencido: false,
      vigencia_inicio: new Date().toISOString(),
      vigencia_fim: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      lmi: 400000,
      aceita_averbacao_como_destinatario: false
    });

    // 5. Regras Dinâmicas por Apólice
    this.policyRules = [
      {
        id: uuidv4(),
        policy_id: policy1.id,
        tipo_doc: 'CTE',
        tag_path: 'TIPO_EMBALAGEM',
        nome_variavel: 'Tipo de Embalagem',
        obrigatoria: true,
        exemplo_preenchimento: 'Container',
        instrucao_recuperacao: 'Informe se a carga está em Caixas, Paletes ou Container'
      },
      {
        id: uuidv4(),
        policy_id: policy1.id,
        tipo_doc: 'CTE',
        tag_path: 'VALOR_DECLARADO_CONTAINER',
        nome_variavel: 'Valor Declarado do Container',
        obrigatoria: false,
        exemplo_preenchimento: 'R$ 25.000,00',
        instrucao_recuperacao: 'Informe o valor declarado do container em Reais'
      },
      {
        id: uuidv4(),
        policy_id: policy2.id,
        tipo_doc: 'NFE',
        tag_path: 'LOCAL_ARMAZENAGEM',
        nome_variavel: 'Local de Armazenagem',
        obrigatoria: true,
        exemplo_preenchimento: 'CD Guarulhos - SP',
        instrucao_recuperacao: 'Informe o centro de distribuição de origem da carga'
      }
    ];

    // 6. Visão Empresa — ADM e Agente ARCKATECH
    const admDefault: InternalUser = {
      id: uuidv4(),
      nome: 'Admin ARCKATECH',
      email: 'admin@arckatech.com.br',
      password_hash: 'hash_admin_dev',
      role: 'ADM',
      status: 'ATIVO',
      created_at: new Date().toISOString()
    };

    const perfilAgenteSuporte: RbacProfile = {
      id: uuidv4(),
      owner_type: 'ARCKATECH',
      nome_perfil: 'Agente de Suporte',
      permissions: {
        apolices: 'ver',
        clientes: 'ver',
        coberturas: 'ver',
        relatorios: 'ver',
        usuarios: 'sem_acesso',
        delegacao_corretora: 'sem_acesso'
      },
      created_at: new Date().toISOString()
    };

    const agenteDefault: InternalUser = {
      id: uuidv4(),
      nome: 'Agente de Suporte ARCKATECH',
      email: 'suporte@arckatech.com.br',
      password_hash: 'hash_agente_dev',
      role: 'AGENTE',
      rbac_profile_id: perfilAgenteSuporte.id,
      status: 'ATIVO',
      created_at: new Date().toISOString()
    };

    this.internalUsers = [admDefault, agenteDefault];

    // 7. Perfis de Acesso (RBAC) da Seguradora e da Corretora
    const perfilAdminSeguradora: RbacProfile = {
      id: uuidv4(),
      owner_type: 'SEGURADORA',
      owner_id: insurerPorto.id,
      nome_perfil: 'Administrador da Seguradora',
      permissions: {
        apolices: 'editar',
        clientes: 'editar',
        coberturas: 'editar',
        relatorios: 'ver',
        usuarios: 'editar',
        delegacao_corretora: 'editar'
      },
      created_at: new Date().toISOString()
    };

    const perfilAnalistaCorretora: RbacProfile = {
      id: uuidv4(),
      owner_type: 'CORRETORA',
      owner_id: brokerArckatech.id,
      nome_perfil: 'Analista da Corretora',
      permissions: {
        apolices: 'ver',
        clientes: 'editar',
        coberturas: 'ver',
        relatorios: 'ver',
        usuarios: 'sem_acesso',
        delegacao_corretora: 'sem_acesso'
      },
      created_at: new Date().toISOString()
    };

    this.rbacProfiles = [perfilAgenteSuporte, perfilAdminSeguradora, perfilAnalistaCorretora];

    // 8. Usuários dentro de cada tenant (login individual)
    this.tenantUsers = [
      {
        id: uuidv4(),
        tenant_id: tenantPorto.id,
        nome: 'Carla Mendes',
        email: 'carla.mendes@portoseguro-teste.com.br',
        password_hash: 'hash_dev',
        rbac_profile_id: perfilAdminSeguradora.id,
        status: 'ATIVO',
        created_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        tenant_id: tenantCorretoraArckatech.id,
        nome: 'Ricardo Souza',
        email: 'ricardo.souza@arckatechcorretora.com.br',
        password_hash: 'hash_dev',
        rbac_profile_id: perfilAnalistaCorretora.id,
        status: 'ATIVO',
        created_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        tenant_id: tenantExpressa.id,
        nome: 'João Pereira',
        email: 'joao.pereira@expressateste.com.br',
        password_hash: 'hash_dev',
        is_admin_da_conta: true,
        status: 'ATIVO',
        created_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        tenant_id: tenantTranslog.id,
        nome: 'Marcia Alves',
        email: 'marcia.alves@translogteste.com.br',
        password_hash: 'hash_dev',
        is_admin_da_conta: true,
        status: 'ATIVO',
        created_at: new Date().toISOString()
      }
    ];

    // 9. Catálogo global de Coberturas Adicionais (templates pré-existentes)
    this.insurerCoverageTemplates = ['Container', 'Acessórios', 'Avarias', 'Frete'].map((titulo) => ({
      id: uuidv4(),
      titulo,
      ativo: true,
      created_at: new Date().toISOString()
    }));

    // 10. Coberturas Adicionais configuradas por uma Seguradora (evolução de policy_rules)
    this.insurerCoverages = [
      {
        id: uuidv4(),
        insurer_id: insurerPorto.id,
        ramo: 'RCTRC',
        titulo: 'Container',
        exemplo_preenchimento: 'R$ 25.000,00',
        obrigatoria: false,
        aplicar_todos_clientes: true,
        tipo_valor: 'monetario',
        created_at: new Date().toISOString()
      },
      {
        id: uuidv4(),
        insurer_id: insurerTokio.id,
        ramo: 'RCDC',
        titulo: 'Avarias',
        exemplo_preenchimento: 'Sem avarias aparentes',
        obrigatoria: true,
        aplicar_todos_clientes: false,
        tenant_id: tenantTranslog.id,
        tipo_valor: 'informativo',
        created_at: new Date().toISOString()
      }
    ];

    // 11. Delegação de Poder Seguradora → Corretora (matriz por ação)
    this.delegationPermissions = [
      { id: uuidv4(), insurer_id: insurerPorto.id, broker_id: brokerArckatech.id, action: 'CRIAR_CLIENTE', requires_approval: false },
      { id: uuidv4(), insurer_id: insurerPorto.id, broker_id: brokerArckatech.id, action: 'EDITAR_CLIENTE', requires_approval: false },
      { id: uuidv4(), insurer_id: insurerPorto.id, broker_id: brokerArckatech.id, action: 'CRIAR_APOLICE', requires_approval: true },
      { id: uuidv4(), insurer_id: insurerPorto.id, broker_id: brokerArckatech.id, action: 'EDITAR_APOLICE', requires_approval: true },
      { id: uuidv4(), insurer_id: insurerPorto.id, broker_id: brokerArckatech.id, action: 'CRIAR_COBERTURA_ADICIONAL', requires_approval: true },
      { id: uuidv4(), insurer_id: insurerPorto.id, broker_id: brokerArckatech.id, action: 'EDITAR_COBERTURA_ADICIONAL', requires_approval: true }
    ];

    // 12. Ativação de Conta (Termo de Uso) — exemplo já aceito nos tenants de teste
    this.activationTokens = [tenantExpressa, tenantTranslog, tenantInativo, tenantProd].map((t) => ({
      id: uuidv4(),
      tenant_id: t.id,
      token: `act_${uuidv4()}`,
      termo_versao: 'v1',
      aceite: true,
      aceite_em: new Date().toISOString(),
      expira_em: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString()
    }));

    // Token de ativação PENDENTE (ainda não aceito) do 5º transportador de teste
    this.activationTokens.push({
      id: uuidv4(),
      tenant_id: tenantPendenteAtivacao.id,
      token: 'act_pendente_teste_ativacao',
      termo_versao: 'v1',
      aceite: false,
      expira_em: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString()
    });

    // 13. Preferências de Notificação (padrão: e-mail + portal, sem WhatsApp/SMS no MVP)
    this.notificationPreferences = this.tenantUsers
      .filter((tu) => tu.is_admin_da_conta)
      .flatMap((tu) => [
        { id: uuidv4(), tenant_user_id: tu.id, canal: 'EMAIL' as const, ativo: true },
        { id: uuidv4(), tenant_user_id: tu.id, canal: 'PORTAL' as const, ativo: true }
      ]);

    // 14. Regra de Titularidade v2 — Regra A (função no documento) e Regra B (bypass por rota/produto)
    // policy2 = pol_rcdc_translog: mantém o comportamento equivalente ao antigo aceita_averbacao_como_destinatario=true,
    // agora modelado como regra explícita — e ganha mais uma função habilitada (Tomador) para exercitar a Regra A completa.
    this.policyTitularityRules = [
      { id: uuidv4(), policy_id: policy2.id, funcao: 'DESTINATARIO', habilitada: true },
      { id: uuidv4(), policy_id: policy2.id, funcao: 'TOMADOR', habilitada: true },
      { id: uuidv4(), policy_id: policy2.id, funcao: 'REMETENTE', habilitada: false },
      { id: uuidv4(), policy_id: policy2.id, funcao: 'EXPEDIDOR', habilitada: false },
      { id: uuidv4(), policy_id: policy2.id, funcao: 'RECEBEDOR', habilitada: false }
    ];

    // Regra B de exemplo: policy1 (Expressa/RCTRC) aceita bypass sem CNPJ no documento
    // para viagens com rota SP -> SP (útil para testar o cenário de "CNPJ ausente do documento").
    this.policyBypassRules = [
      { id: uuidv4(), policy_id: policy1.id, rota_uf_origem: 'SP', rota_uf_destino: 'SP' }
    ];
  }
}

export const dbStore = new DBStore();
