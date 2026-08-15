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
  numero_averbacao: string;
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
}

// ===================== PREFERÊNCIAS DE NOTIFICAÇÃO =====================

export interface NotificationPreference {
  id: string;
  tenant_user_id: string;
  canal: 'EMAIL' | 'PORTAL' | 'SMS';
  ativo: boolean;
}
