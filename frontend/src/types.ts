export type TenantEnvironment = 'teste' | 'producao';
export type TenantStatus = 'ATIVO' | 'INATIVO';
export type RamoApolice = 'RCTRC' | 'RCDC' | 'RCV';
export type TipoDocumento = 'CTE' | 'NFE' | 'NFSE';

export interface Tenant {
  id: string;
  cnpj: string;
  razao_social: string;
  status: TenantStatus;
  ambiente: TenantEnvironment;
  client_id: string;
  client_secret_hash: string;
  role: string;
  token_duration_hours: number;
  created_at: string;
}

export interface Insurer {
  id: string;
  cnpj: string;
  nome: string;
}

export interface Broker {
  id: string;
  cnpj: string;
  nome: string;
}

export interface Policy {
  id: string;
  numero_apolice: string;
  ramo: RamoApolice;
  tenant_id: string;
  insurer_id: string;
  broker_id: string;
  status: 'ATIVA' | 'INATIVA' | 'VENCIDA';
  permitir_inativo_vencido: boolean;
  vigencia_inicio: string;
  vigencia_fim: string;
}

export interface PolicyRule {
  id: string;
  policy_id: string;
  tipo_doc: TipoDocumento | 'TODOS';
  tag_path: string;
  nome_variavel: string;
  obrigatoria: boolean;
  instrucao_recuperacao?: string;
}

export interface ResponseTemplate {
  id: string;
  codigo: string;
  tipo: 'sucesso' | 'erro' | 'aviso';
  categoria: string;
  texto_padrao: string;
  texto_customizado: string;
  placeholders: string[];
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
  ambiente: TenantEnvironment;
  timestamp: string;
  created_at: string;
}

export interface BatchTestRun {
  id: string;
  total_docs: number;
  distribuicao: 'ROUND_ROBIN' | 'CUSTOM';
  status: 'PENDENTE' | 'PROCESSANDO' | 'CONCLUIDO';
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
