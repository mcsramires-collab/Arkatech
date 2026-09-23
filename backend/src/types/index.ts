export type TenantEnvironment = 'teste' | 'producao';
export type TenantStatus = 'ATIVO' | 'INATIVO';
export type UserRole = 'ADMIN' | 'SEGURADORA' | 'CORRETORA' | 'TRANSPORTADOR';
export type RamoApolice = 'RCTRC' | 'RCDC' | 'RCV';
export type TipoDocumento = 'CTE' | 'NFE' | 'NFSE' | 'MDFE';
export type InternalUserRole = 'ADM' | 'AGENTE';
// 'TRANSPORTADOR' — item 6.6.2 do relatório técnico de 20/09 (compartilhado pelo usuário):
// segurado que é o transportador de uma NF-e sem ser quem a emite. Extraído do grupo
// transp/transporta/CNPJ da NF-e (ver XMLParserService.cnpjTransportador) — distinto de EMISSOR,
// que no CT-e já é sempre o próprio transportador (por isso essa função só faz sentido pra NF-e).
export type FuncaoDocumento =
  | 'EMISSOR'
  | 'DESTINATARIO'
  | 'REMETENTE'
  | 'TOMADOR'
  | 'EXPEDIDOR'
  | 'RECEBEDOR'
  | 'TRANSPORTADOR';
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
  /**
   * Teto (em horas) até onde a própria seguradora/corretora pode ajustar seu
   * `token_duration_hours` via `PUT /admin/tenants/me/session-duration` — Fase 5 do item "Login
   * real + RBAC" (Backlog, seção 4). Só a administração Arckatech pode alterar este campo (ver
   * `PUT /admin/tenants/:id`). Opcional: quando ausente, vale `DEFAULT_TOKEN_DURATION_MAX_HOURS`
   * (ver `routes/admin.ts`) — evitou precisar tocar em todo tenant já semeado.
   */
  token_duration_max_hours?: number;
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
  /**
   * Código Interno da Seguradora (item 3.5 do relatório técnico de 13/09, compartilhado pelo
   * usuário) — usado para conciliação com os sistemas próprios da seguradora. Texto livre,
   * opcional, válido para qualquer ramo (movido de "Configurações do RC-V" para Dados Gerais da
   * Apólice no frontend em v4.17, mas nunca chegava a ser enviado à API até esta rodada).
   */
  codigo_interno_seguradora?: string;
  /**
   * Suspensão de Apólice (relatório de negócios de 20/09) — período em que a apólice fica
   * suspensa sem precisar cancelar o cadastro inteiro. `suspensa_desde` presente = existe um
   * registro de suspensão; ausência de `suspensa_ate` = prazo indeterminado. "Está suspensa
   * agora" é sempre calculado (`agora >= desde && (sem ate || agora <= ate)`), nunca lido de um
   * boolean solto — evita ficar `true` para sempre depois que o prazo já passou. Reativar
   * (`DELETE /admin/policies/:id/suspensao`) limpa os dois campos, encerrando a suspensão na
   * hora — não preserva histórico de suspensões passadas nesta primeira versão.
   */
  suspensa_desde?: string;
  suspensa_ate?: string;
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
  /**
   * Fase 4 do pacote de 21/09 (compartilhado pelo usuário — relatórios de Tratamento de Recusas
   * e o arquivo documentos-pendentes-campos-api.md, os dois pedindo essencialmente a mesma coisa
   * de lados diferentes): antes só existiam SUCESSO/ERRO, definitivos. Agora:
   * - PENDENTE_APROVACAO: o motor encontrou um motivo de recusa que a apólice configurou para
   *   esperar decisão humana em vez de recusar na hora (cadastro/apólice inativa, vigência
   *   vencida, apólice suspensa, limite/sublimite excedido conforme a estratégia de Tratamento
   *   de Recusas, ou qualquer outro motivo quando a "fila genérica" do Bloco 2 está ligada).
   *   Resolvido por POST /admin/averbacoes/:id/decidir.
   * - CANCELADO_NAO_AVERBADO: documento pendente cancelado sem nunca ter sido averbado — status
   *   novo e distinto do "Cancelado" (que no vocabulário do produto significa "foi averbado e
   *   depois cancelado", conceito que ainda não existe no motor). Só alcançável a partir de
   *   PENDENTE_APROVACAO, via POST /admin/averbacoes/:id/cancelar.
   * Variável obrigatória faltante (ERR-4004) e XML malformado (ERR-4005) continuam fora dessa
   * fila — não fazem sentido como "aguardando decisão humana" (o primeiro já tem seu próprio
   * fluxo de recuperação; o segundo não tem o que esperar sem um arquivo novo).
   */
  status: 'SUCESSO' | 'ERRO' | 'PENDENTE_APROVACAO' | 'CANCELADO_NAO_AVERBADO';
  codigo_resposta: string;
  mensagem_resposta: string;
  /**
   * Preenchido só quando status='PENDENTE_APROVACAO' (e mantido depois de decidido, para
   * histórico) — motivo que levou à fila, no mesmo vocabulário de codigo_resposta (ex.:
   * 'ERR-4010', 'ERR-4017'). Existe separado de codigo_resposta porque, ao decidir, o código de
   * resposta final muda (SUC-2000 se aprovado, o código original se recusado) mas o motivo de
   * por que esperou continua relevante para auditoria.
   */
  motivo_pendencia?: string;
  /**
   * Snapshot do LMI da apólice e do sublimite (quando algum foi comparado) no momento do envio —
   * sugestão de melhoria registrada no documento de validação técnica: sem isso, consultar uma
   * averbação antiga depois que a seguradora mudou o limite mostraria um limite que não é o que
   * valia na hora. Ausentes quando nenhum dos dois chegou a ser comparado.
   */
  lmi_no_momento_envio?: number;
  sublimite_no_momento_envio?: number;
  /** Preenchido quando um código de liberação (Averbação Esporádica) foi usado para liberar este documento. */
  codigo_liberacao_utilizado?: string;
  /** Quem decidiu um PENDENTE_APROVACAO (aprovar/recusar) — auditoria simples; não referencia RBAC. */
  decidido_por?: string;
  decidido_em?: string;
  valor_carga: number; // valor bruto extraído do documento (vCarga/vProd/etc.)
  valor_considerado_averbacao: number; // valor_carga + coberturas adicionais monetárias somadas
  regras_internas_aplicadas: string[]; // ex: "Cobertura 'Container' somada (R$ 25.000,00)", "Bypass de apólice vencida aplicado"
  tp_amb_sefaz?: 1 | 2; // 1=produção, 2=homologação — extraído do XML, independente do tenant.ambiente
  tipo_documento: TipoDocumento;
  chave_documento: string;
  numero_documento?: string; // número "de mercado" do próprio documento (nCT/nNF/nMDF), não o número da averbação
  serie_documento?: string; // ide.serie do CT-e/NF-e/MDF-e
  cnpj_emissor?: string; // emit.CNPJ do documento — já extraído pelo XMLParser (usado na checagem de titularidade), só não era persistido até 05/09
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
 * Tipo de condição de um sublimite — item D-10 do relatório técnico do wizard de cadastro
 * (31/08, compartilhado pelo usuário): antes só existia por mercadoria (tag); agora também pode
 * ser por CNPJ do tomador, ou pela combinação dos dois. Quando mais de um sublimite bate com o
 * mesmo documento, a condição mais específica prevalece — ver `RuleEngineService`/checagem em
 * `AverbacaoService.process()` (passo 9c): tomador_mercadoria > tomador > mercadoria.
 */
export type TipoCondicaoSublimite = 'mercadoria' | 'tomador' | 'tomador_mercadoria';

/**
 * Sublimite de cobertura, específico de uma apólice (aba "Sublimites" da Ficha do Segurado).
 * `tag` (palavra-chave de mercadoria) é obrigatória para `tipo_condicao` 'mercadoria' e
 * 'tomador_mercadoria', mas ausente para 'tomador' puro. `cnpj_tomador` é obrigatório para
 * 'tomador' e 'tomador_mercadoria', ausente para 'mercadoria' puro — ver validação em
 * `POST /admin/policy-sublimites`.
 */
export interface PolicySublimite {
  id: string;
  policy_id: string;
  tag?: string;
  valor: string;
  /** Ausente = 'mercadoria', para compatibilidade com sublimites cadastrados antes do D-10. */
  tipo_condicao?: TipoCondicaoSublimite;
  cnpj_tomador?: string;
  created_at: string;
}

// ===================== REVOGAÇÃO DE SESSÃO (LOGIN REAL + RBAC, FASE 5 — ITEM 3) =====================

/**
 * Registro de um token de backoffice (emitido por `POST /auth/backoffice-login`) revogado antes
 * do vencimento natural — item 3 da Fase 5 do "Login real + RBAC" (Backlog, seção 4). O sistema
 * é stateless por padrão (JWT sem nenhum registro no servidor); esta lista é o único estado do
 * lado do servidor, e existe só para os `jti` explicitamente revogados — a imensa maioria dos
 * tokens nunca aparece aqui, e cada entrada pode ser descartada com segurança assim que
 * `expires_at` passa (ver `DBStore.isTokenRevoked`/`DBStore.revokeToken`, que fazem essa limpeza
 * de forma preguiçosa a cada chamada, sem precisar de um job separado).
 *
 * Desenho escolhido (opção "a" do desenho mapeado no Backlog): lista de `jti` revogados, não uma
 * tabela completa de sessões ativas (opção "b", mais completa — permitiria listar "onde estou
 * logado" e "sair de todos os dispositivos", mas não foi pedida agora). Resolve o caso de uso
 * confirmado: logout que de fato invalida o token no servidor, não só localmente.
 */
export interface RevokedToken {
  /** Claim `jti` do JWT revogado — identificador único gerado em cada emissão (ver auth.ts). */
  jti: string;
  /** Epoch ms igual ao `exp` do próprio token — permite descartar a entrada quando o token já
   *  expiraria de qualquer forma, sem checar revogação para sempre. */
  expires_at: number;
  /** Epoch ms de quando a revogação foi registrada (auditoria/depuração). */
  revoked_at: number;
  /** `BackofficeAuthenticatedRequest['backoffice'].user_id` de quem era dono do token — auditoria;
   *  não usado para autorizar nada. */
  user_id?: string;
  /** Motivo da revogação — hoje só 'logout', mas o campo já existe para futuros motivos
   *  (ex.: desativação de usuário, "sair de todos os dispositivos" — ver Backlog). */
  motivo: string;
}

// ===================== CNPJs ADICIONAIS / FILIAIS (Fase 1, pacote de 21/09) =====================

/**
 * CNPJ adicional ou filial de um Tenant — achado do relatório técnico de 20/09 (compartilhado
 * pelo usuário): desde sempre, o que era preenchido nessa parte do wizard nunca chegava a ser
 * persistido de verdade (só aparecia na tela e se perdia). Esta entidade corrige isso.
 *
 * Escopo desta primeira versão, deixado explícito porque o relatório descreve um comportamento
 * mais amplo que este modelo ainda não cobre por completo: a regra de "inativar o último CNPJ
 * ativo inativa o cadastro inteiro" NÃO está implementada aqui — o CNPJ principal (`Tenant.cnpj`)
 * não é uma linha nesta lista, é um campo à parte sem status próprio, então não existe hoje uma
 * lista unificada "principal + adicionais" para calcular "o último que restou". Inativar/reativar
 * um CNPJ adicional aqui NUNCA muda `Tenant.status` automaticamente — isso continua uma ação
 * explícita via `PUT /admin/tenants/:id`. Unificar os dois modelos é uma mudança maior, deixada
 * para uma rodada própria caso a cascata automática seja de fato necessária.
 *
 * Imutabilidade: uma vez cadastrado, `cnpj` nunca é editado nem excluído fisicamente — só
 * inativado/reativado via `status` (regra confirmada pelo usuário no relatório de 13/09).
 */
export interface TenantCnpjAdicional {
  id: string;
  tenant_id: string;
  cnpj: string;
  tipo: 'filial' | 'adicional'; // filial = mesma raiz de 8 dígitos do principal; adicional = raiz diferente
  status: 'ATIVO' | 'INATIVO';
  created_at: string;
}

// ===================== HISTÓRICO DE VÍNCULOS (Fase 3, pacote de 21/09) =====================

/**
 * Histórico de vínculo de uma apólice com uma Corretora Líder/Cocorretora/Assessoria — relatório
 * de negócios de 20/09 (compartilhado pelo usuário): "Trocar Corretora/Cocorretora/Assessoria" é
 * tratado como nova vigência do vínculo, não uma sobrescrita — fecha o vínculo antigo (
 * `vigencia_fim = novo_vigencia_inicio - 1 dia`) e abre um novo, preservando o histórico completo.
 *
 * `Policy.broker_id`/`co_broker_id`/`assessoria_id` continuam existindo como estão hoje — são o
 * *cache* do vínculo atualmente vigente para cada papel, exatamente para não quebrar nenhum
 * lugar do sistema que já lê esses três campos diretamente. Esta tabela é a fonte de verdade por
 * trás do "Histórico de Parcerias"; toda troca atualiza os dois em conjunto (ver
 * `POST /admin/policies/:id/trocar-parceria` em `routes/admin.ts`).
 *
 * Um registro inicial (vigencia_fim ausente) é criado automaticamente para cada papel presente
 * na criação da apólice — é o que faz "Histórico de Parcerias" aparecer sempre, mesmo sem
 * nenhuma troca ainda (item 8 da lista de ajustes pontuais do relatório de 20/09).
 *
 * Fora de escopo nesta rodada, por decisão registrada no documento de validação técnica: o
 * disparo de notificação para a corretora nova decidir sobre embarques retroativos (não existe
 * canal de notificação real hoje) — a troca retroativa é permitida e registrada normalmente, só
 * sem nenhum aviso automático.
 */
export interface PolicyPartnerHistory {
  id: string;
  policy_id: string;
  papel: 'lider' | 'cocorretora' | 'assessoria';
  broker_id: string;
  vigencia_inicio: string;
  /** Ausente = vínculo atualmente vigente para este papel. */
  vigencia_fim?: string;
  created_at: string;
}

// ===================== CÓDIGO DE LIBERAÇÃO DE LIMITE (Fase 4, pacote de 21/09) =====================

/**
 * Motor de Código de Liberação de Limite (Averbação Esporádica real) — desenhado em sessão de
 * PRD anterior (ver relatório técnico de 13/09, seção 3.6, compartilhado pelo usuário) mas nunca
 * implementado até esta rodada. Necessário para a estratégia `'exigir-codigo'` do Bloco 1 de
 * Tratamento de Recusas (ver `AverbacaoService`) funcionar de verdade — sem isso, essa estratégia
 * (a padrão, segundo o relatório) recusaria qualquer excedente sem nenhum caminho de liberação.
 *
 * Um código é específico de uma apólice, com validade, um número máximo de usos (ausente =
 * ilimitado) e um valor liberado — para carga e, opcionalmente, para cobertura adicional. Cada
 * uso bem-sucedido incrementa `usos_realizados`; o código para de valer quando `usos_realizados
 * >= usos_maximos` OU a validade passou, o que vier primeiro.
 */
export interface LiberationCode {
  id: string;
  policy_id: string;
  codigo: string; // único dentro da apólice — normalizado (maiúsculas, sem espaço) na comparação
  validade: string; // ISO — depois desta data o código não vale mais, mesmo com usos sobrando
  usos_maximos?: number; // ausente = ilimitado (dentro da validade)
  usos_realizados: number;
  valor_carga_liberado?: number;
  valor_cobertura_adicional_liberado?: number;
  ativo: boolean; // permite desativar manualmente antes da validade, sem apagar o histórico de uso
  created_at: string;
}
