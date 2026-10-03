import { Router } from 'express';
import { dbStore } from '../services/dbStore';
import { createBackofficeInvitation } from '../services/backofficeInvitationService';
import { createClientCredentials } from '../utils/clientCredentials';
import { isCnpjFormatValid, normalizeCnpj } from '../utils/cnpj';
import { Broker, BrokerPartnerType, Insurer, Tenant } from '../types';

const router = Router();

type EcosystemEntityType = 'SEGURADORA' | BrokerPartnerType;
type EcosystemKind = 'insurer' | 'broker';

const PARTNER_TYPES: BrokerPartnerType[] = ['CORRETORA', 'ASSESSORIA', 'AMBOS'];

function partnerCapabilities(type: EcosystemEntityType) {
  if (type === 'SEGURADORA') {
    return {
      pode_liderar_apolice: false,
      pode_atuar_como_cocorretora: false,
      pode_atuar_como_assessoria: false
    };
  }

  return {
    pode_liderar_apolice: type === 'CORRETORA' || type === 'AMBOS',
    pode_atuar_como_cocorretora: type === 'CORRETORA' || type === 'AMBOS',
    pode_atuar_como_assessoria: type === 'ASSESSORIA' || type === 'AMBOS'
  };
}

function tenantFor(entity: { tenant_id?: string }) {
  return entity.tenant_id
    ? dbStore.tenants.find((item) => item.id === entity.tenant_id)
    : undefined;
}

function normalizeEntityType(value: unknown): EcosystemEntityType | undefined {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'SEGURADORA') return 'SEGURADORA';
  if (PARTNER_TYPES.includes(normalized as BrokerPartnerType)) {
    return normalized as BrokerPartnerType;
  }
  return undefined;
}

function serializeInsurer(insurer: Insurer) {
  const tenant = tenantFor(insurer);
  return {
    id: insurer.id,
    kind: 'insurer' as const,
    entity_type: 'SEGURADORA' as const,
    tenant_id: insurer.tenant_id,
    cnpj: insurer.cnpj,
    razao_social: insurer.razao_social || insurer.nome,
    nome_fantasia: insurer.nome_fantasia,
    status: tenant?.status || 'ATIVO',
    admin_nome: tenant?.contato_nome,
    admin_email: tenant?.contato_email,
    policies_count: dbStore.policies.filter((policy) => policy.insurer_id === insurer.id).length,
    created_at: insurer.created_at,
    capabilities: partnerCapabilities('SEGURADORA')
  };
}

function serializeBroker(broker: Broker) {
  const tenant = tenantFor(broker);
  const entityType = broker.partner_type || 'CORRETORA';
  return {
    id: broker.id,
    kind: 'broker' as const,
    entity_type: entityType,
    tenant_id: broker.tenant_id,
    cnpj: broker.cnpj,
    razao_social: broker.razao_social || broker.nome,
    nome_fantasia: broker.nome_fantasia,
    status: tenant?.status || 'ATIVO',
    admin_nome: tenant?.contato_nome || broker.corretor_responsavel_nome,
    admin_email: tenant?.contato_email || broker.corretor_responsavel_email,
    policies_count: dbStore.policies.filter(
      (policy) =>
        policy.broker_id === broker.id ||
        policy.co_broker_id === broker.id ||
        policy.assessoria_id === broker.id
    ).length,
    created_at: broker.created_at,
    capabilities: partnerCapabilities(entityType)
  };
}

function findCnpjConflict(cnpj: string) {
  const normalized = normalizeCnpj(cnpj);
  const insurer = dbStore.insurers.find((item) => normalizeCnpj(item.cnpj) === normalized);
  if (insurer) return { kind: 'insurer' as const, id: insurer.id, entity_type: 'SEGURADORA' as const };

  const broker = dbStore.brokers.find((item) => normalizeCnpj(item.cnpj) === normalized);
  if (broker) {
    return {
      kind: 'broker' as const,
      id: broker.id,
      entity_type: broker.partner_type || ('CORRETORA' as const)
    };
  }

  return undefined;
}

router.get('/ecosystem-partners', (_req, res) => {
  const partners = [
    ...dbStore.insurers.map(serializeInsurer),
    ...dbStore.brokers.map(serializeBroker)
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return res.json({
    status: 'sucesso',
    partners,
    metadata: {
      co_corretora_is_policy_role: true,
      mensagem_co_corretora:
        'Co-corretora é um papel da apólice. Cadastre a empresa como CORRETORA ou AMBOS e selecione-a como co-corretora na apólice.'
    }
  });
});

router.post('/ecosystem-partners', async (req, res) => {
  const entityType = normalizeEntityType(req.body.entity_type);
  const cnpj = String(req.body.cnpj || '').trim();
  const razaoSocial = String(req.body.razao_social || '').trim();
  const nomeFantasia = String(req.body.nome_fantasia || '').trim() || undefined;
  const adminNome = String(req.body.admin_nome || '').trim() || undefined;
  const adminEmail = String(req.body.admin_email || '').trim().toLowerCase() || undefined;

  if (!entityType) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'entity_type deve ser SEGURADORA, CORRETORA, ASSESSORIA ou AMBOS.'
    });
  }

  if (!cnpj || !razaoSocial) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'cnpj e razao_social são obrigatórios.'
    });
  }

  const cleanCnpj = normalizeCnpj(cnpj);
  if (!isCnpjFormatValid(cleanCnpj)) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'CNPJ inválido. São aceitos CNPJs numéricos e alfanuméricos com 14 posições.'
    });
  }

  const conflict = findCnpjConflict(cleanCnpj);
  if (conflict) {
    return res.status(409).json({
      status: 'erro',
      codigo: 'ECOSYSTEM_CNPJ_ALREADY_REGISTERED',
      mensagem: 'Este CNPJ já está cadastrado no ecossistema.',
      existing: conflict
    });
  }

  const credentials = await createClientCredentials(
    entityType === 'SEGURADORA' ? 'prod_seguradora' : 'prod_parceiro'
  );
  const now = new Date().toISOString();
  const tenant: Tenant = {
    id: `tenant_${entityType.toLowerCase()}_${cleanCnpj}_${Date.now()}`,
    cnpj,
    razao_social: razaoSocial,
    nome_fantasia: nomeFantasia,
    status: 'ATIVO',
    ambiente: 'producao',
    client_id: credentials.client_id,
    client_secret_hash: credentials.client_secret_hash,
    role: entityType === 'SEGURADORA' ? 'SEGURADORA' : 'CORRETORA',
    token_duration_hours: 8,
    contato_nome: adminNome,
    contato_email: adminEmail,
    conta_ativada: adminEmail ? false : true,
    created_at: now
  };

  dbStore.tenants.push(tenant);

  let partner: ReturnType<typeof serializeInsurer> | ReturnType<typeof serializeBroker>;
  if (entityType === 'SEGURADORA') {
    const insurer: Insurer = {
      id: `ins_${cleanCnpj}_${Date.now()}`,
      tenant_id: tenant.id,
      cnpj,
      nome: razaoSocial,
      razao_social: razaoSocial,
      nome_fantasia: nomeFantasia,
      created_at: now
    };
    dbStore.insurers.push(insurer);
    partner = serializeInsurer(insurer);
  } else {
    const broker: Broker = {
      id: `brk_${cleanCnpj}_${Date.now()}`,
      tenant_id: tenant.id,
      cnpj,
      partner_type: entityType,
      nome: razaoSocial,
      razao_social: razaoSocial,
      nome_fantasia: nomeFantasia,
      corretor_responsavel_nome: adminNome,
      corretor_responsavel_email: adminEmail,
      created_at: now
    };
    dbStore.brokers.push(broker);
    partner = serializeBroker(broker);
  }

  dbStore.persist();

  const convite = adminEmail
    ? await createBackofficeInvitation(tenant, adminNome || razaoSocial, adminEmail)
    : undefined;

  return res.status(201).json({ status: 'sucesso', partner, convite });
});

router.put('/ecosystem-partners/:kind/:id', (req, res) => {
  const kind = req.params.kind as EcosystemKind;
  const { id } = req.params;
  const razaoSocial = req.body.razao_social !== undefined
    ? String(req.body.razao_social).trim()
    : undefined;
  const nomeFantasia = req.body.nome_fantasia !== undefined
    ? String(req.body.nome_fantasia).trim() || undefined
    : undefined;
  const status = req.body.status !== undefined ? String(req.body.status).toUpperCase() : undefined;

  if (status && !['ATIVO', 'INATIVO'].includes(status)) {
    return res.status(400).json({ status: 'erro', mensagem: 'status deve ser ATIVO ou INATIVO.' });
  }

  if (kind === 'insurer') {
    const insurer = dbStore.insurers.find((item) => item.id === id);
    if (!insurer) return res.status(404).json({ status: 'erro', mensagem: 'Seguradora não encontrada.' });

    if (razaoSocial) {
      insurer.razao_social = razaoSocial;
      insurer.nome = razaoSocial;
    }
    if (req.body.nome_fantasia !== undefined) insurer.nome_fantasia = nomeFantasia;

    const tenant = tenantFor(insurer);
    if (tenant) {
      if (razaoSocial) tenant.razao_social = razaoSocial;
      if (req.body.nome_fantasia !== undefined) tenant.nome_fantasia = nomeFantasia;
      if (status) tenant.status = status as Tenant['status'];
    }

    dbStore.persist();
    return res.json({ status: 'sucesso', partner: serializeInsurer(insurer) });
  }

  if (kind === 'broker') {
    const broker = dbStore.brokers.find((item) => item.id === id);
    if (!broker) return res.status(404).json({ status: 'erro', mensagem: 'Parceiro não encontrado.' });

    const partnerType = req.body.entity_type !== undefined
      ? normalizeEntityType(req.body.entity_type)
      : undefined;
    if (partnerType === 'SEGURADORA') {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'Um parceiro Broker não pode ser convertido diretamente em seguradora.'
      });
    }
    if (req.body.entity_type !== undefined && !partnerType) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'entity_type deve ser CORRETORA, ASSESSORIA ou AMBOS.'
      });
    }

    if (razaoSocial) {
      broker.razao_social = razaoSocial;
      broker.nome = razaoSocial;
    }
    if (req.body.nome_fantasia !== undefined) broker.nome_fantasia = nomeFantasia;
    if (partnerType) broker.partner_type = partnerType;

    const tenant = tenantFor(broker);
    if (tenant) {
      if (razaoSocial) tenant.razao_social = razaoSocial;
      if (req.body.nome_fantasia !== undefined) tenant.nome_fantasia = nomeFantasia;
      if (status) tenant.status = status as Tenant['status'];
    }

    dbStore.persist();
    return res.json({ status: 'sucesso', partner: serializeBroker(broker) });
  }

  return res.status(400).json({ status: 'erro', mensagem: 'kind deve ser insurer ou broker.' });
});

router.post('/ecosystem-partners/:kind/:id/reenviar-convite', async (req, res) => {
  const kind = req.params.kind as EcosystemKind;
  const { id } = req.params;
  const entity = kind === 'insurer'
    ? dbStore.insurers.find((item) => item.id === id)
    : kind === 'broker'
      ? dbStore.brokers.find((item) => item.id === id)
      : undefined;

  if (!entity) {
    return res.status(404).json({ status: 'erro', mensagem: 'Entidade do ecossistema não encontrada.' });
  }

  const tenant = tenantFor(entity);
  if (!tenant) {
    return res.status(409).json({
      status: 'erro',
      mensagem: 'A entidade não possui Tenant de acesso ao backoffice vinculado.'
    });
  }

  const email = String(req.body.admin_email || tenant.contato_email || '').trim().toLowerCase();
  const nome = String(req.body.admin_nome || tenant.contato_nome || tenant.razao_social).trim();
  if (!email) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Informe admin_email ou cadastre um e-mail de contato antes de reenviar o convite.'
    });
  }

  tenant.contato_email = email;
  tenant.contato_nome = nome;
  const convite = await createBackofficeInvitation(tenant, nome, email);

  return res.json({ status: 'sucesso', convite });
});

export default router;
