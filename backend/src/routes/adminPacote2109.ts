import { Router, Response } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from '../services/dbStore';
import { Tenant, Policy, TenantCnpjAdicional, PolicyPartnerHistory, LiberationCode } from '../types';
import { BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';
import { requirePermission } from '../middleware/rbacMiddleware';
import { policyPertenceAoAtor } from './adminHelpers';

/**
 * Fase 0 a 4 do pacote de 21/09 (compartilhado pelo usuário — validação técnica + implementação
 * combinada) — rotas novas do Portal da Seguradora, extraídas para este arquivo próprio só por
 * tamanho (admin.ts já estava com ~99KB, grande demais para publicar de uma vez com mais estas
 * adições). Continuam no mesmo prefixo /api/v1/admin — ver `router.use('/', pacote2109Router)`
 * em admin.ts. Reaproveita `policyPertenceAoAtor` de adminHelpers.ts (mesmo helper usado no
 * resto do arquivo original).
 */
const router = Router();

/**
 * Fase 0 do pacote de 21/09 (compartilhado pelo usuário) — status do cadastro (Ativo/Ativo
 * parcial/Sem apólices vigentes/Inativo), calculado uma única vez aqui em vez de recalculado de
 * formas ligeiramente diferentes em cada tela (Consultar Segurados, Ficha, resumo da carteira) —
 * risco de divergência apontado no documento de validação técnica. Regra confirmada no relatório
 * de negócios de 20/09: `Tenant.status === 'INATIVO'` tem prioridade sobre qualquer situação de
 * apólice; senão, considera "vigente" uma apólice `ATIVA` com `vigencia_fim` no futuro e sem
 * suspensão em vigor no momento (mesmo cálculo de `isPolicySuspensa` do motor de averbação).
 * Exportada — usada por `GET /admin/tenants` em admin.ts.
 */
export function calcularStatusCadastro(
  tenant: Tenant,
  apolicesDoTenant: Policy[]
): 'ATIVO' | 'ATIVO_PARCIAL' | 'SEM_APOLICES_VIGENTES' | 'INATIVO' {
  if (tenant.status === 'INATIVO') return 'INATIVO';
  const agora = Date.now();
  const estaVigente = (p: Policy) => {
    const suspensa =
      Boolean(p.suspensa_desde) &&
      new Date(p.suspensa_desde!).getTime() <= agora &&
      (!p.suspensa_ate || new Date(p.suspensa_ate).getTime() >= agora);
    return p.status === 'ATIVA' && !suspensa && new Date(p.vigencia_fim).getTime() >= agora;
  };
  if (apolicesDoTenant.length === 0) return 'SEM_APOLICES_VIGENTES';
  const vigentes = apolicesDoTenant.filter(estaVigente).length;
  if (vigentes === 0) return 'SEM_APOLICES_VIGENTES';
  if (vigentes === apolicesDoTenant.length) return 'ATIVO';
  return 'ATIVO_PARCIAL';
}

/**
 * Fase 3 do pacote de 21/09 — cria o(s) registro(s) inicial(is) de PolicyPartnerHistory no
 * momento em que a apólice é criada, para "Histórico de Parcerias" aparecer sempre (item 8 da
 * lista de ajustes pontuais do relatório de 20/09), mesmo sem nenhuma troca ainda. Um registro
 * por papel presente (líder sempre existe; cocorretora/assessoria só se informados). Exportada —
 * usada por `POST /admin/policies` e `POST /admin/insurer-clients` em admin.ts.
 */
export function seedPartnerHistory(policy: Policy): void {
  const vigenciaInicio = policy.vigencia_inicio;
  const papeis: { papel: PolicyPartnerHistory['papel']; broker_id?: string }[] = [
    { papel: 'lider', broker_id: policy.broker_id },
    { papel: 'cocorretora', broker_id: policy.co_broker_id },
    { papel: 'assessoria', broker_id: policy.assessoria_id }
  ];
  for (const { papel, broker_id } of papeis) {
    if (!broker_id) continue;
    dbStore.policyPartnerHistory.push({
      id: uuidv4(),
      policy_id: policy.id,
      papel,
      broker_id,
      vigencia_inicio: vigenciaInicio,
      created_at: new Date().toISOString()
    });
  }
}

// --- CNPJs Adicionais / Filiais (Fase 1 do pacote de 21/09) — ver TenantCnpjAdicional em
// types/index.ts para o escopo desta versão (sem cascata automática para Tenant.status). ---
router.get('/tenants/:id/cnpjs-adicionais', requirePermission('clientes', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  return res.json({
    status: 'sucesso',
    cnpjs: dbStore.tenantCnpjsAdicionais.filter((c) => c.tenant_id === id)
  });
});

router.post('/tenants/:id/cnpjs-adicionais', requirePermission('clientes', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const tenant = dbStore.tenants.find((t) => t.id === id);
  if (!tenant) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cliente não encontrado.' });
  }
  const { cnpj, tipo } = req.body;
  if (!cnpj || (tipo !== 'filial' && tipo !== 'adicional')) {
    return res.status(400).json({ status: 'erro', mensagem: "cnpj e tipo ('filial' ou 'adicional') são obrigatórios." });
  }
  const cnpjLimpo = String(cnpj).replace(/\D/g, '');
  const jaExiste = dbStore.tenantCnpjsAdicionais.some(
    (c) => c.tenant_id === id && c.cnpj.replace(/\D/g, '') === cnpjLimpo
  );
  if (jaExiste) {
    return res.status(409).json({ status: 'erro', mensagem: 'Este CNPJ já está cadastrado para este cliente.' });
  }
  const novo: TenantCnpjAdicional = {
    id: uuidv4(),
    tenant_id: id,
    cnpj,
    tipo,
    status: 'ATIVO',
    created_at: new Date().toISOString()
  };
  dbStore.tenantCnpjsAdicionais.push(novo);
  dbStore.persist();
  return res.json({ status: 'sucesso', cnpj_adicional: novo });
});

// Imutabilidade de CNPJ (confirmada no relatório de 13/09): só `status` pode mudar aqui —
// inativar/reativar, nunca editar o número nem excluir fisicamente.
router.put('/tenants/:id/cnpjs-adicionais/:cnpjId', requirePermission('clientes', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { cnpjId } = req.params;
  const registro = dbStore.tenantCnpjsAdicionais.find((c) => c.id === cnpjId && c.tenant_id === req.params.id);
  if (!registro) {
    return res.status(404).json({ status: 'erro', mensagem: 'CNPJ adicional não encontrado para este cliente.' });
  }
  const { status } = req.body;
  if (status !== 'ATIVO' && status !== 'INATIVO') {
    return res.status(400).json({ status: 'erro', mensagem: "status deve ser 'ATIVO' ou 'INATIVO'." });
  }
  registro.status = status;
  dbStore.persist();
  return res.json({ status: 'sucesso', cnpj_adicional: registro });
});

// --- Suspensão de Apólice (Fase 2 do pacote de 21/09) — ver Policy.suspensa_desde/suspensa_ate
// em types/index.ts para o cálculo de "está suspensa agora". Reativar limpa os dois campos —
// não preserva histórico de suspensões passadas nesta primeira versão. ---
router.post('/policies/:id/suspensao', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const policy = dbStore.policies.find((p) => p.id === id);
  if (!policy) {
    return res.status(404).json({ status: 'erro', mensagem: 'Apólice não localizada.' });
  }
  if (!policyPertenceAoAtor(req, res, id)) return;

  const { desde, ate } = req.body;
  if (!desde) {
    return res.status(400).json({ status: 'erro', mensagem: 'desde é obrigatório (data de início da suspensão).' });
  }
  policy.suspensa_desde = desde;
  policy.suspensa_ate = ate || undefined;
  dbStore.persist();
  return res.json({ status: 'sucesso', policy });
});

router.delete('/policies/:id/suspensao', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const policy = dbStore.policies.find((p) => p.id === id);
  if (!policy) {
    return res.status(404).json({ status: 'erro', mensagem: 'Apólice não localizada.' });
  }
  if (!policyPertenceAoAtor(req, res, id)) return;
  policy.suspensa_desde = undefined;
  policy.suspensa_ate = undefined;
  dbStore.persist();
  return res.json({ status: 'sucesso', policy });
});

// --- Histórico de Vínculos (Fase 3 do pacote de 21/09) — ver PolicyPartnerHistory em
// types/index.ts. "Trocar Parceria" fecha o registro aberto daquele papel (vigencia_fim =
// vigencia_inicio da troca menos 1 dia) e abre um novo, atualizando também o campo-cache
// correspondente em Policy (broker_id/co_broker_id/assessoria_id) para não quebrar nenhum lugar
// que já lê esses três campos diretamente. Notificação de embarques retroativos: fora de escopo
// nesta rodada (não existe canal de notificação real hoje) — ver documento de validação técnica. ---
router.get('/policies/:id/historico-parcerias', requirePermission('apolices', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  if (!policyPertenceAoAtor(req, res, id)) return;
  const historico = dbStore.policyPartnerHistory
    .filter((h) => h.policy_id === id)
    .sort((a, b) => b.vigencia_inicio.localeCompare(a.vigencia_inicio));
  return res.json({ status: 'sucesso', historico });
});

router.post('/policies/:id/trocar-parceria', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const policy = dbStore.policies.find((p) => p.id === id);
  if (!policy) {
    return res.status(404).json({ status: 'erro', mensagem: 'Apólice não localizada.' });
  }
  if (!policyPertenceAoAtor(req, res, id)) return;

  const { papel, broker_id, vigencia_inicio } = req.body;
  const papeisValidos = ['lider', 'cocorretora', 'assessoria'];
  if (!papeisValidos.includes(papel) || !broker_id || !vigencia_inicio) {
    return res.status(400).json({
      status: 'erro',
      mensagem: "papel ('lider'|'cocorretora'|'assessoria'), broker_id e vigencia_inicio são obrigatórios."
    });
  }

  const registroAberto = dbStore.policyPartnerHistory.find(
    (h) => h.policy_id === id && h.papel === papel && !h.vigencia_fim
  );
  if (registroAberto) {
    const fimAnterior = new Date(new Date(vigencia_inicio).getTime() - 24 * 60 * 60 * 1000).toISOString();
    registroAberto.vigencia_fim = fimAnterior;
  }

  const novoRegistro: PolicyPartnerHistory = {
    id: uuidv4(),
    policy_id: id,
    papel,
    broker_id,
    vigencia_inicio,
    created_at: new Date().toISOString()
  };
  dbStore.policyPartnerHistory.push(novoRegistro);

  if (papel === 'lider') policy.broker_id = broker_id;
  else if (papel === 'cocorretora') policy.co_broker_id = broker_id;
  else policy.assessoria_id = broker_id;

  dbStore.persist();
  return res.json({ status: 'sucesso', policy, vinculo: novoRegistro });
});


// --- Código de Liberação de Limite (Fase 4 do pacote de 21/09) — Averbação Esporádica real, ver
// LiberationCode em types/index.ts. Necessário para a estratégia 'exigir-codigo' do Bloco 1 de
// Tratamento de Recusas funcionar de verdade no motor (AverbacaoService.avaliarLimiteComEstrategia). ---
router.get('/policy-liberation-codes', requirePermission('apolices', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { policy_id } = req.query;
  if (!policyPertenceAoAtor(req, res, policy_id)) return;
  const codes = dbStore.liberationCodes.filter((c) => c.policy_id === policy_id);
  return res.json({ status: 'sucesso', codigos: codes });
});

router.post('/policy-liberation-codes', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { policy_id, codigo, validade, usos_maximos, valor_carga_liberado, valor_cobertura_adicional_liberado } = req.body;
  if (!policyPertenceAoAtor(req, res, policy_id)) return;
  if (!codigo || !validade) {
    return res.status(400).json({ status: 'erro', mensagem: 'codigo e validade são obrigatórios.' });
  }
  const codigoNormalizado = String(codigo).trim().toUpperCase();
  const jaExiste = dbStore.liberationCodes.some(
    (c) => c.policy_id === policy_id && c.codigo.trim().toUpperCase() === codigoNormalizado
  );
  if (jaExiste) {
    return res.status(409).json({ status: 'erro', mensagem: 'Já existe um código de liberação com esse valor para esta apólice.' });
  }
  const novo: LiberationCode = {
    id: uuidv4(),
    policy_id,
    codigo,
    validade,
    usos_maximos: usos_maximos !== undefined ? Number(usos_maximos) : undefined,
    usos_realizados: 0,
    valor_carga_liberado: valor_carga_liberado !== undefined ? Number(valor_carga_liberado) : undefined,
    valor_cobertura_adicional_liberado:
      valor_cobertura_adicional_liberado !== undefined ? Number(valor_cobertura_adicional_liberado) : undefined,
    ativo: true,
    created_at: new Date().toISOString()
  };
  dbStore.liberationCodes.push(novo);
  dbStore.persist();
  return res.json({ status: 'sucesso', codigo_liberacao: novo });
});

router.put('/policy-liberation-codes/:id', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const codigo = dbStore.liberationCodes.find((c) => c.id === id);
  if (!codigo) {
    return res.status(404).json({ status: 'erro', mensagem: 'Código de liberação não encontrado.' });
  }
  if (!policyPertenceAoAtor(req, res, codigo.policy_id)) return;
  const { validade, usos_maximos, valor_carga_liberado, valor_cobertura_adicional_liberado, ativo } = req.body;
  if (validade !== undefined) codigo.validade = validade;
  if (usos_maximos !== undefined) codigo.usos_maximos = usos_maximos === null ? undefined : Number(usos_maximos);
  if (valor_carga_liberado !== undefined) codigo.valor_carga_liberado = valor_carga_liberado === null ? undefined : Number(valor_carga_liberado);
  if (valor_cobertura_adicional_liberado !== undefined) {
    codigo.valor_cobertura_adicional_liberado =
      valor_cobertura_adicional_liberado === null ? undefined : Number(valor_cobertura_adicional_liberado);
  }
  if (ativo !== undefined) codigo.ativo = Boolean(ativo);
  dbStore.persist();
  return res.json({ status: 'sucesso', codigo_liberacao: codigo });
});

router.delete('/policy-liberation-codes/:id', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const codigo = dbStore.liberationCodes.find((c) => c.id === id);
  if (codigo && !policyPertenceAoAtor(req, res, codigo.policy_id)) return;
  if (!codigo && req.backoffice?.actor_type !== 'INTERNAL_USER' && req.backoffice?.actor_type !== 'SEGURADORA') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  dbStore.liberationCodes = dbStore.liberationCodes.filter((c) => c.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Código de liberação removido com sucesso.' });
});

// --- Fila de Aprovação de Averbações (Fase 4 do pacote de 21/09 — "Documentos Pendentes" /
// Tratamento de Recusas Bloco 1 e 2). Decidir um PENDENTE_APROVACAO: aprovar gera um número de
// averbação de verdade (mesma lógica de sucesso do motor, sem reprocessar as regras — a decisão
// humana SUBSTITUI a regra que gerou a pendência); recusar converte para ERRO. Cancelar só é
// permitido a partir de PENDENTE_APROVACAO — vira CANCELADO_NAO_AVERBADO, distinto do "Cancelado"
// (documento averbado e depois cancelado), que ainda não existe no motor. ---
router.post('/averbacoes/:id/decidir', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const averbacao = dbStore.averbacoes.find((a) => a.id === id);
  if (!averbacao) {
    return res.status(404).json({ status: 'erro', mensagem: 'Averbação não encontrada.' });
  }
  if (!policyPertenceAoAtor(req, res, averbacao.policy_id)) return;
  if (averbacao.status !== 'PENDENTE_APROVACAO') {
    return res.status(409).json({ status: 'erro', mensagem: 'Esta averbação não está mais pendente de decisão.' });
  }

  const { decisao, comentario } = req.body;
  if (decisao !== 'APROVAR' && decisao !== 'RECUSAR') {
    return res.status(400).json({ status: 'erro', mensagem: "decisao deve ser 'APROVAR' ou 'RECUSAR'." });
  }

  const ator = req.backoffice;
  averbacao.decidido_por = ator?.user_id ?? ator?.actor_type;
  averbacao.decidido_em = new Date().toISOString();
  if (comentario) averbacao.regras_internas_aplicadas.push(`Decisão da seguradora: ${comentario}`);

  if (decisao === 'RECUSAR') {
    averbacao.status = 'ERRO';
    dbStore.persist();
    return res.json({ status: 'sucesso', averbacao });
  }

  // Aprovar: gera número de averbação de verdade, igual ao motor faria em caso de sucesso.
  const policy = dbStore.policies.find((p) => p.id === averbacao.policy_id)!;
  const timestampISO = new Date().toISOString();
  const numeroAverbacao = `AVB-${policy.ramo}-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  averbacao.status = 'SUCESSO';
  averbacao.numero_averbacao = numeroAverbacao;
  averbacao.codigo_resposta = 'SUC-2000';
  averbacao.mensagem_resposta = `Averbação aprovada manualmente após pendência (${averbacao.motivo_pendencia}). Número: ${numeroAverbacao}.`;
  averbacao.timestamp = timestampISO;
  dbStore.persist();
  return res.json({ status: 'sucesso', averbacao });
});

router.post('/averbacoes/:id/cancelar', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const averbacao = dbStore.averbacoes.find((a) => a.id === id);
  if (!averbacao) {
    return res.status(404).json({ status: 'erro', mensagem: 'Averbação não encontrada.' });
  }
  if (!policyPertenceAoAtor(req, res, averbacao.policy_id)) return;
  if (averbacao.status !== 'PENDENTE_APROVACAO') {
    return res.status(409).json({
      status: 'erro',
      mensagem: 'Só é possível cancelar um documento ainda pendente de aprovação — este já foi decidido ou nunca esteve na fila.'
    });
  }
  averbacao.status = 'CANCELADO_NAO_AVERBADO';
  averbacao.decidido_por = req.backoffice?.user_id ?? req.backoffice?.actor_type;
  averbacao.decidido_em = new Date().toISOString();
  dbStore.persist();
  return res.json({ status: 'sucesso', averbacao });
});


export default router;
