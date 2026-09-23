import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from '../services/dbStore';
import { Broker, DelegationException, DelegationExceptionLevel, PolicyBusinessSettings, PolicySublimite, TipoCondicaoSublimite, PolicyCoverageValue } from '../types';
import { aplicarAcaoDelegada } from '../services/delegatedActions';
import { BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';
import { requirePermission } from '../middleware/rbacMiddleware';
import { resolveInsurerId, policyPertenceAoAtor, apenasInternalUser } from './adminHelpers';

/**
 * Terceira parte de admin.ts (seções I a P) — extraída para arquivo próprio só por tamanho, ver
 * comentário em adminHelpers.ts. Mesmo prefixo /api/v1/admin (montada via
 * `router.use('/', adminSeguradora2Router)` em admin.ts).
 */
const router = Router();

// --- I. Fila de Aprovação (ações da corretora sujeitas a requires_approval) ---
// insurer_id é filtro opcional para ADM (preserva o comportamento de antes) e obrigatório,
// forçado pelo token, para SEGURADORA — mesmo padrão de GET /delegation-permissions acima.
router.get('/approval-requests', requirePermission('delegacao_corretora', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { status } = req.query;
  const ator = req.backoffice;
  let items = dbStore.approvalRequests;
  if (ator?.actor_type === 'SEGURADORA') {
    if (!ator.insurer_id) {
      return res.status(403).json({ status: 'erro', mensagem: 'Seu usuário não está vinculado a nenhuma seguradora — sem acesso a esta área.' });
    }
    items = items.filter((a) => a.insurer_id === ator.insurer_id);
  } else if (ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  } else if (req.query.insurer_id) {
    items = items.filter((a) => a.insurer_id === req.query.insurer_id);
  }
  if (status) items = items.filter((a) => a.status === status);
  return res.json({ status: 'sucesso', requests: items });
});

router.post('/approval-requests/:id/resolve', requirePermission('delegacao_corretora', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const { status, resolved_by } = req.body;

  const request = dbStore.approvalRequests.find((a) => a.id === id);
  if (!request) {
    return res.status(404).json({ status: 'erro', mensagem: 'Solicitação de aprovação não encontrada.' });
  }
  const ator = req.backoffice;
  if (ator?.actor_type === 'SEGURADORA' && request.insurer_id !== ator.insurer_id) {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta solicitação não pertence à sua seguradora.' });
  }
  if (ator?.actor_type !== 'SEGURADORA' && ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  if (status !== 'APROVADO' && status !== 'REJEITADO') {
    return res.status(400).json({ status: 'erro', mensagem: "status deve ser 'APROVADO' ou 'REJEITADO'." });
  }
  if (request.status !== 'PENDENTE') {
    return res.status(409).json({ status: 'erro', mensagem: 'Esta solicitação já foi resolvida anteriormente.' });
  }

  // Antes desta rodada, aprovar uma solicitação só mudava o status — nunca executava de fato a
  // ação pendente (ex: aprovar CRIAR_CLIENTE nunca criava o tenant/apólice). Ao aprovar, aplica a
  // ação de verdade via o mesmo serviço usado pelas rotas diretas em broker.ts.
  let resultadoAplicacao: unknown;
  if (status === 'APROVADO') {
    const resultado = aplicarAcaoDelegada(request.action, request.insurer_id, request.broker_id, request.payload);
    if (!resultado.ok) {
      const httpStatus = resultado.codigo === 'nao_encontrado' ? 404 : resultado.codigo === 'conflito' ? 409 : 400;
      return res.status(httpStatus).json({
        ...resultado,
        status: resultado.codigo,
        mensagem: `Solicitação aprovada, mas a ação não pôde ser aplicada: ${resultado.mensagem}`
      });
    }
    resultadoAplicacao = resultado;
  }

  request.status = status;
  request.resolved_at = new Date().toISOString();
  request.resolved_by = resolved_by;

  dbStore.persist();
  return res.json({ status: 'sucesso', request, resultado: resultadoAplicacao });
});

// --- J. Regra de Titularidade v2: Regra A (função no documento) ---
// policy_id é obrigatório e checado contra a apólice quando quem chama é uma SEGURADORA
// (policyPertenceAoAtor); ADM continua podendo listar tudo sem informar policy_id.
router.get('/policy-titularity-rules', requirePermission('apolices', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { policy_id } = req.query;
  if (req.backoffice?.actor_type === 'SEGURADORA' || policy_id) {
    if (!policyPertenceAoAtor(req, res, policy_id)) return;
  } else if (req.backoffice?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  let items = dbStore.policyTitularityRules;
  if (policy_id) items = items.filter((r) => r.policy_id === policy_id);
  return res.json({ status: 'sucesso', rules: items });
});

router.put('/policy-titularity-rules', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { policy_id, funcoes } = req.body;
  if (!policyPertenceAoAtor(req, res, policy_id)) return;
  if (!Array.isArray(funcoes)) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'funcoes (lista de { funcao, habilitada }) é obrigatório.'
    });
  }

  for (const item of funcoes) {
    const existing = dbStore.policyTitularityRules.find(
      (r) => r.policy_id === policy_id && r.funcao === item.funcao
    );
    if (existing) {
      existing.habilitada = Boolean(item.habilitada);
    } else {
      dbStore.policyTitularityRules.push({
        id: uuidv4(),
        policy_id,
        funcao: item.funcao,
        habilitada: Boolean(item.habilitada)
      });
    }
  }

  dbStore.persist();
  return res.json({
    status: 'sucesso',
    rules: dbStore.policyTitularityRules.filter((r) => r.policy_id === policy_id)
  });
});

// --- K. Regra de Titularidade v2: Regra B (bypass por rota/produto) ---
router.get('/policy-bypass-rules', requirePermission('apolices', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { policy_id } = req.query;
  if (req.backoffice?.actor_type === 'SEGURADORA' || policy_id) {
    if (!policyPertenceAoAtor(req, res, policy_id)) return;
  } else if (req.backoffice?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  let items = dbStore.policyBypassRules;
  if (policy_id) items = items.filter((r) => r.policy_id === policy_id);
  return res.json({ status: 'sucesso', rules: items });
});

router.post('/policy-bypass-rules', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { policy_id, rota_uf_origem, rota_uf_destino, produto_predominante } = req.body;
  if (!policyPertenceAoAtor(req, res, policy_id)) return;
  if (!rota_uf_origem && !rota_uf_destino && !produto_predominante) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Ao menos um de rota_uf_origem, rota_uf_destino ou produto_predominante deve ser informado.'
    });
  }

  const newRule = {
    id: uuidv4(),
    policy_id,
    rota_uf_origem,
    rota_uf_destino,
    produto_predominante
  };
  dbStore.policyBypassRules.push(newRule);
  dbStore.persist();
  return res.json({ status: 'sucesso', rule: newRule });
});

router.delete('/policy-bypass-rules/:id', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const rule = dbStore.policyBypassRules.find((r) => r.id === id);
  if (rule && !policyPertenceAoAtor(req, res, rule.policy_id)) return;
  if (!rule && req.backoffice?.actor_type !== 'INTERNAL_USER' && req.backoffice?.actor_type !== 'SEGURADORA') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  dbStore.policyBypassRules = dbStore.policyBypassRules.filter((r) => r.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Regra de bypass removida com sucesso.' });
});

// --- K. Solicitações de Regras de Negócio (visão da seguradora — aprovar/rejeitar o que o
// transportador/embarcador pediu em POST /tenant/regras-solicitacoes). Sem consumidor no Portal
// da Seguradora hoje, e BusinessRuleRequest não tem insurer_id no modelo — restrito a ADM até
// esse campo existir (ver relatório de Fase 5 para essa pendência de escopo). ---
router.get('/regras-solicitacoes', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { tenant_id, status } = req.query;
  let items = dbStore.businessRuleRequests;
  if (tenant_id) items = items.filter((r) => r.tenant_id === tenant_id);
  if (status) items = items.filter((r) => r.status === status);
  return res.json({ status: 'sucesso', solicitacoes: items });
});

router.put('/regras-solicitacoes/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  const { status, comentario_seguradora } = req.body;

  const request = dbStore.businessRuleRequests.find((r) => r.id === id);
  if (!request) {
    return res.status(404).json({ status: 'erro', mensagem: 'Solicitação não encontrada.' });
  }
  if (status !== 'APROVADA' && status !== 'REJEITADA') {
    return res.status(400).json({ status: 'erro', mensagem: "status deve ser 'APROVADA' ou 'REJEITADA'." });
  }

  request.status = status;
  request.comentario_seguradora = comentario_seguradora;
  request.resolved_at = new Date().toISOString();

  dbStore.persist();
  return res.json({ status: 'sucesso', solicitacao: request });
});

// --- L. Configurações de Regras de Negócio da Ficha do Segurado (blob por apólice — ver
// PolicyBusinessSettings em src/types/index.ts). Cobre Métodos de Averbação, Subcontratação,
// Veículo e Motorista, Prazos e Datas, Região Metropolitana, Valor da Averbação e Averbação
// Esporádica. NÃO cobre Identificação do Segurado (Regra A/B) — ver policy-titularity-rules
// e policy-bypass-rules acima, que continuam a fonte real usada pelo motor de averbação. ---
router.get('/policy-business-settings', requirePermission('apolices', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { policy_id } = req.query;
  if (!policyPertenceAoAtor(req, res, policy_id)) return;
  const settings = dbStore.policyBusinessSettings.find((s) => s.policy_id === policy_id);
  return res.json({ status: 'sucesso', settings: settings ?? null });
});

router.put('/policy-business-settings', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { policy_id, config } = req.body;
  if (!policyPertenceAoAtor(req, res, policy_id)) return;
  if (typeof config !== 'object' || config === null) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'config (objeto) é obrigatório.'
    });
  }

  let settings: PolicyBusinessSettings | undefined = dbStore.policyBusinessSettings.find(
    (s) => s.policy_id === policy_id
  );
  const now = new Date().toISOString();
  if (settings) {
    settings.config = config;
    settings.updated_at = now;
  } else {
    settings = { id: uuidv4(), policy_id, config, updated_at: now };
    dbStore.policyBusinessSettings.push(settings);
  }

  dbStore.persist();
  return res.json({ status: 'sucesso', settings });
});

// --- M. Sublimites (lista por apólice) — ver PolicySublimite/TipoCondicaoSublimite em
// types/index.ts (item D-10 do relatório técnico do wizard de cadastro, compartilhado pelo
// usuário em 05/09): antes só aceitava { tag, valor } (sublimite por mercadoria); agora também
// aceita tipo_condicao ('mercadoria' | 'tomador' | 'tomador_mercadoria') e cnpj_tomador. ---
router.get('/policy-sublimites', requirePermission('apolices', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { policy_id } = req.query;
  if (req.backoffice?.actor_type === 'SEGURADORA' || policy_id) {
    if (!policyPertenceAoAtor(req, res, policy_id)) return;
  } else if (req.backoffice?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  let items = dbStore.policySublimites;
  if (policy_id) items = items.filter((s) => s.policy_id === policy_id);
  return res.json({ status: 'sucesso', sublimites: items });
});

router.post('/policy-sublimites', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { policy_id, tag, valor, tipo_condicao, cnpj_tomador } = req.body;
  if (!policyPertenceAoAtor(req, res, policy_id)) return;

  const tipo: TipoCondicaoSublimite = tipo_condicao || 'mercadoria';
  const tiposValidos: TipoCondicaoSublimite[] = ['mercadoria', 'tomador', 'tomador_mercadoria'];
  if (!tiposValidos.includes(tipo)) {
    return res.status(400).json({
      status: 'erro',
      mensagem: "tipo_condicao deve ser 'mercadoria', 'tomador' ou 'tomador_mercadoria'."
    });
  }
  // tag é obrigatória para condições que envolvem mercadoria; cnpj_tomador para as que envolvem
  // tomador. 'tomador' puro não exige tag; 'mercadoria' pura não exige cnpj_tomador.
  if ((tipo === 'mercadoria' || tipo === 'tomador_mercadoria') && !tag) {
    return res.status(400).json({ status: 'erro', mensagem: 'tag é obrigatória para este tipo_condicao.' });
  }
  if ((tipo === 'tomador' || tipo === 'tomador_mercadoria') && !cnpj_tomador) {
    return res.status(400).json({ status: 'erro', mensagem: 'cnpj_tomador é obrigatório para este tipo_condicao.' });
  }

  const newSublimite: PolicySublimite = {
    id: uuidv4(),
    policy_id,
    tag: tag || undefined,
    valor: valor || 'R$ 0,00',
    tipo_condicao: tipo,
    cnpj_tomador: cnpj_tomador || undefined,
    created_at: new Date().toISOString()
  };
  dbStore.policySublimites.push(newSublimite);
  dbStore.persist();
  return res.json({ status: 'sucesso', sublimite: newSublimite });
});

router.put('/policy-sublimites/:id', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const sublimite = dbStore.policySublimites.find((s) => s.id === id);
  if (!sublimite) {
    return res.status(404).json({ status: 'erro', mensagem: 'Sublimite não encontrado.' });
  }
  if (!policyPertenceAoAtor(req, res, sublimite.policy_id)) return;

  const { tag, valor, tipo_condicao, cnpj_tomador } = req.body;
  const tipoFinal: TipoCondicaoSublimite = tipo_condicao ?? sublimite.tipo_condicao ?? 'mercadoria';
  if (tipo_condicao !== undefined) {
    const tiposValidos: TipoCondicaoSublimite[] = ['mercadoria', 'tomador', 'tomador_mercadoria'];
    if (!tiposValidos.includes(tipo_condicao)) {
      return res.status(400).json({
        status: 'erro',
        mensagem: "tipo_condicao deve ser 'mercadoria', 'tomador' ou 'tomador_mercadoria'."
      });
    }
  }
  const tagFinal = tag !== undefined ? tag : sublimite.tag;
  const cnpjFinal = cnpj_tomador !== undefined ? cnpj_tomador : sublimite.cnpj_tomador;
  if ((tipoFinal === 'mercadoria' || tipoFinal === 'tomador_mercadoria') && !tagFinal) {
    return res.status(400).json({ status: 'erro', mensagem: 'tag é obrigatória para este tipo_condicao.' });
  }
  if ((tipoFinal === 'tomador' || tipoFinal === 'tomador_mercadoria') && !cnpjFinal) {
    return res.status(400).json({ status: 'erro', mensagem: 'cnpj_tomador é obrigatório para este tipo_condicao.' });
  }

  if (tag !== undefined) sublimite.tag = tag || undefined;
  if (valor !== undefined) sublimite.valor = valor;
  if (tipo_condicao !== undefined) sublimite.tipo_condicao = tipo_condicao;
  if (cnpj_tomador !== undefined) sublimite.cnpj_tomador = cnpj_tomador || undefined;

  dbStore.persist();
  return res.json({ status: 'sucesso', sublimite });
});

router.delete('/policy-sublimites/:id', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const sublimite = dbStore.policySublimites.find((s) => s.id === id);
  if (sublimite && !policyPertenceAoAtor(req, res, sublimite.policy_id)) return;
  if (!sublimite && req.backoffice?.actor_type !== 'INTERNAL_USER' && req.backoffice?.actor_type !== 'SEGURADORA') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  dbStore.policySublimites = dbStore.policySublimites.filter((s) => s.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Sublimite removido com sucesso.' });
});

// --- N. Coberturas Adicionais com valor real por apólice (PolicyCoverageValue) — "ativado nesta
// apólice com valor R$ X". Distinto de InsurerCoverage, que é só a definição da cobertura.
// desconta_lmi é persistido mas ainda NÃO é lido pelo AverbacaoService nesta rodada (ver
// claude/Mapeamento_Portais_e_Personas.md no Project para o porquê). ---
router.get('/policy-coverage-values', requirePermission('coberturas', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { policy_id } = req.query;
  if (!policyPertenceAoAtor(req, res, policy_id)) return;
  const items = dbStore.policyCoverageValues.filter((v) => v.policy_id === policy_id);
  return res.json({ status: 'sucesso', coverage_values: items });
});

router.post('/policy-coverage-values', requirePermission('coberturas', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { policy_id, insurer_coverage_id, valor, desconta_lmi } = req.body;
  if (!policyPertenceAoAtor(req, res, policy_id)) return;
  if (!insurer_coverage_id) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'insurer_coverage_id é obrigatório.'
    });
  }
  const policy = dbStore.policies.find((p) => p.id === policy_id);
  if (!policy) {
    return res.status(404).json({ status: 'erro', mensagem: 'Apólice não encontrada.' });
  }
  const coverage = dbStore.insurerCoverages.find((c) => c.id === insurer_coverage_id);
  if (!coverage) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cobertura adicional não encontrada.' });
  }
  const existente = dbStore.policyCoverageValues.find(
    (v) => v.policy_id === policy_id && v.insurer_coverage_id === insurer_coverage_id
  );
  if (existente) {
    return res.status(409).json({
      status: 'erro',
      mensagem: 'Esta cobertura já está ativada nesta apólice. Use a edição para alterar o valor.'
    });
  }

  const now = new Date().toISOString();
  const newValue: PolicyCoverageValue = {
    id: uuidv4(),
    policy_id,
    insurer_coverage_id,
    valor: Number(valor) || 0,
    desconta_lmi: Boolean(desconta_lmi),
    created_at: now,
    updated_at: now
  };
  dbStore.policyCoverageValues.push(newValue);
  dbStore.persist();
  return res.json({ status: 'sucesso', coverage_value: newValue });
});

router.put('/policy-coverage-values/:id', requirePermission('coberturas', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const value = dbStore.policyCoverageValues.find((v) => v.id === id);
  if (!value) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cobertura ativada não encontrada nesta apólice.' });
  }
  if (!policyPertenceAoAtor(req, res, value.policy_id)) return;
  const { valor, desconta_lmi } = req.body;
  if (valor !== undefined) value.valor = Number(valor) || 0;
  if (desconta_lmi !== undefined) value.desconta_lmi = Boolean(desconta_lmi);
  value.updated_at = new Date().toISOString();

  dbStore.persist();
  return res.json({ status: 'sucesso', coverage_value: value });
});

router.delete('/policy-coverage-values/:id', requirePermission('coberturas', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const value = dbStore.policyCoverageValues.find((v) => v.id === id);
  if (!value) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cobertura ativada não encontrada nesta apólice.' });
  }
  if (!policyPertenceAoAtor(req, res, value.policy_id)) return;
  dbStore.policyCoverageValues = dbStore.policyCoverageValues.filter((v) => v.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Cobertura removida desta apólice com sucesso.' });
});

// =====================================================================
// FASE 3 — PORTAL DA SEGURADORA: DASHBOARD, AVERBAÇÕES, CORRETORAS/ASSESSORIAS
// E PERMISSÕES REAIS (Log de Auditoria ficou de fora desta rodada — ver
// claude/Mapeamento_Portais_e_Personas.md no Project para o porquê)
// =====================================================================

// --- N. Dashboard da Seguradora — KPIs escopados por insurer_id (ver arckatechseguradora
// src/routes/index.tsx). Distinto do /admin/dashboard-stats acima, que é visão GLOBAL
// (uso interno ARCKATECH, sem escopo de seguradora). ---
router.get('/insurer-dashboard-stats', requirePermission('relatorios', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const insurer_id = resolveInsurerId(req, res, req.query.insurer_id);
  if (!insurer_id) return;

  const policiesDaSeguradora = dbStore.policies.filter((p) => p.insurer_id === insurer_id);
  const tenantIds = new Set(policiesDaSeguradora.map((p) => p.tenant_id));
  const seguradosDaSeguradora = dbStore.tenants.filter((t) => tenantIds.has(t.id));

  const seguradosAtivos = seguradosDaSeguradora.filter((t) => t.status === 'ATIVO').length;

  const ha30Dias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const seguradosAtivosNovos30d = seguradosDaSeguradora.filter(
    (t) => t.status === 'ATIVO' && new Date(t.created_at) >= ha30Dias
  ).length;

  const pendenciasAprovacao = dbStore.approvalRequests.filter(
    (a) => a.insurer_id === insurer_id && a.status === 'PENDENTE'
  ).length;

  const em30Dias = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const apolicesVencendo30Dias = policiesDaSeguradora.filter((p) => {
    const vencimento = new Date(p.vigencia_fim);
    return p.status !== 'INATIVA' && vencimento >= new Date() && vencimento <= em30Dias;
  }).length;

  const policyIdsDaSeguradora = new Set(policiesDaSeguradora.map((p) => p.id));
  // Achado do usuário em 29/08: "Averbações no mês" contava TODAS as averbações da seguradora,
  // inclusive as recusadas (status='ERRO') — um documento recusado nunca deveria ser contado
  // aqui, só os que de fato geraram um número de averbação (status='SUCESSO').
  const averbacoesDaSeguradora = dbStore.averbacoes.filter(
    (a) => policyIdsDaSeguradora.has(a.policy_id) && a.status === 'SUCESSO'
  );

  const agora = new Date();
  const inicioMesAtual = new Date(agora.getFullYear(), agora.getMonth(), 1);
  const inicioMesAnterior = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);

  const averbacoesNoMes = averbacoesDaSeguradora.filter((a) => new Date(a.created_at) >= inicioMesAtual).length;
  const averbacoesMesAnterior = averbacoesDaSeguradora.filter(
    (a) => new Date(a.created_at) >= inicioMesAnterior && new Date(a.created_at) < inicioMesAtual
  ).length;

  return res.json({
    status: 'sucesso',
    stats: {
      segurados_ativos: seguradosAtivos,
      segurados_ativos_novos_30d: seguradosAtivosNovos30d,
      pendencias_aprovacao: pendenciasAprovacao,
      apolices_vencendo_30_dias: apolicesVencendo30Dias,
      averbacoes_no_mes: averbacoesNoMes,
      averbacoes_mes_anterior: averbacoesMesAnterior
    }
  });
});

// --- O. Consulta de Averbações da Seguradora — todos os segurados da carteira daquele
// insurer_id, com os mesmos filtros/paginação de tenant.ts GET /averbacoes (visão do
// próprio transportador), mas aqui agregado pela seguradora. ---
router.get('/insurer-averbacoes', requirePermission('relatorios', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { status, tipo_documento, tenant_id, data_de, data_ate } = req.query;
  const insurer_id = resolveInsurerId(req, res, req.query.insurer_id);
  if (!insurer_id) return;

  let policies = dbStore.policies.filter((p) => p.insurer_id === insurer_id);
  if (tenant_id) policies = policies.filter((p) => p.tenant_id === tenant_id);
  const policyIds = new Set(policies.map((p) => p.id));

  let filtered = dbStore.averbacoes.filter((a) => policyIds.has(a.policy_id));

  if (status) {
    filtered = filtered.filter((a) => a.status === String(status).toUpperCase());
  }
  if (tipo_documento) {
    filtered = filtered.filter((a) => a.tipo_documento === String(tipo_documento).toUpperCase());
  }
  if (data_de) {
    const from = new Date(String(data_de));
    if (!isNaN(from.getTime())) filtered = filtered.filter((a) => new Date(a.created_at) >= from);
  }
  if (data_ate) {
    const to = new Date(String(data_ate));
    if (!isNaN(to.getTime())) filtered = filtered.filter((a) => new Date(a.created_at) <= to);
  }

  filtered = [...filtered].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const totalItems = filtered.length;
  const pageRaw = Number(req.query.page);
  const pageSizeRaw = Number(req.query.page_size);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(Math.floor(pageSizeRaw), 200) : 20;
  const totalPages = totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize);
  const startIndex = (page - 1) * pageSize;

  const items = filtered.slice(startIndex, startIndex + pageSize).map((a) => {
    const policy = dbStore.policies.find((p) => p.id === a.policy_id);
    const tenant = policy ? dbStore.tenants.find((t) => t.id === policy.tenant_id) : undefined;
    return {
      ...a,
      tenant_id: policy?.tenant_id,
      segurado_nome: tenant?.razao_social ?? '—',
      numero_apolice: policy?.numero_apolice
    };
  });

  return res.json({
    status: 'sucesso',
    averbacoes: items,
    paginacao: {
      pagina: page,
      tamanho_pagina: pageSize,
      total_itens: totalItems,
      total_paginas: totalPages
    }
  });
});

// --- P. Corretoras / Assessorias (Broker) — CRUD completo. Uma Assessoria não tem
// modelagem própria: é o mesmo cadastro de Broker, e só passa a aparecer na listagem de
// "Assessorias" do portal quando estiver referenciada em Policy.assessoria_id de alguma
// apólice (ver listarAssessoriasComResumo no frontend). Criar uma Assessoria nova aqui
// cria um Broker "solto", que só some da lista de "sem uso" quando vinculado a uma apólice.
//
// Decisão de escopo (Backlog, seção 2 — "POST/PUT/DELETE /admin/brokers deve ser escopado por
// seguradora?"), resolvida com o usuário nesta sessão: Broker CONTINUA global — visível a todas
// as seguradoras, exatamente como hoje (a tela "Corretora Líder/Cocorretora" do Portal da
// Seguradora depende disso para listar opções via GET /brokers, que fica aberto a qualquer ator
// autenticado, sem mudança). O que muda é só a ESCRITA: criar/editar/excluir uma corretora passa
// a ser exclusivo da administração Arckatech (mesmo padrão de `apenasInternalUser` já usado em
// `PUT /tenants/:id` e nas demais ~15 rotas administrativas sem consumidor real no frontend hoje)
// — uma SEGURADORA ou CORRETORA autenticada não pode mais criar/editar/excluir Broker nenhum.
// Não muda o modelo de dados (Broker continua sem insurer_id) nem a tela de seleção do frontend. ---
/**
 * Concede (`tenantId` = id de um Tenant role=CORRETORA) ou revoga (`tenantId` = null) o login de
 * Portal da Corretora de um Broker, vinculando/desvinculando `Broker.tenant_id` — mesma validação
 * usada por `PUT /brokers/:id` (ADM, sem restrição de carteira) e pela nova `PUT
 * /brokers/:id/portal-access` (SEGURADORA, restrita à própria carteira — ver abaixo). Extraído para
 * função só nesta sessão para as duas rotas não divergirem quando uma delas mudar.
 */
function concederOuRevogarAcessoBroker(
  broker: Broker,
  tenantId: string | null
): { ok: true } | { ok: false; status: number; mensagem: string } {
  if (tenantId === null) {
    delete broker.tenant_id;
    return { ok: true };
  }
  const tenantAlvo = dbStore.tenants.find((t) => t.id === tenantId);
  if (!tenantAlvo) {
    return { ok: false, status: 400, mensagem: 'tenant_id informado não corresponde a nenhum Tenant existente.' };
  }
  if (tenantAlvo.role !== 'CORRETORA') {
    return {
      ok: false,
      status: 400,
      mensagem: 'O Tenant vinculado a uma Corretora/Assessoria precisa ter role=CORRETORA.'
    };
  }
  const jaVinculado = dbStore.brokers.find((b) => b.id !== broker.id && b.tenant_id === tenantId);
  if (jaVinculado) {
    return {
      ok: false,
      status: 409,
      mensagem: `Este Tenant já está vinculado a outra corretora (${jaVinculado.nome_fantasia ?? jaVinculado.nome}).`
    };
  }
  broker.tenant_id = tenantId;
  return { ok: true };
}

router.post('/brokers', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const {
    cnpj,
    razao_social,
    nome_fantasia,
    corretor_responsavel_nome,
    corretor_responsavel_email,
    corretor_responsavel_telefone_fixo,
    corretor_responsavel_celular
  } = req.body;
  if (!cnpj || !razao_social) {
    return res.status(400).json({ status: 'erro', mensagem: 'cnpj e razao_social são obrigatórios.' });
  }

  const cnpjLimpo = String(cnpj).replace(/\D/g, '');
  const newBroker: Broker = {
    id: `brk_${cnpjLimpo}_${Date.now()}`,
    cnpj,
    nome: razao_social,
    razao_social,
    nome_fantasia,
    corretor_responsavel_nome,
    corretor_responsavel_email,
    corretor_responsavel_telefone_fixo,
    corretor_responsavel_celular,
    created_at: new Date().toISOString()
  };
  dbStore.brokers.push(newBroker);
  dbStore.persist();
  return res.json({ status: 'sucesso', broker: newBroker });
});

router.put('/brokers/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  const broker = dbStore.brokers.find((b) => b.id === id);
  if (!broker) {
    return res.status(404).json({ status: 'erro', mensagem: 'Corretora/Assessoria não encontrada.' });
  }
  const {
    cnpj,
    razao_social,
    nome_fantasia,
    corretor_responsavel_nome,
    corretor_responsavel_email,
    corretor_responsavel_telefone_fixo,
    corretor_responsavel_celular,
    tenant_id
  } = req.body;

  // Portal da Corretora (Backlog, seção 4): concede/revoga login a este Broker vinculando-o a um
  // Tenant(role=CORRETORA) — mesmo padrão já usado por Insurer.tenant_id para a Seguradora. Vale
  // para os três papéis que um Broker pode ter numa Policy (líder, co-corretora ou assessoria —
  // são todos o mesmo tipo `Broker`, só mudando em qual campo aparecem), então este é o único
  // ponto necessário para dar acesso a qualquer um deles. `tenant_id: null` revoga o acesso sem
  // apagar o Tenant/TenantUser (fica órfão, igual à seguradora hoje). Esta rota continua exclusiva
  // de ADM (sem restrição de carteira) — para a SEGURADORA conceder/revogar acesso apenas às
  // corretoras da própria carteira, ver a nova `PUT /brokers/:id/portal-access` abaixo.
  if (tenant_id !== undefined) {
    const resultado = concederOuRevogarAcessoBroker(broker, tenant_id);
    if (!resultado.ok) {
      return res.status(resultado.status).json({ status: 'erro', mensagem: resultado.mensagem });
    }
  }

  if (cnpj !== undefined) broker.cnpj = cnpj;
  if (razao_social !== undefined) {
    broker.razao_social = razao_social;
    broker.nome = razao_social;
  }
  if (nome_fantasia !== undefined) broker.nome_fantasia = nome_fantasia;
  if (corretor_responsavel_nome !== undefined) broker.corretor_responsavel_nome = corretor_responsavel_nome;
  if (corretor_responsavel_email !== undefined) broker.corretor_responsavel_email = corretor_responsavel_email;
  if (corretor_responsavel_telefone_fixo !== undefined)
    broker.corretor_responsavel_telefone_fixo = corretor_responsavel_telefone_fixo;
  if (corretor_responsavel_celular !== undefined) broker.corretor_responsavel_celular = corretor_responsavel_celular;

  dbStore.persist();
  return res.json({ status: 'sucesso', broker });
});

router.delete('/brokers/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  const broker = dbStore.brokers.find((b) => b.id === id);
  if (!broker) {
    return res.status(404).json({ status: 'erro', mensagem: 'Corretora/Assessoria não encontrada.' });
  }

  const emUso = dbStore.policies.some(
    (p) => p.broker_id === id || p.co_broker_id === id || p.assessoria_id === id
  );
  if (emUso) {
    return res.status(409).json({
      status: 'erro',
      mensagem:
        'Esta corretora/assessoria está vinculada a uma ou mais apólices e não pode ser removida. Troque a corretora dessas apólices antes de excluir.'
    });
  }

  dbStore.brokers = dbStore.brokers.filter((b) => b.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Corretora/Assessoria removida com sucesso.' });
});

/**
 * Portal da Corretora (Backlog, seção 4) — decisão tomada com o usuário nesta sessão: quem pode
 * conceder/revogar o acesso de uma corretora/co-corretora/assessoria ao portal é tanto o ADM da
 * Arckatech (via `PUT /brokers/:id` acima, sem restrição) quanto a própria SEGURADORA, mas neste
 * segundo caso só para corretoras que já estão na carteira dela (têm ao menos uma apólice em
 * comum) — mesmo padrão de isolamento de `resolveInsurerId`/`policyPertenceAoAtor` usados no resto
 * deste arquivo. Rota separada de `PUT /brokers/:id` de propósito: o CRUD completo do cadastro
 * (cnpj, razão social, etc.) continua exclusivo de ADM (decisão de escopo já registrada no
 * comentário da seção P, acima) — abrir esta ação para SEGURADORA não reabre aquele.
 *
 * Módulo RBAC escolhido: `delegacao_corretora` — é o mesmo que já rege "Permissões e Autonomia"
 * (`/delegation-permissions`) e a fila de aprovação (`/approval-requests`), e conceitualmente
 * conceder/revogar login de uma corretora é outra forma de controlar até onde ela chega — não é um
 * módulo novo. `requirePermission` cobre o nível mínimo (ADM sempre passa; AGENTE/SEGURADORA
 * precisam de "editar" em `delegacao_corretora` no próprio RbacProfile).
 */
router.put(
  '/brokers/:id/portal-access',
  requirePermission('delegacao_corretora', 'editar'),
  (req: BackofficeAuthenticatedRequest, res) => {
    const ator = req.backoffice;
    if (!ator) {
      return res.status(401).json({ status: 'erro', mensagem: 'Autenticação de backoffice ausente.' });
    }

    const { id } = req.params;
    const broker = dbStore.brokers.find((b) => b.id === id);
    if (!broker) {
      return res.status(404).json({ status: 'erro', mensagem: 'Corretora/Assessoria não encontrada.' });
    }

    if (ator.actor_type === 'SEGURADORA') {
      if (!ator.insurer_id) {
        return res.status(403).json({
          status: 'erro',
          mensagem: 'Seu usuário não está vinculado a nenhuma seguradora — sem acesso a esta área.'
        });
      }
      const pertenceACarteiraDaSeguradora = dbStore.policies.some(
        (p) => p.insurer_id === ator.insurer_id && (p.broker_id === id || p.co_broker_id === id || p.assessoria_id === id)
      );
      if (!pertenceACarteiraDaSeguradora) {
        return res.status(403).json({
          status: 'erro',
          mensagem: 'Esta corretora/assessoria não está vinculada a nenhuma apólice da sua seguradora.'
        });
      }
    } else if (ator.actor_type !== 'INTERNAL_USER') {
      return res.status(403).json({
        status: 'erro',
        mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.'
      });
    }

    const { tenant_id } = req.body;
    if (tenant_id === undefined || (tenant_id !== null && typeof tenant_id !== 'string')) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'tenant_id é obrigatório: string (id do Tenant role=CORRETORA) para conceder, ou null para revogar.'
      });
    }

    const resultado = concederOuRevogarAcessoBroker(broker, tenant_id);
    if (!resultado.ok) {
      return res.status(resultado.status).json({ status: 'erro', mensagem: resultado.mensagem });
    }

    dbStore.persist();
    return res.json({ status: 'sucesso', broker });
  }
);

export default router;
