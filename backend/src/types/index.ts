export type TenantEnvironment = 'teste' | 'producao';
export type TenantStatus = 'ATIVO' | 'INATIVO';
export type UserRole = 'ADMIN' | 'SEGURADORA' | 'CORRETORA' | 'TRANSPORTADOR';
export type RamoApolice = 'RCTRC' | 'RCDC' | 'RCV';
export type TipoDocumento = 'CTE' | 'NFE' | 'NFSE' | 'MDFE';
export type InternalUserRole = 'ADM' | 'AGENTE';
export type FuncaoDocumento = 'EMISSOR' | 'DESTINATARIO' | 'REMETENTE' | 'TOMADOR' | 'EXPEDIDOR' | 'RECEBEDOR';
export type DelegationAction =
  | 'CRIAR_CLIENTE'
  | 'EDITAR_CLIENTE'
  | 'CRIAR_APOLICE'
  | 'EDITAR_APOLICE'
  | 'CRIAR_COBERTURA_ADICIONAL'
  | 'EDITAR_COBERTURA_ADICIONAL';

export interface Tenant {
  id: string;
  cnpj: string;
  razao_social: string;
  status: TenantStatus;
  ambiente: TenantEnvironment;
  client_id: string;
  client_secret_hash: string;
  role: UserRole;
  token_duration_hours: number;
  created_at: string;
  // Contato do cliente (usado no cadastro pela seguradora)
  contato_nome?: string;
  contato_email?: string;
  contato_telefone_fixo?: string;
  contato_celular?: string;
  // Nome fantasia e endereço (coletados no wizard "Novo Cadastro" da seguradora — antes eram
  // preenchidos na tela e descartados no envio, nunca chegavam a ser persistidos aqui).
  nome_fantasia?: string;
  logradouro?: string;
  numero_endereco?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
  cep?: string;
  // Ativação de conta (Termo de Uso) — só relevante para role = TRANSPORTADOR
  conta_ativada?: boolean;
}

export interface Insurer {
  id: string;
  tenant_id?: string; // vínculo com o tenant (role=SEGURADORA) dono deste perfil
  cnpj: string;
  nome: string; // mantido por compatibilidade; preferir razao_social/nome_fantasia
  razao_social?: string;
  nome_fantasia?: string;
  created_at: string;
}

export interface Broker {
  id: string;
  tenant_id?: string; // vínculo com o tenant (role=CORRETORA) dono deste perfil
  cnpj: string;
  nome: string; // mantido por compatibilidade; preferir razao_social/nome_fantasia
  razao_social?: string;
  nome_fantasia?: string;
  corretor_responsavel_nome?: string;
  corretor_responsavel_email?: string;
  corretor_responsavel_telefone_fixo?: string;
  corretor_responsavel_celular?: string;
  created_at: string;
}

export interface Policy {
  id: string;
  numero_apolice: string;
  ramo: RamoApolice;
  tenant_id: string; // Transportador / Embarcador vinculado
  insurer_id: string;
  broker_id: string; // Corretora líder — obrigatória
  co_broker_id?: string; // Co-corretora — opcional
  assessoria_id?: string; // Assessoria — opcional, mesma visibilidade/funções de Broker
  status: 'ATIVA' | 'INATIVA' | 'VENCIDA';
  permitir_inativo_vencido: boolean;
  vigencia_inicio: string;
  vigencia_fim: string;
  lmi?: number; // Limite Máximo da Apólice
  /** @deprecated usar PolicyTitularityRule com funcao='DESTINATARIO'. Mantido por compatibilidade. */
  aceita_averbacao_como_destinatario: boolean;
}

/**
 * Regra A da Titularidade v2 — define em quais funções do documento fiscal o CNPJ do
 * segurado pode aparecer para a averbação ser aceita (além de EMISSOR, que é sempre aceito).
 */
export interface PolicyTitularityRule {
  id: string;
  policy_id: string;
  funcao: FuncaoDocumento;
  habilitada: boolean;
}

/**
 * Regra B da Titularidade v2 — bypass: aceita a averbação mesmo sem o CNPJ do segurado
 * aparecer em nenhuma função do documento, desde que a rota e/ou o produto predominante
 * batam com o configurado. Pelo menos um dos três campos precisa estar preenchido.
 */
export interface PolicyBypassRule {
  id: string;
  policy_id: string;
  rota_uf_origem?: string;
  rota_uf_destino?: string;
  produto_predominante?: string;
}

/**
 * Variável de negócio específica de uma APÓLICE (definida pela seguradora/corretora
 * para aquela cobertura, ex: "Container", "Valor Declarado"). NÃO confundir com
 * DocumentRule, que é a obrigatoriedade de tags do PADRÃO SEFAZ por tipo de documento.
 */
export interface PolicyRule {
  id: string;
  policy_id: string;
  tipo_doc: TipoDocumento | 'TODOS';
  tag_path: string; // Ex: "infCte.vPrest.vRec" ou "infCpl" ou "xObs"
  nome_variavel: string;
  obrigatoria: boolean;
  exemplo_preenchimento?: string; // Valor de exemplo usado ao gerar XML MOCK com esta variável
  instrucao_recuperacao?: string;
}

/**
 * Regra de obrigatoriedade de TAG por TIPO DE DOCUMENTO (CTE, NFE, NFSE, MDFE),
 * independente de qual apólice/seguradora está sendo usada. As tags nativas do
 * padrão Sefaz já nascem cadastradas (origem = 'SEFAZ_PADRAO'), mas podem ser
 * editadas, ter a obrigatoriedade alternada, ou removidas pelo administrador.
 * Novas tags customizadas podem ser incluídas (origem = 'CUSTOM').
 */
export interface DocumentRule {
  id: string;
  tipo_documento: TipoDocumento;
  tag_path: string;
  nome_variavel: string;
  obrigatoria: boolean;
  origem: 'SEFAZ_PADRAO' | 'CUSTOM';
  observacao?: string;
  created_at: string;
}

export interface ResponseTemplate {
  id: string;
  codigo: string;
  tipo: 'sucesso' | 'erro' | 'aviso';
  categoria: 'AUTENTICACAO' | 'CADASTRO' | 'APOLICE' | 'REGRA_XML' | 'SISTEMA';
  texto_padrao: string;
  texto_customizado: string;
  placeholders: string[];
  explicacao_nao_tecnica?: string; // texto simples, sem jargão de XML/tag — usado na visão do transportador
  orientacao_correcao?: string; // o que o usuário deve fazer para resolver (só relevante para tipo='erro')
  updated_at: string;
}

export interface RawXMLStore {
  id: string;
  content_xml: string;
  hash_sha256: string;
  encrypted_aes256: boolean;
  created_at: string;
}

export interface Averbacao {
  id: string;
  /** Ausente em registros status='ERRO' — só é gerado quando a averbação é aceita. */
  numero_averbacao?: string;
  protocolo_interno_averbacao: string; // identificador interno nosso, independente do formato "de mercado" do nAver
  tenant_id: string;
  policy_id: string;
  status: 'SUCESSO' | 'ERRO';
  codigo_resposta: string;
  mensagem_resposta: string;
  valor_carga: number; // valor bruto extraído do documento (vCarga/vProd/etc.)
  valor_considerado_averbacao: number; // valor_carga + coberturas adicionais monetárias somadas
  regras_internas_aplicadas: string[]; // ex: "Cobertura 'Container' somada (R$ 25.000,00)", "Bypass de apólice vencida aplicado"
  tp_amb_sefaz?: 1 | 2; // 1=produção, 2=homologação — extraído do XML, independente do tenant.ambiente
  tipo_documento: TipoDocumento;
  chave_documento: string;
  numero_documento?: string; // número "de mercado" do próprio documento (nCT/nNF/nMDF), não o número da averbação
  serie_documento?: string; // ide.serie do CT-e/NF-e/MDF-e
  cnpj_remetente?: string;
  cnpj_destinatario?: string;
  cnpj_tomador?: string;
  protocolo_aceitacao_sefaz?: string; // nProt do protXXX/infProt do XML, usado na deduplicação
  raw_xml_id: string;
  recovery_token?: string;
  ambiente: TenantEnvironment;
  timestamp: string;
  created_at: string;
}

export interface RecoverySession {
  token: string;
  tenant_id: string;
  policy_id: string;
  tipo_documento: TipoDocumento;
  raw_xml_content: string;
  variaveis_faltantes: string[];
  expira_em: string;
  utilizada: boolean;
  created_at: string;
}

export interface BatchTestRun {
  id: string;
  total_docs: number;
  distribuicao: 'ROUND_ROBIN' | 'CUSTOM';
  status: 'PENDENTE' | 'PROCESSANDO' | 'CONCLUIDO';
  configuracao_clientes: { tenant_id: string; quantidade: number }[];
  metricas_globais: {
    total: number;
    sucessos: number;
    erros: number;
    tempo_total_ms: number;
    throughput_docs_sec: number;
  };
  metricas_por_cliente: {
    [tenant_id: string]: {
      cnpj: string;
      razao_social: string;
      total: number;
      sucessos: number;
      erros: number;
      tempo_medio_ms: number;
    };
  };
  created_at: string;
}

// ===================== VISÃO EMPRESA (ADM / AGENTE) =====================

export interface InternalUser {
  id: string;
  nome: string;
  email: string;
  password_hash: string;
  role: InternalUserRole;
  rbac_profile_id?: string; // só relevante para AGENTE
  status: 'ATIVO' | 'INATIVO';
  created_at: string;
}

// ===================== RBAC (Perfis de Acesso) =====================

export type RbacPermissionLevel = 'ver' | 'editar' | 'sem_acesso';

export interface RbacProfile {
  id: string;
  owner_type: 'SEGURADORA' | 'CORRETORA' | 'ARCKATECH';
  owner_id?: string; // nulo quando owner_type = ARCKATECH
  nome_perfil: string;
  permissions: {
    apolices: RbacPermissionLevel;
    clientes: RbacPermissionLevel;
    coberturas: RbacPermissionLevel;
    relatorios: RbacPermissionLevel;
    usuarios: RbacPermissionLevel;
    delegacao_corretora: RbacPermissionLevel;
  };
  created_at: string;
}

export interface TenantUser {
  id: string;
  tenant_id: string;
  nome: string;
  email: string;
  password_hash: string;
  rbac_profile_id?: string; // opcional para TRANSPORTADOR (ver is_admin_da_conta)
  is_admin_da_conta?: boolean; // usado só quando tenant.role = TRANSPORTADOR
  status: 'ATIVO' | 'INATIVO';
  created_at: string;
}

// ===================== COBERTURAS ADICIONAIS (nível Seguradora) =====================

export interface InsurerCoverageTemplate {
  id: string;
  titulo: string;
  ativo: boolean;
  created_at: string;
}

export interface InsurerCoverage {
  id: string;
  insurer_id: string;
  ramo?: RamoApolice; // nulo = aplica a todos os ramos daquela seguradora
  titulo: string;
  exemplo_preenchimento?: string;
  obrigatoria: boolean;
  aplicar_todos_clientes: boolean;
  tenant_id?: string; // obrigatório se aplicar_todos_clientes = false
  tipo_valor: 'monetario' | 'informativo'; // monetário soma ao valor final da averbação; informativo não
  created_at: string;
}

// ===================== DELEGAÇÃO SEGURADORA → CORRETORA =====================

export interface DelegationPermission {
  id: string;
  insurer_id: string;
  broker_id: string;
  action: DelegationAction;
  requires_approval: boolean;
}

export interface ApprovalRequest {
  id: string;
  insurer_id: string;
  broker_id: string;
  action: DelegationAction;
  payload: Record<string, any>;
  status: 'PENDENTE' | 'APROVADO' | 'REJEITADO';
  created_at: string;
  resolved_at?: string;
  resolved_by?: string;
}

/**
 * Override da matriz de delegação (DelegationPermission) para um segurado específico dentro da
 * carteira de uma corretora — aba "Exceções por segurado" em Permissões e Autonomia. Ao contrário
 * de DelegationPermission (que é por ação), a exceção é um único nível que vale para TODAS as
 * ações daquele segurado, e tem prioridade sobre a matriz geral quando existe:
 * - AUTONOMO: nunca exige aprovação para esse segurado, mesmo que a ação exija na matriz geral.
 * - MEDIANTE_APROVACAO: sempre exige aprovação para esse segurado, mesmo que a ação seja
 *   autônoma na matriz geral.
 * - BLOQUEADA: a corretora não pode executar nenhuma ação delegada para esse segurado (nem
 *   direto, nem via aprovação) — usado para suspender a autonomia de um cliente específico.
 */
export type DelegationExceptionLevel = 'AUTONOMO' | 'MEDIANTE_APROVACAO' | 'BLOQUEADA';

export interface DelegationException {
  id: string;
  insurer_id: string;
  broker_id: string;
  tenant_id: string;
  nivel: DelegationExceptionLevel;
  created_at: string;
  updated_at: string;
}

/**
 * Valor real de uma Cobertura Adicional (InsurerCoverage) dentro de uma apólice específica.
 * InsurerCoverage é só a *definição* da cobertura (título, tipo monetário/informativo,
 * obrigatoriedade, escopo) — não tem valor nenhum atribuído. PolicyCoverageValue é o registro de
 * "esta cobertura X está ativada nesta apólice Y, com valor R$ Z". `desconta_lmi` indica se esse
 * valor deve ser descontado do LMI da apólice no cálculo de limite de averbação — por decisão de
 * escopo, este campo é apenas persistido nesta rodada e AINDA NÃO é lido pelo AverbacaoService
 * (mesma decisão já tomada para os demais filtros da Regra B): mudar o motor de cálculo de limite
 * financeiro exige validação de produto antes de entrar em produção.
 */
export interface PolicyCoverageValue {
  id: string;
  policy_id: string;
  insurer_coverage_id: string;
  valor: number;
  desconta_lmi: boolean;
  created_at: string;
  updated_at: string;
}

// ===================== ATIVAÇÃO DE CONTA (TRANSPORTADOR) =====================

export interface ActivationToken {
  id: string;
  tenant_id: string;
  token: string;
  termo_versao: string;
  aceite: boolean;
  aceite_em?: string;
  expira_em: string;
  created_at: string;
  // Convite unificado (Termo de Uso + primeira senha, ver POST /tenant/activation/:token/definir-senha) —
  // nome/e-mail da pessoa convidada, usados para criar o TenantUser inicial no momento do aceite e para
  // montar o e-mail de convite enviado via Resend (ver services/emailService.ts). Sem esses dois campos
  // preenchidos, o token ainda funciona no fluxo antigo (POST /activation/:token/aceitar, só Termo de Uso).
  convite_nome?: string;
  convite_email?: string;
}

// ===================== PREFERÊNCIAS DE NOTIFICAÇÃO =====================

export interface NotificationPreference {
  id: string;
  tenant_user_id: string;
  canal: 'EMAIL' | 'PORTAL' | 'SMS';
  ativo: boolean;
}

// ===================== REGRAS DE NEGÓCIO (SOLICITAÇÃO DO TRANSPORTADOR) =====================

/**
 * Solicitação de uma nova regra de negócio (ex: condição por valor de carga, papel do CNPJ
 * na averbação) feita pelo transportador/embarcador à seguradora, via Portal do Segurado.
 * MVP: só o lado do transportador (criar/consultar). A aprovação/rejeição pela seguradora é
 * feita por quem administra o painel interno (via /admin), ainda sem tela dedicada no Portal
 * da Seguradora — só a API.
 */
export interface BusinessRuleRequest {
  id: string;
  tenant_id: string;
  tipo: string; // ex: "Papel do CNPJ na averbação", "Condição por valor de carga"
  descricao?: string;
  status: 'PENDENTE' | 'APROVADA' | 'REJEITADA';
  solicitante_nome: string;
  comentario_seguradora?: string;
  created_at: string;
  resolved_at?: string;
}

/**
 * Chamado de suporte aberto pelo transportador/embarcador via Portal do Segurado. Achado da
 * auditoria de 27/08: a tela de Suporte só disparava um toast de sucesso no cliente, sem nenhuma
 * chamada de API — nada era persistido. MVP no mesmo espírito de `BusinessRuleRequest`: o tenant
 * cria e consulta os próprios chamados; sem fluxo de resposta/atendimento do lado da seguradora
 * ainda (fica para quando existir uma tela de suporte interna de verdade).
 */
export interface SupportTicket {
  id: string;
  tenant_id: string;
  assunto: string;
  categoria: string;
  descricao: string;
  status: 'ABERTO' | 'FECHADO';
  solicitante_nome: string;
  created_at: string;
}

// ===================== CONFIGURAÇÕES DA FICHA DO SEGURADO (PORTAL DA SEGURADORA) =====================

/**
 * Configurações de negócio de uma APÓLICE que ainda não ganharam modelagem normalizada
 * própria — Métodos de Averbação, Subcontratação, Veículo e Motorista, Prazos e Datas,
 * Região Metropolitana, Valor da Averbação e Averbação Esporádica (todas sub-seções da
 * aba "Regras de Negócio" da Ficha do Segurado, ver arckatechseguradora/src/components/
 * portal/regras-negocio.tsx). Guardadas como um único blob JSON por apólice em vez de uma
 * tabela por sub-seção — essas telas ainda mudam com frequência junto com o produto, e uma
 * tabela rígida por campo travaria a entrega. NÃO inclui Identificação do Segurado
 * (Regra A / Regra B): essas já têm modelagem própria e imposição real no motor de regras
 * (ver PolicyTitularityRule / PolicyBypassRule) — o campo `config.identificacaoRegraB` aqui
 * guarda só os detalhes extras de exibição do construtor de condições da Regra B (CNPJ,
 * produto, valor de corte, CFOP etc.) que o motor de regras ainda NÃO aplica hoje; o que o
 * motor realmente impõe no bypass continua sendo só rota_uf_origem / rota_uf_destino /
 * produto_predominante em PolicyBypassRule.
 */
export interface PolicyBusinessSettings {
  id: string;
  policy_id: string;
  config: Record<string, any>;
  updated_at: string;
}

/**
 * Sublimite de cobertura por palavra-chave de mercadoria, específico de uma apólice
 * (aba "Sublimites por Mercadoria" da Ficha do Segurado).
 */
export interface PolicySublimite {
  id: string;
  policy_id: string;
  tag: string;
  valor: string;
  created_at: string;
}
