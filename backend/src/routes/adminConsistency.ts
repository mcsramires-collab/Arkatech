import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from '../services/dbStore';
import { auditService, AuditActor, AuditAction } from '../services/auditService';
import { BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';
import { requirePermission } from '../middleware/rbacMiddleware';
import { apenasInternalUser, policyPertenceAoAtor, tenantPertenceAoAtor } from './adminHelpers';
import { normalizeCnpj, isCnpjFormatValid } from '../utils/cnpj';

const router = Router();
const TEN_MINUTES = 10 * 60 * 1000;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function actor(req: BackofficeAuthenticatedRequest): AuditActor {
  const a = req.backoffice;
  if (!a) return { actor_type: 'SYSTEM' };
  return {
    actor_type: a.actor_type,
    actor_id: a.user_id,
    actor_name: a.nome,
    insurer_id: a.insurer_id
  };
}

function recordAudit(
  req: BackofficeAuthenticatedRequest,
  input: {
    tenant_id?: string;
    policy_id?: string;
    module: string;
    entity_type: string;
    entity_id: string;
    action: AuditAction;
    before?: unknown;
    after?: unknown;
    reason?: string;
    insurer_id?: string;
  }
) {
  const a = actor(req);
  return auditService.record({
    ...a,
    insurer_id: input.insurer_id ?? a.insurer_id,
    tenant_id: input.tenant_id,
    policy_id: input.policy_id,
    module: input.module,
    entity_type: input.entity_type,
    entity_id: input.entity_id,
    action: input.action,
    before: input.before,
    after: input.after,
    reason: input.reason
  });
}

function applyScheduledCnpjStatus(registro: any) {
  if (
    registro.status === 'ATIVO' &&
    registro.inativacao_programada_para &&
    Date.parse(registro.inativacao_programada_para) <= Date.now()
  ) {
    registro.status = 'INATIVO';
    registro.inativado_em = new Date().toISOString();
    registro.inativacao_programada_para = undefined;
    return true;
  }
  return false;
}

function insurerForPolicy(policyId?: string) {
  return policyId ? dbStore.policies.find((p) => p.id === policyId)?.insurer_id : undefined;
}

// ---------------------------------------------------------------------------
// AUDITORIA REAL
// ---------------------------------------------------------------------------
router.get('/audit-events', requirePermission('relatorios', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const a = req.backoffice;
  if (!a) return res.status(401).json({ status: 'erro', mensagem: 'Autenticação ausente.' });
  if (a.actor_type !== 'INTERNAL_USER' && a.actor_type !== 'SEGURADORA') {
    return res.status(403).json({ status: 'erro', mensagem: 'Auditoria disponível para seguradoras e administração Arckatech.' });
  }

  const insurerId = a.actor_type === 'SEGURADORA' ? a.insurer_id : (req.query.insurer_id ? String(req.query.insurer_id) : undefined);
  const events = auditService.list({
    insurer_id: insurerId,
    tenant_id: req.query.tenant_id ? String(req.query.tenant_id) : undefined,
    policy_id: req.query.policy_id ? String(req.query.policy_id) : undefined,
    module: req.query.module ? String(req.query.module) : undefined,
    entity_type: req.query.entity_type ? String(req.query.entity_type) : undefined,
    entity_id: req.query.entity_id ? String(req.query.entity_id) : undefined,
    actor_id: req.query.actor_id ? String(req.query.actor_id) : undefined,
    action: req.query.action ? String(req.query.action) as AuditAction : undefined,
    from: req.query.from ? String(req.query.from) : undefined,
    to: req.query.to ? String(req.query.to) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined
  });
  return res.json({ status: 'sucesso', audit_events: events });
});

// ---------------------------------------------------------------------------
// CNPJ ADICIONAL — PERFIL + LIFECYCLE PROGRAMADO
// Estas rotas têm os MESMOS caminhos das legadas e este router é montado antes do adminRouter.
// ---------------------------------------------------------------------------
router.get('/tenants/:id/cnpjs-adicionais', requirePermission('clientes', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const tenantId = req.params.id;
  if (!tenantPertenceAoAtor(req, res, tenantId)) return;
  let changed = false;
  const rows = dbStore.tenantCnpjsAdicionais.filter((item) => item.tenant_id === tenantId);
  for (const row of rows) changed = applyScheduledCnpjStatus(row as any) || changed;
  if (changed) dbStore.persist();
  return res.json({ status: 'sucesso', cnpjs: rows });
});

router.post('/tenants/:id/cnpjs-adicionais', requirePermission('clientes', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const tenantId = req.params.id;
  if (!tenantPertenceAoAtor(req, res, tenantId)) return;
  const tenant = dbStore.tenants.find((item) => item.id === tenantId);
  if (!tenant) return res.status(404).json({ status: 'erro', mensagem: 'Cliente não encontrado.' });

  const cnpj = String(req.body?.cnpj ?? '').trim();
  const tipo = req.body?.tipo;
  if (!cnpj || !['filial', 'adicional'].includes(tipo)) {
    return res.status(400).json({ status: 'erro', mensagem: "cnpj e tipo ('filial' ou 'adicional') são obrigatórios." });
  }
  const normalized = normalizeCnpj(cnpj);
  if (!isCnpjFormatValid(normalized)) {
    return res.status(400).json({ status: 'erro', mensagem: 'CNPJ adicional inválido.' });
  }
  if (dbStore.tenantCnpjsAdicionais.some((item) => item.tenant_id === tenantId && normalizeCnpj(item.cnpj) === normalized)) {
    return res.status(409).json({ status: 'erro', mensagem: 'Este CNPJ já está cadastrado para este cliente.' });
  }

  const row: any = {
    id: uuidv4(),
    tenant_id: tenantId,
    cnpj,
    tipo,
    status: 'ATIVO',
    razao_social: req.body?.razao_social || undefined,
    nome_fantasia: req.body?.nome_fantasia || undefined,
    logradouro: req.body?.logradouro || undefined,
    numero_endereco: req.body?.numero_endereco || undefined,
    bairro: req.body?.bairro || undefined,
    cidade: req.body?.cidade || undefined,
    uf: req.body?.uf || undefined,
    cep: req.body?.cep || undefined,
    created_at: new Date().toISOString()
  };
  dbStore.tenantCnpjsAdicionais.push(row);
  dbStore.persist();
  recordAudit(req, {
    tenant_id: tenantId,
    insurer_id: req.backoffice?.insurer_id,
    module: 'clientes',
    entity_type: 'TENANT_CNPJ_ADICIONAL',
    entity_id: row.id,
    action: 'CREATE',
    after: row
  });
  return res.status(201).json({ status: 'sucesso', cnpj_adicional: row });
});

router.put('/tenants/:id/cnpjs-adicionais/:cnpjId', requirePermission('clientes', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const tenantId = req.params.id;
  if (!tenantPertenceAoAtor(req, res, tenantId)) return;
  const row: any = dbStore.tenantCnpjsAdicionais.find((item) => item.id === req.params.cnpjId && item.tenant_id === tenantId);
  if (!row) return res.status(404).json({ status: 'erro', mensagem: 'CNPJ adicional não encontrado.' });
  const before = clone(row);

  for (const field of ['razao_social', 'nome_fantasia', 'logradouro', 'numero_endereco', 'bairro', 'cidade', 'uf', 'cep']) {
    if (req.body?.[field] !== undefined) row[field] = req.body[field] || undefined;
  }

  if (req.body?.status !== undefined) {
    if (!['ATIVO', 'INATIVO'].includes(req.body.status)) {
      return res.status(400).json({ status: 'erro', mensagem: "status deve ser 'ATIVO' ou 'INATIVO'." });
    }
    if (req.body.status === 'ATIVO') {
      row.status = 'ATIVO';
      row.inativacao_programada_para = undefined;
      row.inativado_em = undefined;
      row.reativado_em = new Date().toISOString();
    } else {
      const schedule = req.body?.inativacao_programada_para ? String(req.body.inativacao_programada_para) : undefined;
      if (schedule && Number.isNaN(Date.parse(schedule))) {
        return res.status(400).json({ status: 'erro', mensagem: 'inativacao_programada_para deve ser uma data ISO válida.' });
      }
      if (schedule && Date.parse(schedule) > Date.now()) {
        row.status = 'ATIVO';
        row.inativacao_programada_para = schedule;
      } else {
        row.status = 'INATIVO';
        row.inativacao_programada_para = undefined;
        row.inativado_em = new Date().toISOString();
      }
    }
  }

  applyScheduledCnpjStatus(row);
  dbStore.persist();
  recordAudit(req, {
    tenant_id: tenantId,
    insurer_id: req.backoffice?.insurer_id,
    module: 'clientes',
    entity_type: 'TENANT_CNPJ_ADICIONAL',
    entity_id: row.id,
    action: before.status !== row.status ? 'STATUS_CHANGE' : 'UPDATE',
    before,
    after: row,
    reason: req.body?.motivo ? String(req.body.motivo) : undefined
  });
  return res.json({ status: 'sucesso', cnpj_adicional: row });
});

// ---------------------------------------------------------------------------
// HISTÓRICO DE PARCERIA — REVERSÃO SEM APAGAR E BACKFILL
// ---------------------------------------------------------------------------
router.post(
  '/policies/:id/trocar-parceria/:vinculoId/desfazer',
  requirePermission('apolices', 'editar'),
  (req: BackofficeAuthenticatedRequest, res) => {
    const policyId = req.params.id;
    if (!policyPertenceAoAtor(req, res, policyId)) return;
    const policy = dbStore.policies.find((item) => item.id === policyId);
    if (!policy) return res.status(404).json({ status: 'erro', mensagem: 'Apólice não localizada.' });

    const current: any = dbStore.policyPartnerHistory.find((item) => item.id === req.params.vinculoId && item.policy_id === policyId);
    if (!current) return res.status(404).json({ status: 'erro', mensagem: 'Vínculo não encontrado nesta apólice.' });
    if (current.revertido_em) return res.status(409).json({ status: 'erro', mensagem: 'Esta troca já foi desfeita.' });
    if (Date.now() - Date.parse(current.created_at) > TEN_MINUTES) {
      return res.status(409).json({ status: 'erro', mensagem: 'O prazo de 10 minutos para desfazer esta troca já passou.' });
    }

    const previous: any = dbStore.policyPartnerHistory
      .filter((item: any) => item.policy_id === policyId && item.papel === current.papel && item.id !== current.id && !item.revertido_em)
      .sort((a, b) => b.vigencia_inicio.localeCompare(a.vigencia_inicio))[0];
    const before = { policy: clone(policy), current: clone(current), previous: clone(previous) };

    // Não apaga o evento: encerra o vínculo criado por engano e registra explicitamente a reversão.
    current.vigencia_fim = current.vigencia_inicio;
    current.revertido_em = new Date().toISOString();
    current.revertido_por = req.backoffice?.user_id ?? req.backoffice?.actor_type;
    current.motivo_reversao = req.body?.motivo ? String(req.body.motivo) : 'Troca desfeita dentro da janela operacional.';
    if (previous) previous.vigencia_fim = undefined;

    const revertedBrokerId = previous?.broker_id;
    if (current.papel === 'lider') {
      if (revertedBrokerId) policy.broker_id = revertedBrokerId;
    } else if (current.papel === 'cocorretora') {
      policy.co_broker_id = revertedBrokerId;
    } else {
      policy.assessoria_id = revertedBrokerId;
    }

    const reversal: any = {
      id: uuidv4(),
      policy_id: policyId,
      papel: current.papel,
      broker_id: revertedBrokerId ?? current.broker_id,
      vigencia_inicio: new Date().toISOString(),
      vigencia_fim: new Date().toISOString(),
      created_at: new Date().toISOString(),
      evento: 'REVERSAO',
      reversao_de_id: current.id
    };
    dbStore.policyPartnerHistory.push(reversal);
    dbStore.persist();
    recordAudit(req, {
      tenant_id: policy.tenant_id,
      policy_id: policy.id,
      insurer_id: policy.insurer_id,
      module: 'apolices',
      entity_type: 'POLICY_PARTNER_HISTORY',
      entity_id: current.id,
      action: 'REVERSAL',
      before,
      after: { policy, current, previous, reversal },
      reason: current.motivo_reversao
    });
    return res.json({ status: 'sucesso', policy, vinculo_revertido: current, evento_reversao: reversal });
  }
);

router.post('/partner-history/backfill', (req: BackofficeAuthenticatedRequest, res: Response) => {
  if (!apenasInternalUser(req, res)) return;
  let created = 0;
  for (const policy of dbStore.policies) {
    const roles: Array<{ papel: 'lider' | 'cocorretora' | 'assessoria'; broker_id?: string }> = [
      { papel: 'lider', broker_id: policy.broker_id },
      { papel: 'cocorretora', broker_id: policy.co_broker_id },
      { papel: 'assessoria', broker_id: policy.assessoria_id }
    ];
    for (const role of roles) {
      if (!role.broker_id) continue;
      const exists = dbStore.policyPartnerHistory.some((item) => item.policy_id === policy.id && item.papel === role.papel);
      if (exists) continue;
      dbStore.policyPartnerHistory.push({
        id: uuidv4(),
        policy_id: policy.id,
        papel: role.papel,
        broker_id: role.broker_id,
        vigencia_inicio: policy.vigencia_inicio,
        created_at: new Date().toISOString()
      });
      created += 1;
    }
  }
  if (created) dbStore.persist();
  recordAudit(req, {
    module: 'apolices',
    entity_type: 'POLICY_PARTNER_HISTORY',
    entity_id: 'BACKFILL',
    action: 'BACKFILL',
    after: { created }
  });
  return res.json({ status: 'sucesso', created });
});

// ---------------------------------------------------------------------------
// FICHA DO SEGURADO — SAVE ÚNICO COM VALIDAÇÃO PRÉVIA E ROLLBACK EM MEMÓRIA
// ---------------------------------------------------------------------------
router.put('/insured-profile/:tenantId', requirePermission('clientes', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const tenantId = req.params.tenantId;
  if (!tenantPertenceAoAtor(req, res, tenantId)) return;
  const tenant = dbStore.tenants.find((item) => item.id === tenantId);
  if (!tenant) return res.status(404).json({ status: 'erro', mensagem: 'Segurado não encontrado.' });

  const policies = Array.isArray(req.body?.policies) ? req.body.policies : [];
  const policyIds = new Set<string>();
  for (const patch of policies) {
    if (!patch?.id || typeof patch.id !== 'string') return res.status(400).json({ status: 'erro', mensagem: 'Cada policy precisa de id.' });
    const policy = dbStore.policies.find((item) => item.id === patch.id && item.tenant_id === tenantId);
    if (!policy) return res.status(400).json({ status: 'erro', mensagem: `Policy ${patch.id} não pertence ao segurado.` });
    if (!policyPertenceAoAtor(req, res, patch.id)) return;
    policyIds.add(patch.id);
  }

  const referencedPolicyIds = [
    ...(Array.isArray(req.body?.business_settings) ? req.body.business_settings : []),
    ...(Array.isArray(req.body?.titularity_rules) ? req.body.titularity_rules : []),
    ...(Array.isArray(req.body?.bypass_rules) ? req.body.bypass_rules : []),
    ...(Array.isArray(req.body?.sublimits) ? req.body.sublimits : []),
    ...(Array.isArray(req.body?.coverage_values) ? req.body.coverage_values : [])
  ].map((item: any) => item?.policy_id);
  if (referencedPolicyIds.some(id => typeof id !== 'string' || !id)) {
    return res.status(400).json({ status: 'erro', mensagem: 'policy_id obrigatório em cada configuração.' });
  }
  for (const policyId of referencedPolicyIds) {
    const policy = dbStore.policies.find((item) => item.id === policyId && item.tenant_id === tenantId);
    if (!policy) return res.status(400).json({ status: 'erro', mensagem: `Referência inválida à policy ${policyId}.` });
    if (!policyPertenceAoAtor(req, res, policyId)) return;
    policyIds.add(policyId);
  }

  const visiblePolicy = (item: { id: string; tenant_id: string; insurer_id: string }) =>
    item.tenant_id === tenantId && (req.backoffice?.actor_type === 'INTERNAL_USER' || item.insurer_id === req.backoffice?.insurer_id);
  const visibleIds = new Set(dbStore.policies.filter(visiblePolicy).map(item => item.id));
  const publicTenant = (value: typeof tenant) => {
    const { client_secret_hash, ...safe } = value;
    return safe;
  };
  const snapshot = {
    tenant: clone(tenant),
    policies: clone(dbStore.policies),
    cnpjs: clone(dbStore.tenantCnpjsAdicionais),
    settings: clone(dbStore.policyBusinessSettings),
    titularity: clone(dbStore.policyTitularityRules),
    bypass: clone(dbStore.policyBypassRules),
    sublimits: clone(dbStore.policySublimites),
    coverageValues: clone(dbStore.policyCoverageValues)
  };

  try {
    const company = req.body?.company ?? {};
    for (const field of ['razao_social', 'nome_fantasia', 'contato_nome', 'contato_email', 'contato_telefone_fixo', 'contato_celular', 'logradouro', 'numero_endereco', 'bairro', 'cidade', 'uf', 'cep', 'tipo_operacao']) {
      if (company[field] !== undefined) (tenant as any)[field] = company[field] || undefined;
    }

    for (const patch of policies) {
      const policy = dbStore.policies.find((item) => item.id === patch.id)!;
      for (const field of ['numero_apolice', 'status', 'permitir_inativo_vencido', 'vigencia_inicio', 'vigencia_fim', 'lmi', 'aceita_averbacao_como_destinatario', 'codigo_interno_seguradora', 'broker_id', 'co_broker_id', 'assessoria_id']) {
        if (patch[field] !== undefined) (policy as any)[field] = patch[field] === null ? undefined : patch[field];
      }
    }

    if (Array.isArray(req.body?.additional_cnpjs)) {
      for (const input of req.body.additional_cnpjs) {
        if (input.id) {
          const row: any = dbStore.tenantCnpjsAdicionais.find((item) => item.id === input.id && item.tenant_id === tenantId);
          if (!row) throw new Error(`CNPJ adicional ${input.id} não pertence ao segurado.`);
          for (const field of ['razao_social', 'nome_fantasia', 'logradouro', 'numero_endereco', 'bairro', 'cidade', 'uf', 'cep', 'status', 'inativacao_programada_para']) {
            if (input[field] !== undefined) row[field] = input[field] || undefined;
          }
        } else {
          const normalized = normalizeCnpj(input.cnpj || '');
          if (!isCnpjFormatValid(normalized) || !['filial', 'adicional'].includes(input.tipo)) throw new Error('Novo CNPJ adicional inválido.');
          if (dbStore.tenantCnpjsAdicionais.some((item) => item.tenant_id === tenantId && normalizeCnpj(item.cnpj) === normalized)) throw new Error(`CNPJ adicional ${input.cnpj} duplicado.`);
          dbStore.tenantCnpjsAdicionais.push({
            id: uuidv4(), tenant_id: tenantId, cnpj: input.cnpj, tipo: input.tipo,
            razao_social: input.razao_social || undefined, status: input.status === 'INATIVO' ? 'INATIVO' : 'ATIVO',
            created_at: new Date().toISOString(),
            ...Object.fromEntries(['nome_fantasia', 'logradouro', 'numero_endereco', 'bairro', 'cidade', 'uf', 'cep', 'inativacao_programada_para'].filter((field) => input[field] !== undefined).map((field) => [field, input[field]]))
          } as any);
        }
      }
    }

    for (const input of Array.isArray(req.body?.business_settings) ? req.body.business_settings : []) {
      const existing = dbStore.policyBusinessSettings.find((item) => item.policy_id === input.policy_id);
      if (existing) { existing.config = clone(input.config || {}); existing.updated_at = new Date().toISOString(); }
      else dbStore.policyBusinessSettings.push({ id: uuidv4(), policy_id: input.policy_id, config: clone(input.config || {}), updated_at: new Date().toISOString() });
    }

    for (const input of Array.isArray(req.body?.titularity_rules) ? req.body.titularity_rules : []) {
      dbStore.policyTitularityRules = dbStore.policyTitularityRules.filter((item) => item.policy_id !== input.policy_id);
      for (const rule of input.rules || []) dbStore.policyTitularityRules.push({ id: uuidv4(), policy_id: input.policy_id, funcao: rule.funcao, habilitada: rule.habilitada !== false });
    }

    for (const input of Array.isArray(req.body?.bypass_rules) ? req.body.bypass_rules : []) {
      dbStore.policyBypassRules = dbStore.policyBypassRules.filter((item) => item.policy_id !== input.policy_id);
      for (const rule of input.rules || []) dbStore.policyBypassRules.push({ id: uuidv4(), policy_id: input.policy_id, rota_uf_origem: rule.rota_uf_origem || undefined, rota_uf_destino: rule.rota_uf_destino || undefined, produto_predominante: rule.produto_predominante || undefined });
    }

    for (const input of Array.isArray(req.body?.sublimits) ? req.body.sublimits : []) {
      dbStore.policySublimites = dbStore.policySublimites.filter((item) => item.policy_id !== input.policy_id);
      for (const item of input.items || []) dbStore.policySublimites.push({ id: uuidv4(), policy_id: input.policy_id, tag: item.tag || undefined, valor: String(item.valor), tipo_condicao: item.tipo_condicao || 'mercadoria', cnpj_tomador: item.cnpj_tomador || undefined, created_at: new Date().toISOString() });
    }

    for (const input of Array.isArray(req.body?.coverage_values) ? req.body.coverage_values : []) {
      const policy = dbStore.policies.find((item) => item.id === input.policy_id)!;
      for (const item of input.items || []) {
        const coverage = dbStore.insurerCoverages.find((row) => row.id === item.insurer_coverage_id && row.insurer_id === policy.insurer_id);
        if (!coverage) throw new Error(`Cobertura ${item.insurer_coverage_id} não pertence à seguradora da apólice.`);
      }
      dbStore.policyCoverageValues = dbStore.policyCoverageValues.filter((item) => item.policy_id !== input.policy_id);
      for (const item of input.items || []) dbStore.policyCoverageValues.push({ id: uuidv4(), policy_id: input.policy_id, insurer_coverage_id: item.insurer_coverage_id, valor: Number(item.valor), desconta_lmi: Boolean(item.desconta_lmi), created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    }

    dbStore.persist();
    const after = {
      tenant: publicTenant(tenant),
      policies: dbStore.policies.filter(visiblePolicy),
      cnpjs: dbStore.tenantCnpjsAdicionais.filter((item) => item.tenant_id === tenantId),
      policy_ids: Array.from(policyIds)
    };
    recordAudit(req, {
      tenant_id: tenantId,
      insurer_id: req.backoffice?.insurer_id,
      module: 'clientes',
      entity_type: 'INSURED_PROFILE',
      entity_id: tenantId,
      action: 'BULK_UPDATE',
      before: {
        tenant: publicTenant(snapshot.tenant),
        policies: snapshot.policies.filter(visiblePolicy),
        cnpjs: snapshot.cnpjs.filter(item => item.tenant_id === tenantId),
        settings: snapshot.settings.filter(item => visibleIds.has(item.policy_id)),
        titularity: snapshot.titularity.filter(item => visibleIds.has(item.policy_id)),
        bypass: snapshot.bypass.filter(item => visibleIds.has(item.policy_id)),
        sublimits: snapshot.sublimits.filter(item => visibleIds.has(item.policy_id)),
        coverageValues: snapshot.coverageValues.filter(item => visibleIds.has(item.policy_id))
      },
      after,
      reason: req.body?.reason ? String(req.body.reason) : 'Salvar Ficha do Segurado'
    });
    return res.json({ status: 'sucesso', profile: after });
  } catch (error) {
    for (const key of Object.keys(tenant)) delete (tenant as any)[key];
    Object.assign(tenant, snapshot.tenant);
    dbStore.policies = snapshot.policies;
    dbStore.tenantCnpjsAdicionais = snapshot.cnpjs;
    dbStore.policyBusinessSettings = snapshot.settings;
    dbStore.policyTitularityRules = snapshot.titularity;
    dbStore.policyBypassRules = snapshot.bypass;
    dbStore.policySublimites = snapshot.sublimits;
    dbStore.policyCoverageValues = snapshot.coverageValues;
    return res.status(400).json({ status: 'erro', mensagem: error instanceof Error ? error.message : 'Falha ao salvar Ficha do Segurado.' });
  }
});

export default router;
