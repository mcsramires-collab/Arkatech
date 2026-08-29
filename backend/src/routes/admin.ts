import { Router, Response } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from '../services/dbStore';
import { ResponseTemplate, Tenant, Policy, PolicyRule, DocumentRule, TipoDocumento, InsurerCoverage, RbacProfile, TenantUser, BusinessRuleRequest, PolicyBusinessSettings, PolicySublimite, Broker, DelegationException, DelegationExceptionLevel, PolicyCoverageValue } from '../types';
import { MockGeneratorService } from '../services/mockGenerator';
import { BatchRunnerService } from '../services/batchRunner';
import { PurgeService } from '../services/purgeService';
import { AverbacaoService } from '../services/averbacao';
import { sendActivationInviteEmail } from '../services/emailService';
import { aplicarAcaoDelegada } from '../services/delegatedActions';
import { BackofficeAuthenticatedRequest } from '../middleware/authMiddleware';
import { requirePermission } from '../middleware/rbacMiddleware';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/**
 * Fase 4 do item "Login real + RBAC" (Backlog, seção 4) para admin.ts — ao contrário de
 * broker.ts (Fase 4 anterior: sem tráfego real hoje, migração completa de uma vez), estas rotas
 * JÁ são consumidas em produção pelo BFF do Portal da Seguradora (arckatechseguradora), que hoje
 * envia `insurer_id` fixo (`SEED_INSURER_ID` — ver claude/Backlog_Proximos_Passos.md no Project)
 * em ~30 pontos. A migração cobre exatamente essas rotas nesta rodada — mantendo 100%
 * compatibilidade para a administração Arckatech (login real ADM ou a chave interna, tratada
 * como ADM sintético), que continua podendo informar `insurer_id` livremente para dar suporte a
 * qualquer seguradora. Rotas que hoje não têm nenhum consumidor de frontend (gestão interna:
 * tenants POST/PUT, policy-rules, document-rules, templates, mock/generate, importar-lote,
 * simulador, expurgo, relatorio, docs, dashboard-stats global, rbac-profiles, tenant-users,
 * regras-solicitacoes, policies/bulk-update) foram restritas a `actor_type === 'INTERNAL_USER'`
 * (ver `apenasInternalUser` abaixo) — fecha o acesso de uma SEGURADORA/CORRETORA autenticada a
 * ferramentas de administração que nunca foram pensadas para esse público, sem risco de quebrar
 * nada (nenhum tráfego real passava por ali com outro ator).
 */
/**
 * "requirePermission() por módulo", item 2 da lista de próximos passos combinada com o usuário
 * (Backlog, seção 4) — até aqui, `resolveInsurerId`/`policyPertenceAoAtor`/`apenasInternalUser`
 * (Fase 4, acima) resolviam só IDENTIDADE (quem é o ator, o que ele pode enxergar por
 * carteira/apólice) — nunca NÍVEL de permissão. Um usuário de SEGURADORA com um RbacProfile
 * "só visualização" conseguia fazer POST/PUT/DELETE normalmente, contanto que a apólice/seguradora
 * fosse a dele. `requirePermission(modulo, nivel)` (já existia pronto desde a Fase 1, nunca ligado
 * a nenhuma rota) fecha essa lacuna.
 *
 * Onde foi ligado nesta rodada — rotas com consumidor real hoje no Portal da Seguradora/Corretora
 * (as mesmas que já usam `resolveInsurerId`/`policyPertenceAoAtor` acima), mapeadas para os 6
 * módulos de `RbacProfile.permissions` (ver rbacMiddleware.ts): `/policies` e as sub-rotas
 * escopadas por `policy_id` que não são valor-de-cobertura → `apolices`; `/insurer-coverages` e
 * `/policy-coverage-values` → `coberturas`; `/tenants` (GET) e `/insurer-clients` → `clientes`;
 * `/insurer-dashboard-stats` e `/insurer-averbacoes` → `relatorios`; `/delegation-permissions`,
 * `/delegation-exceptions` e `/approval-requests` → `delegacao_corretora`; `/tenant-users` →
 * `usuarios` (além do `apenasInternalUser` que já tinha).
 *
 * Onde NÃO foi ligado, de propósito: `/rbac-profiles` (gerenciar os próprios perfis de permissão
 * é mais sensível que qualquer nível de "usuarios" existente — fica exclusivo de ADM/AGENTE via
 * `apenasInternalUser`, sem mapeamento de módulo novo, até existir uma decisão explícita sobre
 * isso); `/brokers` (POST/PUT/DELETE — decisão de escopo já em aberto no Backlog, ver seção 2:
 * `Broker` é uma entidade global sem `insurer_id`, então nenhum dos 6 módulos existentes cobre
 * "gerenciar corretoras globalmente" de forma correta); `/tenants/me`,
 * `/tenants/me/session-duration`, `/tenants/lookup` (autoatendimento/consulta pública, não são
 * recursos de um "módulo" no sentido de RbacProfile); e as demais rotas já exclusivas de
 * `apenasInternalUser` sem consumidor real no frontend (`/policy-rules`, `/document-rules`,
 * `/templates`, `/mock/generate`, `/importar-lote`, `/simulador`, `/expurgo`, `/relatorio`,
 * `/docs`, `/dashboard-stats` global, `/regras-solicitacoes`) — continuam ADM/AGENTE-only como já
 * estavam; não têm um módulo de RbacProfile que faça sentido para elas hoje.
 *
 * `requirePermission` é aplicado como middleware de rota (roda ANTES do handler, e portanto antes
 * de `resolveInsurerId`/`policyPertenceAoAtor` dentro dele) — ADM sempre passa (bypass já
 * embutido no helper); AGENTE/SEGURADORA/CORRETORA precisam do nível mínimo no módulo. Isso é uma
 * mudança de comportamento real para o usuário de teste AGENTE (`perfilAgenteSuporte`, seed): ele
 * já tinha só "ver" nesses módulos por desenho do perfil, mas como nada checava o RbacProfile até
 * agora, ele conseguia editar/excluir livremente por ser INTERNAL_USER — agora fica de fato restrito
 * a leitura, como o perfil sempre disse que deveria ser.
 */
function resolveInsurerId(
  req: BackofficeAuthenticatedRequest,
  res: Response,
  insurerIdDaRequisicao: unknown
): string | null {
  const ator = req.backoffice;
  if (!ator) {
    res.status(401).json({ status: 'erro', mensagem: 'Autenticação de backoffice ausente.' });
    return null;
  }

  if (ator.actor_type === 'SEGURADORA') {
    if (!ator.insurer_id) {
      res.status(403).json({
        status: 'erro',
        mensagem: 'Seu usuário não está vinculado a nenhuma seguradora — sem acesso a esta área.'
      });
      return null;
    }
    return ator.insurer_id;
  }

  if (ator.actor_type === 'INTERNAL_USER') {
    if (!insurerIdDaRequisicao || typeof insurerIdDaRequisicao !== 'string') {
      res.status(400).json({ status: 'erro', mensagem: 'insurer_id é obrigatório.' });
      return null;
    }
    return insurerIdDaRequisicao;
  }

  res.status(403).json({
    status: 'erro',
    mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.'
  });
  return null;
}

/**
 * Para rotas escopadas por policy_id (regras/valores/sublimites/configs de UMA apólice
 * específica) em vez de insurer_id direto: confirma que a apólice pertence à seguradora
 * autenticada antes de deixar ler/escrever. ADM (real ou chave interna) continua sem restrição.
 */
function policyPertenceAoAtor(req: BackofficeAuthenticatedRequest, res: Response, policyId: unknown): boolean {
  const ator = req.backoffice;
  if (!ator) {
    res.status(401).json({ status: 'erro', mensagem: 'Autenticação de backoffice ausente.' });
    return false;
  }
  if (ator.actor_type === 'INTERNAL_USER') return true;
  if (ator.actor_type !== 'SEGURADORA') {
    res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
    return false;
  }
  if (!ator.insurer_id) {
    res.status(403).json({ status: 'erro', mensagem: 'Seu usuário não está vinculado a nenhuma seguradora — sem acesso a esta área.' });
    return false;
  }
  if (!policyId || typeof policyId !== 'string') {
    res.status(400).json({ status: 'erro', mensagem: 'policy_id é obrigatório.' });
    return false;
  }
  const policy = dbStore.policies.find((p) => p.id === policyId);
  if (!policy || policy.insurer_id !== ator.insurer_id) {
    res.status(403).json({ status: 'erro', mensagem: 'Esta apólice não pertence à sua seguradora.' });
    return false;
  }
  return true;
}

/** Rotas de administração interna sem consumidor no Portal da Seguradora hoje — ver comentário acima. */
function apenasInternalUser(req: BackofficeAuthenticatedRequest, res: Response): boolean {
  if (req.backoffice?.actor_type === 'INTERNAL_USER') return true;
  res.status(403).json({
    status: 'erro',
    mensagem: 'Esta área é exclusiva da administração Arckatech.'
  });
  return false;
}

/**
 * Fase 5 do item "Login real + RBAC" (Backlog, seção 4) — teto padrão de `token_duration_hours`
 * para tenants que nunca tiveram `token_duration_max_hours` customizado por um ADM (ver
 * `Tenant.token_duration_max_hours` em types/index.ts). Usado por `PUT
 * /tenants/me/session-duration` abaixo.
 */
const DEFAULT_TOKEN_DURATION_MAX_HOURS = 24;

// --- 1. GESTÃO DE CLIENTES / TENANTS (com flag ambiente: teste vs producao) ---
// GET fica aberto para SEGURADORA (filtrado à carteira dela, via as apólices que a vinculam a um
// tenant — Tenant não tem insurer_id direto) além de ADM — é o que back listarSegurados() no
// Portal da Seguradora consome. POST/PUT (acima) seguem exclusivos de ADM.
router.get('/tenants', requirePermission('clientes', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const ator = req.backoffice;
  if (ator?.actor_type === 'SEGURADORA') {
    if (!ator.insurer_id) {
      return res.status(403).json({ status: 'erro', mensagem: 'Seu usuário não está vinculado a nenhuma seguradora — sem acesso a esta área.' });
    }
    const tenantIds = new Set(dbStore.policies.filter((p) => p.insurer_id === ator.insurer_id).map((p) => p.tenant_id));
    return res.json({ status: 'sucesso', tenants: dbStore.tenants.filter((t) => tenantIds.has(t.id)) });
  }
  if (ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  return res.json({ status: 'sucesso', tenants: dbStore.tenants });
});

router.post('/tenants', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { cnpj, razao_social, ambiente, status, role, token_duration_hours, token_duration_max_hours } = req.body;

  if (!cnpj || !razao_social) {
    return res.status(400).json({ status: 'erro', mensagem: 'CNPJ e Razão Social são obrigatórios.' });
  }

  const cleanCnpj = cnpj.replace(/\D/g, '');

  const newTenant: Tenant = {
    id: `tenant_${cleanCnpj}_${Date.now()}`,
    cnpj,
    razao_social,
    status: status || 'ATIVO',
    ambiente: ambiente === 'producao' ? 'producao' : 'teste',
    client_id: `client_${ambiente === 'producao' ? 'prod' : 'teste'}_${cleanCnpj}`,
    client_secret_hash: `secret_${cleanCnpj}`,
    role: role || 'TRANSPORTADOR',
    token_duration_hours: Number(token_duration_hours || 8),
    ...(token_duration_max_hours ? { token_duration_max_hours: Number(token_duration_max_hours) } : {}),
    created_at: new Date().toISOString()
  };

  dbStore.tenants.unshift(newTenant);
  dbStore.persist();

  return res.json({ status: 'sucesso', tenant: newTenant });
});

router.put('/tenants/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  const tenant = dbStore.tenants.find((t) => t.id === id);

  if (!tenant) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cliente não localizado.' });
  }

  const {
    status,
    ambiente,
    razao_social,
    token_duration_hours,
    token_duration_max_hours,
    nome_fantasia,
    logradouro,
    numero_endereco,
    bairro,
    cidade,
    uf,
    cep
  } = req.body;
  if (status) tenant.status = status;
  if (ambiente) tenant.ambiente = ambiente;
  if (razao_social) tenant.razao_social = razao_social;
  if (token_duration_hours) tenant.token_duration_hours = Number(token_duration_hours);
  // Fase 5 do item "Login real + RBAC" (Backlog, seção 4) — só ADM pode alterar o teto (ver
  // POST/PUT abaixo, /tenants/me/session-duration, para o autoatendimento da própria
  // seguradora/corretora). Se o novo teto ficar abaixo da duração atual, a duração é reduzida
  // junto — nunca deixamos `token_duration_hours` > `token_duration_max_hours`.
  if (token_duration_max_hours) {
    tenant.token_duration_max_hours = Number(token_duration_max_hours);
    if (tenant.token_duration_hours > tenant.token_duration_max_hours) {
      tenant.token_duration_hours = tenant.token_duration_max_hours;
    }
  }
  if (nome_fantasia !== undefined) tenant.nome_fantasia = nome_fantasia;
  if (logradouro !== undefined) tenant.logradouro = logradouro;
  if (numero_endereco !== undefined) tenant.numero_endereco = numero_endereco;
  if (bairro !== undefined) tenant.bairro = bairro;
  if (cidade !== undefined) tenant.cidade = cidade;
  if (uf !== undefined) tenant.uf = uf;
  if (cep !== undefined) tenant.cep = cep;

  dbStore.persist();
  return res.json({ status: 'sucesso', tenant });
});

/**
 * GET /tenants/me — a própria seguradora/corretora consulta o registro do seu Tenant (inclui
 * `token_duration_hours`/`token_duration_max_hours`) — Fase 5 do item "Login real + RBAC"
 * (Backlog, seção 4). Distinto de `GET /tenants`, que lista os TENANTS CLIENTE (Transportador)
 * vinculados à carteira — o Tenant da própria seguradora/corretora nunca aparece ali.
 */
router.get('/tenants/me', (req: BackofficeAuthenticatedRequest, res) => {
  const ator = req.backoffice;
  if (ator?.actor_type !== 'SEGURADORA' && ator?.actor_type !== 'CORRETORA') {
    return res.status(403).json({
      status: 'erro',
      mensagem: 'Esta área é exclusiva de seguradoras e corretoras autenticadas por login real.'
    });
  }
  if (!ator.tenant_id) {
    return res.status(403).json({ status: 'erro', mensagem: 'Seu usuário não está vinculado a nenhuma empresa.' });
  }
  const tenant = dbStore.tenants.find((t) => t.id === ator.tenant_id);
  if (!tenant) {
    return res.status(404).json({ status: 'erro', mensagem: 'Empresa não localizada.' });
  }
  return res.json({
    status: 'sucesso',
    tenant: {
      ...tenant,
      token_duration_max_hours: tenant.token_duration_max_hours ?? DEFAULT_TOKEN_DURATION_MAX_HOURS
    }
  });
});

/**
 * PUT /tenants/me/session-duration — autoatendimento: a própria seguradora/corretora ajusta a
 * duração da SUA sessão (`token_duration_hours`), respeitando o teto que a administração
 * Arckatech definiu (`token_duration_max_hours`, default `DEFAULT_TOKEN_DURATION_MAX_HOURS`
 * quando nunca customizado). Fase 5 do item "Login real + RBAC" (Backlog, seção 4) — decisão do
 * usuário: "ADM define um teto, cada um ajusta dentro dele". Só afeta logins futuros — não existe
 * hoje nenhum mecanismo para encurtar/estender uma sessão já emitida (JWT stateless, sem estado
 * de sessão no servidor — ver discussão de revogação na mesma seção do Backlog).
 */
router.put('/tenants/me/session-duration', (req: BackofficeAuthenticatedRequest, res) => {
  const ator = req.backoffice;
  if (ator?.actor_type !== 'SEGURADORA' && ator?.actor_type !== 'CORRETORA') {
    return res.status(403).json({
      status: 'erro',
      mensagem: 'Esta área é exclusiva de seguradoras e corretoras autenticadas por login real.'
    });
  }
  if (!ator.tenant_id) {
    return res.status(403).json({ status: 'erro', mensagem: 'Seu usuário não está vinculado a nenhuma empresa.' });
  }
  const tenant = dbStore.tenants.find((t) => t.id === ator.tenant_id);
  if (!tenant) {
    return res.status(404).json({ status: 'erro', mensagem: 'Empresa não localizada.' });
  }

  const { token_duration_hours } = req.body;
  const horas = Number(token_duration_hours);
  const teto = tenant.token_duration_max_hours ?? DEFAULT_TOKEN_DURATION_MAX_HOURS;
  if (!token_duration_hours || !Number.isFinite(horas) || horas <= 0) {
    return res.status(400).json({ status: 'erro', mensagem: 'token_duration_hours é obrigatório e precisa ser um número maior que zero.' });
  }
  if (horas > teto) {
    return res.status(400).json({
      status: 'erro',
      mensagem: `A duração máxima permitida para sua empresa é de ${teto}h. Fale com a administração Arckatech para aumentar esse limite.`
    });
  }

  tenant.token_duration_hours = horas;
  dbStore.persist();
  return res.json({ status: 'sucesso', tenant: { ...tenant, token_duration_max_hours: teto } });
});

// --- 2. GESTÃO DE SEGURADORAS & CORRETORAS ---
router.get('/insurers', (req, res) => res.json({ status: 'sucesso', insurers: dbStore.insurers }));
router.get('/brokers', (req, res) => res.json({ status: 'sucesso', brokers: dbStore.brokers }));

// --- 3. GESTÃO DE APÓLICES (CRUD completo: criar, editar, excluir) ---
// Antes desta rodada, GET/POST/PUT/DELETE aqui não tinham NENHUM filtro por insurer_id — era o
// maior gap de isolamento entre seguradoras do sistema (uma SEGURADORA autenticada enxergava e
// editava apólices de qualquer outra). Ver claude/Backlog_Proximos_Passos.md no Project.
router.get('/policies', requirePermission('apolices', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const ator = req.backoffice;
  if (ator?.actor_type === 'SEGURADORA') {
    if (!ator.insurer_id) {
      return res.status(403).json({ status: 'erro', mensagem: 'Seu usuário não está vinculado a nenhuma seguradora — sem acesso a esta área.' });
    }
    return res.json({ status: 'sucesso', policies: dbStore.policies.filter((p) => p.insurer_id === ator.insurer_id) });
  }
  if (ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  return res.json({ status: 'sucesso', policies: dbStore.policies });
});

router.post('/policies', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { numero_apolice, ramo, tenant_id, broker_id, co_broker_id, assessoria_id, permitir_inativo_vencido, status, vigencia_inicio, vigencia_fim, lmi, aceita_averbacao_como_destinatario } = req.body;
  const insurer_id = resolveInsurerId(req, res, req.body.insurer_id);
  if (!insurer_id) return;

  if (!numero_apolice || !ramo || !tenant_id || !broker_id) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'numero_apolice, ramo, tenant_id e broker_id são obrigatórios.'
    });
  }

  const newPolicy: Policy = {
    id: `pol_${ramo.toLowerCase()}_${Date.now()}`,
    numero_apolice,
    ramo,
    tenant_id,
    insurer_id,
    broker_id,
    co_broker_id,
    assessoria_id,
    status: status || 'ATIVA',
    permitir_inativo_vencido: Boolean(permitir_inativo_vencido),
    vigencia_inicio: vigencia_inicio || new Date().toISOString(),
    vigencia_fim: vigencia_fim || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    lmi: lmi !== undefined ? Number(lmi) : undefined,
    aceita_averbacao_como_destinatario: Boolean(aceita_averbacao_como_destinatario)
  };

  dbStore.policies.unshift(newPolicy);
  dbStore.persist();
  return res.json({ status: 'sucesso', policy: newPolicy });
});

router.put('/policies/:id', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const policy = dbStore.policies.find((p) => p.id === id);

  if (!policy) {
    return res.status(404).json({ status: 'erro', mensagem: 'Apólice não localizada.' });
  }
  if (!policyPertenceAoAtor(req, res, id)) return;

  const { status, permitir_inativo_vencido, numero_apolice, ramo, insurer_id, broker_id, vigencia_inicio, vigencia_fim, lmi } = req.body;
  if (status !== undefined) policy.status = status;
  if (permitir_inativo_vencido !== undefined) policy.permitir_inativo_vencido = Boolean(permitir_inativo_vencido);
  if (numero_apolice !== undefined) policy.numero_apolice = numero_apolice;
  if (ramo !== undefined) policy.ramo = ramo;
  // Trocar a apólice de seguradora só é permitido para ADM — uma SEGURADORA não pode "empurrar"
  // uma apólice da própria carteira para outra seguradora.
  if (insurer_id !== undefined && req.backoffice?.actor_type === 'INTERNAL_USER') policy.insurer_id = insurer_id;
  if (broker_id !== undefined) policy.broker_id = broker_id;
  if (vigencia_inicio !== undefined) policy.vigencia_inicio = vigencia_inicio;
  if (vigencia_fim !== undefined) policy.vigencia_fim = vigencia_fim;
  if (lmi !== undefined) policy.lmi = lmi === null || lmi === '' ? undefined : Number(lmi);

  dbStore.persist();
  return res.json({ status: 'sucesso', policy });
});

router.delete('/policies/:id', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const exists = dbStore.policies.some((p) => p.id === id);
  if (!exists) {
    return res.status(404).json({ status: 'erro', mensagem: 'Apólice não localizada.' });
  }
  if (!policyPertenceAoAtor(req, res, id)) return;
  dbStore.policies = dbStore.policies.filter((p) => p.id !== id);
  // Remove também as variáveis (policyRules) atreladas a essa apólice
  dbStore.policyRules = dbStore.policyRules.filter((r) => r.policy_id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Apólice removida com sucesso.' });
});

// --- 4. VARIÁVEIS DE NEGÓCIO DA APÓLICE (PolicyRule) — CRUD completo ---
// Sem consumidor no Portal da Seguradora hoje — administração interna, exclusiva de ADM.
router.get('/policy-rules', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  return res.json({ status: 'sucesso', rules: dbStore.policyRules });
});

router.post('/policy-rules', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { policy_id, tipo_doc, tag_path, nome_variavel, obrigatoria, exemplo_preenchimento, instrucao_recuperacao } = req.body;

  if (!policy_id || !nome_variavel) {
    return res.status(400).json({ status: 'erro', mensagem: 'policy_id e nome_variavel são obrigatórios.' });
  }

  const newRule: PolicyRule = {
    id: uuidv4(),
    policy_id,
    tipo_doc: tipo_doc || 'TODOS',
    tag_path,
    nome_variavel,
    obrigatoria: obrigatoria !== undefined ? Boolean(obrigatoria) : true,
    exemplo_preenchimento,
    instrucao_recuperacao
  };

  dbStore.policyRules.push(newRule);
  dbStore.persist();
  return res.json({ status: 'sucesso', rule: newRule });
});

router.put('/policy-rules/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  const rule = dbStore.policyRules.find((r) => r.id === id);
  if (!rule) {
    return res.status(404).json({ status: 'erro', mensagem: 'Variável de apólice não localizada.' });
  }

  const { tipo_doc, tag_path, nome_variavel, obrigatoria, exemplo_preenchimento, instrucao_recuperacao } = req.body;
  if (tipo_doc !== undefined) rule.tipo_doc = tipo_doc;
  if (tag_path !== undefined) rule.tag_path = tag_path;
  if (nome_variavel !== undefined) rule.nome_variavel = nome_variavel;
  if (obrigatoria !== undefined) rule.obrigatoria = Boolean(obrigatoria);
  if (exemplo_preenchimento !== undefined) rule.exemplo_preenchimento = exemplo_preenchimento;
  if (instrucao_recuperacao !== undefined) rule.instrucao_recuperacao = instrucao_recuperacao;

  dbStore.persist();
  return res.json({ status: 'sucesso', rule });
});

router.delete('/policy-rules/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  dbStore.policyRules = dbStore.policyRules.filter((r) => r.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Variável removida com sucesso.' });
});

// --- 5. REGRAS DE OBRIGATORIEDADE POR TIPO DE DOCUMENTO (DocumentRule — padrão Sefaz) ---
// Sem consumidor no Portal da Seguradora hoje — administração interna, exclusiva de ADM.
router.get('/document-rules', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { tipo_documento } = req.query;
  let items = dbStore.documentRules;
  if (tipo_documento) {
    items = items.filter((r) => r.tipo_documento === (tipo_documento as string));
  }
  return res.json({ status: 'sucesso', rules: items });
});
