export type TenantEnvironment = 'teste' | 'producao';
export type TenantStatus = 'ATIVO' | 'INATIVO';
export type UserRole = 'ADMIN' | 'SEGURADORA' | 'CORRETORA' | 'TRANSPORTADOR';
export type RamoApolice = 'RCTRC' | 'RCDC' | 'RCV';
export type TipoDocumento = 'CTE' | 'NFE' | 'NFSE' | 'MDFE';

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
}

export interface Insurer {
  id: string;
  cnpj: string;
  nome: string;
  created_at: string;
}

export interface Broker {
  id: string;
  cnpj: string;
  nome: string;
  created_at: string;
}

export interface Policy {
  id: string;
  numero_apolice: string;
  ramo: RamoApolice;
  tenant_id: string; // Transportador / Embarcador vinculado
  insurer_id: string;
  broker_id: string;
  status: 'ATIVA' | 'INATIVA' | 'VENCIDA';
  permitir_inativo_vencido: boolean;
  vigencia_inicio: string;
  vigencia_fim: string;
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
  tenant_id: string;
  policy_id: string;
  status: 'SUCESSO' | 'ERRO';
  codigo_resposta: string;
  mensagem_resposta: string;
  valor_carga: number;
  tipo_documento: TipoDocumento;
  chave_documento: string;
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
