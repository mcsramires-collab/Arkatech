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

router.post('/document-rules', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { tipo_documento, tag_path, nome_variavel, obrigatoria, observacao } = req.body;

  if (!tipo_documento || !tag_path || !nome_variavel) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'tipo_documento, tag_path e nome_variavel são obrigatórios.'
    });
  }

  const newRule: DocumentRule = {
    id: uuidv4(),
    tipo_documento,
    tag_path,
    nome_variavel,
    obrigatoria: obrigatoria !== undefined ? Boolean(obrigatoria) : true,
    origem: 'CUSTOM',
    observacao: observacao || 'Incluída manualmente',
    created_at: new Date().toISOString()
  };

  dbStore.documentRules.push(newRule);
  dbStore.persist();
  return res.json({ status: 'sucesso', rule: newRule });
});

router.put('/document-rules/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  const rule = dbStore.documentRules.find((r) => r.id === id);
  if (!rule) {
    return res.status(404).json({ status: 'erro', mensagem: 'Regra de documento não localizada.' });
  }

  const { obrigatoria, tag_path, nome_variavel, observacao } = req.body;
  if (obrigatoria !== undefined) rule.obrigatoria = Boolean(obrigatoria);
  if (tag_path !== undefined) rule.tag_path = tag_path;
  if (nome_variavel !== undefined) rule.nome_variavel = nome_variavel;
  if (observacao !== undefined) rule.observacao = observacao;

  dbStore.persist();
  return res.json({ status: 'sucesso', rule });
});

router.delete('/document-rules/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  // Permite excluir inclusive tags padrão Sefaz, caso o administrador deseje explicitamente.
  const exists = dbStore.documentRules.some((r) => r.id === id);
  if (!exists) {
    return res.status(404).json({ status: 'erro', mensagem: 'Regra de documento não localizada.' });
  }
  dbStore.documentRules = dbStore.documentRules.filter((r) => r.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Regra de documento removida com sucesso.' });
});

// --- 6. GESTÃO DE TEXTOS DE RETORNO EDITÁVEIS (response_templates) ---
// Sem consumidor no Portal da Seguradora hoje — administração interna, exclusiva de ADM.
router.get('/templates', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  return res.json({ status: 'sucesso', templates: dbStore.responseTemplates });
});

router.put('/templates/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  const template = dbStore.responseTemplates.find((t) => t.id === id);

  if (!template) {
    return res.status(404).json({ status: 'erro', mensagem: 'Template de resposta não encontrado.' });
  }

  const { texto_customizado } = req.body;
  if (texto_customizado !== undefined) {
    template.texto_customizado = texto_customizado;
    template.updated_at = new Date().toISOString();
  }

  dbStore.persist();
  return res.json({ status: 'sucesso', template });
});

// --- 7. GERADOR MOCK DE DOCUMENTOS FICTÍCIOS (Apenas Clientes 'teste') ---
// Sem consumidor no Portal da Seguradora hoje — ferramenta interna de testes, exclusiva de ADM.
router.post('/mock/generate', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const {
    tenant_id,
    tipo_doc,
    policy_id,
    incluir_variaveis_apolice,
    omitir_obrigatorias,
    como_destinatario,
    tp_amb_sefaz,
    omitir_grupo_seguro
  } = req.body;

  try {
    const xmlContent = MockGeneratorService.generateMockXML({
      tenantId: tenant_id,
      tipoDoc: (tipo_doc || 'CTE') as TipoDocumento,
      policyId: policy_id,
      incluirVariaveisApolice: Boolean(incluir_variaveis_apolice),
      omitirObrigatorias: omitir_obrigatorias || [],
      comoDestinatario: Boolean(como_destinatario),
      tpAmbSefaz: tp_amb_sefaz === 2 ? 2 : 1,
      omitirGrupoSeguro: Boolean(omitir_grupo_seguro)
    });
    return res.json({ status: 'sucesso', xml_content: xmlContent });
  } catch (err: any) {
    return res.status(400).json({ status: 'erro', mensagem: err.message });
  }
});

// --- 8. IMPORTAÇÃO EM LOTE DE XMLs PARA UM TRANSPORTADOR (validar averbação/recusa) ---
// Sem consumidor no Portal da Seguradora hoje — ferramenta interna de testes, exclusiva de ADM.
router.post('/importar-lote', upload.array('arquivos', 200), async (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { tenant_id, ramo } = req.body;
  const files = req.files as Express.Multer.File[] | undefined;

  if (!tenant_id || !ramo) {
    return res.status(400).json({ status: 'erro', mensagem: 'tenant_id e ramo são obrigatórios.' });
  }
  if (!files || files.length === 0) {
    return res.status(400).json({ status: 'erro', mensagem: 'Nenhum arquivo XML foi enviado.' });
  }

  const appBaseUrl = `${req.protocol}://${req.get('host')}`;
  const resultados = files.map((file) => {
    const xmlContent = file.buffer.toString('utf-8');
    const resultado = AverbacaoService.process(
      { tenant_id, ramo, xml_content: xmlContent },
      appBaseUrl
    );
    return {
      arquivo: file.originalname,
      status: resultado.status,
      codigo: resultado.codigo,
      mensagem: resultado.mensagem,
      numero_averbacao: resultado.numero_averbacao,
      variaveis_faltantes: resultado.variaveis_faltantes
    };
  });

  const totalSucesso = resultados.filter((r) => r.status === 'sucesso' || r.status === 'aviso').length;
  const totalErro = resultados.filter((r) => r.status === 'erro').length;

  return res.json({
    status: 'sucesso',
    total: resultados.length,
    total_sucesso: totalSucesso,
    total_erro: totalErro,
    resultados
  });
});

// --- 9. SIMULADOR DE CARGA EM LOTE MULTI-CLIENTE ---
// Sem consumidor no Portal da Seguradora hoje — ferramenta interna de testes, exclusiva de ADM.
router.post('/simulador/executar', async (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  try {
    const batchRun = await BatchRunnerService.executeBatch(req.body);
    return res.json({ status: 'sucesso', batchRun });
  } catch (err: any) {
    return res.status(400).json({ status: 'erro', mensagem: err.message });
  }
});

router.get('/simulador/historico', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  return res.json({ status: 'sucesso', historico: dbStore.batchTestRuns });
});

// --- 10. EXPURGO AUTOMÁTICO DE DADOS DE TESTE ---
// Sem consumidor no Portal da Seguradora hoje — ferramenta interna, exclusiva de ADM.
router.post('/expurgo', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { dias } = req.body;
  const result = PurgeService.purgeTestData(Number(dias || 30));
  return res.json({ status: 'sucesso', result });
});

// --- 11. RELATÓRIO POR CLIENTE OU CONJUNTO DE CLIENTES ---
// Sem consumidor no Portal da Seguradora hoje — administração interna, exclusiva de ADM (o
// relatório não é escopado por insurer_id, então não pode ser aberto para SEGURADORA sem
// filtragem — ver Backlog para essa decisão futura, se algum dia for exposto no portal).
router.get('/relatorio', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { tenant_ids } = req.query;

  const ids = tenant_ids
    ? String(tenant_ids).split(',').filter(Boolean)
    : dbStore.tenants.map((t) => t.id);

  const porCliente = ids.map((tenantId) => {
    const tenant = dbStore.tenants.find((t) => t.id === tenantId);
    const averbacoesDoCliente = dbStore.averbacoes.filter((a) => a.tenant_id === tenantId);
    const sucesso = averbacoesDoCliente.filter((a) => a.status === 'SUCESSO');
    const erro = averbacoesDoCliente.filter((a) => a.status === 'ERRO');
    const valorTotal = sucesso.reduce((acc, a) => acc + (a.valor_carga || 0), 0);

    return {
      tenant_id: tenantId,
      razao_social: tenant?.razao_social || 'Cliente não encontrado',
      cnpj: tenant?.cnpj || '-',
      total_averbacoes: averbacoesDoCliente.length,
      total_sucesso: sucesso.length,
      total_erro: erro.length,
      valor_total_averbado: valorTotal,
      por_tipo_documento: {
        CTE: averbacoesDoCliente.filter((a) => a.tipo_documento === 'CTE').length,
        NFE: averbacoesDoCliente.filter((a) => a.tipo_documento === 'NFE').length,
        NFSE: averbacoesDoCliente.filter((a) => a.tipo_documento === 'NFSE').length,
        MDFE: averbacoesDoCliente.filter((a) => a.tipo_documento === 'MDFE').length
      }
    };
  });

  const consolidado = {
    total_averbacoes: porCliente.reduce((acc, c) => acc + c.total_averbacoes, 0),
    total_sucesso: porCliente.reduce((acc, c) => acc + c.total_sucesso, 0),
    total_erro: porCliente.reduce((acc, c) => acc + c.total_erro, 0),
    valor_total_averbado: porCliente.reduce((acc, c) => acc + c.valor_total_averbado, 0)
  };

  return res.json({ status: 'sucesso', consolidado, por_cliente: porCliente });
});

// --- 12. DOCUMENTAÇÃO DA API (serve o Markdown de referência de cada endpoint) ---
// Sem consumidor no Portal da Seguradora hoje — referência técnica interna, exclusiva de ADM.
router.get('/docs', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  try {
    const docPath = path.join(__dirname, '../../docs/API_DOCUMENTATION.md');
    const content = fs.readFileSync(docPath, 'utf-8');
    return res.json({ status: 'sucesso', content });
  } catch (err: any) {
    return res.status(500).json({ status: 'erro', mensagem: 'Documentação não encontrada no servidor.' });
  }
});

// Dashboard Analytics — visão GLOBAL (todas as seguradoras somadas), uso interno ARCKATECH.
// Distinto de /insurer-dashboard-stats (abaixo), que é escopado por insurer_id e é o que o
// Portal da Seguradora de fato consome.
router.get('/dashboard-stats', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const totalClientes = dbStore.tenants.length;
  const clientesTeste = dbStore.tenants.filter((t) => t.ambiente === 'teste').length;
  const clientesProd = dbStore.tenants.filter((t) => t.ambiente === 'producao').length;

  const totalAverbacoes = dbStore.averbacoes.length;
  const averbacoesProd = dbStore.averbacoes.filter((a) => a.ambiente === 'producao').length;
  const averbacoesTeste = dbStore.averbacoes.filter((a) => a.ambiente === 'teste').length;

  const totalApolices = dbStore.policies.length;

  return res.json({
    status: 'sucesso',
    stats: {
      totalClientes,
      clientesTeste,
      clientesProd,
      totalAverbacoes,
      averbacoesProd,
      averbacoesTeste,
      totalApolices
    }
  });
});

// =====================================================================
// FASE 2 — ENDPOINTS DE SEGURADORA
// =====================================================================

// --- A. Lookup de CNPJ com visibilidade mínima (só números de ramo vigentes) ---
router.get('/tenants/lookup', (req, res) => {
  const cnpj = String(req.query.cnpj || '').replace(/\D/g, '');
  if (!cnpj) {
    return res.status(400).json({ status: 'erro', mensagem: 'Informe o CNPJ para consulta.' });
  }

  const tenant = dbStore.tenants.find((t) => t.cnpj.replace(/\D/g, '') === cnpj);
  if (!tenant) {
    return res.json({ status: 'sucesso', encontrado: false, ramos_vigentes: [] });
  }

  const ramosVigentes = Array.from(
    new Set(
      dbStore.policies
        .filter((p) => p.tenant_id === tenant.id && p.status === 'ATIVA')
        .map((p) => p.ramo)
    )
  );

  // Visibilidade mínima: nunca retornar insurer_id, broker_id, valores ou qualquer outro dado.
  return res.json({ status: 'sucesso', encontrado: true, ramos_vigentes: ramosVigentes });
});

// URL pública do Portal do Segurado, usada para montar o link do e-mail de convite abaixo.
// PUBLIC_APP_URL já é a variável documentada em .env.production.example para "a URL pública do
// app"; localhost:5173 como fallback cobre o dev local do arckatech-cargo-portal (vite dev).
function portalSeguradoBaseUrl(): string {
  return process.env.PUBLIC_APP_URL || 'http://localhost:5173';
}

/**
 * Gera um novo ActivationToken de convite (Termo de Uso + primeira senha) para o tenant, e tenta
 * enviar o e-mail via Resend — usado tanto na criação de um cliente novo (POST /insurer-clients)
 * quanto no reenvio manual (POST /insurer-clients/:tenantId/reenviar-convite, abaixo). Nunca
 * lança: se o e-mail não puder ser enviado, devolve o motivo para quem chamou decidir o que
 * mostrar na tela (o convite/token continua criado e válido de qualquer forma — só o e-mail
 * automático que pode ter falhado).
 */
async function criarEEnviarConvite(
  tenant: Tenant,
  nomeConvidado: string | undefined,
  emailConvidado: string | undefined
): Promise<{ enviado: boolean; destino?: string; motivo?: string }> {
  const activationToken = {
    id: uuidv4(),
    tenant_id: tenant.id,
    token: `act_${uuidv4()}`,
    termo_versao: 'v1',
    aceite: false,
    expira_em: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    convite_nome: nomeConvidado,
    convite_email: emailConvidado
  };
  dbStore.activationTokens.push(activationToken);
  dbStore.persist();

  const destino = (emailConvidado || tenant.contato_email || '').trim();
  if (!destino) {
    return { enviado: false, motivo: 'Nenhum e-mail de contato informado para este cliente.' };
  }

  const resultado = await sendActivationInviteEmail({
    to: destino,
    nomeDestinatario: nomeConvidado || tenant.contato_nome || tenant.razao_social,
    razaoSocial: tenant.razao_social,
    activationUrl: `${portalSeguradoBaseUrl()}/ativacao/${activationToken.token}`
  });

  return { ...resultado, destino };
}

// --- B. Cadastro de Cliente pela Seguradora (cria tenant + apólice, ou detecta conflito) ---
router.post('/insurer-clients', requirePermission('clientes', 'editar'), async (req: BackofficeAuthenticatedRequest, res) => {
  const {
    broker_id,
    co_broker_id,
    assessoria_id,
    cnpj,
    razao_social,
    nome_fantasia,
    ramo,
    numero_apolice,
    lmi,
    vigencia_inicio,
    vigencia_fim,
    permitir_inativo_vencido,
    aceita_averbacao_como_destinatario,
    contato_nome,
    contato_email,
    contato_telefone_fixo,
    contato_celular,
    logradouro,
    numero_endereco,
    bairro,
    cidade,
    uf,
    cep
  } = req.body;
  const insurer_id = resolveInsurerId(req, res, req.body.insurer_id);
  if (!insurer_id) return;

  if (!broker_id || !cnpj || !razao_social || !ramo || !numero_apolice) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'broker_id, cnpj, razao_social, ramo e numero_apolice são obrigatórios.'
    });
  }

  const cnpjLimpo = String(cnpj).replace(/\D/g, '');
  let tenant = dbStore.tenants.find((t) => t.cnpj.replace(/\D/g, '') === cnpjLimpo);
  let clienteNovo = false;

  if (tenant) {
    // Cliente já existe — checar conflito de ramo com OUTRA seguradora
    const policyConflitante = dbStore.policies.find(
      (p) => p.tenant_id === tenant!.id && p.ramo === ramo && p.status === 'ATIVA' && p.insurer_id !== insurer_id
    );

    if (policyConflitante) {
      return res.status(409).json({
        status: 'conflito',
        mensagem: `Já existe uma apólice ativa do ramo ${ramo} para este CNPJ vinculada a outra seguradora.`,
        tenant_id: tenant.id,
        ramo,
        instrucao: 'Use POST /admin/insurer-clients/:tenantId/assume-policy para assumir a responsabilidade desta apólice.'
      });
    }

    const jaTemEsseRamoComEstaSeguradora = dbStore.policies.some(
      (p) => p.tenant_id === tenant!.id && p.ramo === ramo && p.insurer_id === insurer_id
    );
    if (jaTemEsseRamoComEstaSeguradora) {
      return res.status(400).json({
        status: 'erro',
        mensagem: 'Este cliente já possui uma apólice deste ramo com esta seguradora.'
      });
    }
  } else {
    // Cliente novo — cria o tenant
    clienteNovo = true;
    tenant = {
      id: `tenant_${cnpjLimpo}_${Date.now()}`,
      cnpj,
      razao_social,
      status: 'ATIVO',
      ambiente: 'producao',
      client_id: `client_prod_${cnpjLimpo}`,
      client_secret_hash: `secret_${cnpjLimpo}`,
      role: 'TRANSPORTADOR',
      token_duration_hours: 8,
      created_at: new Date().toISOString(),
      contato_nome,
      contato_email,
      contato_telefone_fixo,
      contato_celular,
      nome_fantasia,
      logradouro,
      numero_endereco,
      bairro,
      cidade,
      uf,
      cep,
      conta_ativada: false
    };
    dbStore.tenants.push(tenant);
  }

  const newPolicy: Policy = {
    id: `pol_${String(ramo).toLowerCase()}_${Date.now()}`,
    numero_apolice,
    ramo,
    tenant_id: tenant.id,
    insurer_id,
    broker_id,
    co_broker_id,
    assessoria_id,
    status: 'ATIVA',
    permitir_inativo_vencido: Boolean(permitir_inativo_vencido),
    vigencia_inicio: vigencia_inicio || new Date().toISOString(),
    vigencia_fim: vigencia_fim || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    lmi: lmi !== undefined ? Number(lmi) : undefined,
    aceita_averbacao_como_destinatario: Boolean(aceita_averbacao_como_destinatario)
  };
  dbStore.policies.push(newPolicy);
  dbStore.persist();

  // Convite por e-mail (Termo de Uso + primeira senha) só é disparado na criação do cliente —
  // um cliente já existente que ganha mais uma apólice/ramo não deve receber um novo convite
  // toda vez (senão a pessoa recebe um e-mail de "defina sua senha" repetido a cada apólice nova).
  let convite: { enviado: boolean; destino?: string; motivo?: string } | undefined;
  if (clienteNovo) {
    convite = await criarEEnviarConvite(tenant, contato_nome, contato_email);
  }

  return res.json({ status: 'sucesso', tenant, policy: newPolicy, convite });
});

/**
 * POST /admin/insurer-clients/:tenantId/reenviar-convite
 * Gera um novo convite (Termo de Uso + primeira senha) e tenta reenviar o e-mail — para quando o
 * primeiro convite expirou (30 dias), foi perdido/caiu em spam, ou o e-mail de contato mudou.
 * O corpo aceita um `email` opcional para reenviar a um endereço diferente do cadastrado.
 */
router.post('/insurer-clients/:tenantId/reenviar-convite', requirePermission('clientes', 'editar'), async (req: BackofficeAuthenticatedRequest, res) => {
  const { tenantId } = req.params;
  const { email } = req.body as { email?: string };

  const tenant = dbStore.tenants.find((t) => t.id === tenantId);
  if (!tenant) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cliente não encontrado.' });
  }
  // Este tenant não tem insurer_id direto — pertencimento é verificado via as apólices que o
  // ligam a uma seguradora (mesma lógica de GET /tenants acima).
  const ator = req.backoffice;
  if (ator?.actor_type === 'SEGURADORA') {
    const pertence = dbStore.policies.some((p) => p.tenant_id === tenantId && p.insurer_id === ator.insurer_id);
    if (!pertence) {
      return res.status(403).json({ status: 'erro', mensagem: 'Este cliente não pertence à sua seguradora.' });
    }
  } else if (ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  if (tenant.conta_ativada) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'Este cliente já ativou a conta. Não há convite pendente para reenviar.'
    });
  }

  const convite = await criarEEnviarConvite(tenant, tenant.contato_nome, email || tenant.contato_email);
  return res.json({ status: 'sucesso', convite });
});

// --- C. Assumir Apólice em Conflito ---
router.post('/insurer-clients/:tenantId/assume-policy', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { tenantId } = req.params;
  const { broker_id, ramo, numero_apolice, lmi, vigencia_inicio, vigencia_fim, permitir_inativo_vencido, aceita_averbacao_como_destinatario } =
    req.body;
  const insurer_id = resolveInsurerId(req, res, req.body.insurer_id);
  if (!insurer_id) return;

  const policy = dbStore.policies.find((p) => p.tenant_id === tenantId && p.ramo === ramo && p.status === 'ATIVA');
  if (!policy) {
    return res.status(404).json({ status: 'erro', mensagem: 'Nenhuma apólice ativa encontrada para este cliente/ramo.' });
  }

  policy.insurer_id = insurer_id;
  policy.broker_id = broker_id;
  if (numero_apolice) policy.numero_apolice = numero_apolice;
  if (lmi !== undefined) policy.lmi = Number(lmi);
  if (vigencia_inicio) policy.vigencia_inicio = vigencia_inicio;
  if (vigencia_fim) policy.vigencia_fim = vigencia_fim;
  if (permitir_inativo_vencido !== undefined) policy.permitir_inativo_vencido = Boolean(permitir_inativo_vencido);
  if (aceita_averbacao_como_destinatario !== undefined) {
    policy.aceita_averbacao_como_destinatario = Boolean(aceita_averbacao_como_destinatario);
  }

  dbStore.persist();
  return res.json({ status: 'sucesso', policy });
});

// --- D. Coberturas Adicionais da Seguradora (insurer_coverages) ---
router.get('/insurer-coverages', requirePermission('coberturas', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const insurer_id = resolveInsurerId(req, res, req.query.insurer_id);
  if (!insurer_id) return;
  const items = dbStore.insurerCoverages.filter((c) => c.insurer_id === insurer_id);
  return res.json({ status: 'sucesso', coverages: items });
});

router.post('/insurer-coverages', requirePermission('coberturas', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { ramo, titulo, exemplo_preenchimento, obrigatoria, aplicar_todos_clientes, tenant_id, tipo_valor } = req.body;
  const insurer_id = resolveInsurerId(req, res, req.body.insurer_id);
  if (!insurer_id) return;

  if (!titulo) {
    return res.status(400).json({ status: 'erro', mensagem: 'titulo é obrigatório.' });
  }
  if (aplicar_todos_clientes === false && !tenant_id) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'tenant_id é obrigatório quando aplicar_todos_clientes for false.'
    });
  }

  const newCoverage: InsurerCoverage = {
    id: uuidv4(),
    insurer_id,
    ramo,
    titulo,
    exemplo_preenchimento,
    obrigatoria: Boolean(obrigatoria),
    aplicar_todos_clientes: aplicar_todos_clientes !== false,
    tenant_id: aplicar_todos_clientes === false ? tenant_id : undefined,
    tipo_valor: tipo_valor === 'monetario' ? 'monetario' : 'informativo',
    created_at: new Date().toISOString()
  };

  dbStore.insurerCoverages.push(newCoverage);
  dbStore.persist();
  return res.json({ status: 'sucesso', coverage: newCoverage });
});

router.put('/insurer-coverages/:id', requirePermission('coberturas', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const coverage = dbStore.insurerCoverages.find((c) => c.id === id);
  if (!coverage) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cobertura adicional não encontrada.' });
  }
  const ator = req.backoffice;
  if (ator?.actor_type === 'SEGURADORA' && coverage.insurer_id !== ator.insurer_id) {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta cobertura não pertence à sua seguradora.' });
  }
  if (ator?.actor_type !== 'SEGURADORA' && ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }

  const { ramo, titulo, exemplo_preenchimento, obrigatoria, aplicar_todos_clientes, tenant_id, tipo_valor } = req.body;
  if (ramo !== undefined) coverage.ramo = ramo;
  if (titulo !== undefined) coverage.titulo = titulo;
  if (exemplo_preenchimento !== undefined) coverage.exemplo_preenchimento = exemplo_preenchimento;
  if (obrigatoria !== undefined) coverage.obrigatoria = Boolean(obrigatoria);
  if (aplicar_todos_clientes !== undefined) coverage.aplicar_todos_clientes = Boolean(aplicar_todos_clientes);
  if (tenant_id !== undefined) coverage.tenant_id = tenant_id;
  if (tipo_valor !== undefined) coverage.tipo_valor = tipo_valor === 'monetario' ? 'monetario' : 'informativo';

  dbStore.persist();
  return res.json({ status: 'sucesso', coverage });
});

router.delete('/insurer-coverages/:id', requirePermission('coberturas', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const coverage = dbStore.insurerCoverages.find((c) => c.id === id);
  const ator = req.backoffice;
  if (ator?.actor_type === 'SEGURADORA' && coverage && coverage.insurer_id !== ator.insurer_id) {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta cobertura não pertence à sua seguradora.' });
  }
  if (ator?.actor_type !== 'SEGURADORA' && ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  dbStore.insurerCoverages = dbStore.insurerCoverages.filter((c) => c.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Cobertura adicional removida com sucesso.' });
});

// --- E. Manutenção em Massa de Apólices ---
// Sem consumidor no Portal da Seguradora hoje — ferramenta interna, exclusiva de ADM (não filtra
// por insurer_id, então não pode ser aberta para SEGURADORA sem checar cada policy_id antes).
router.post('/policies/bulk-update', requirePermission('apolices', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { policy_ids, updates } = req.body;

  if (!Array.isArray(policy_ids) || policy_ids.length === 0) {
    return res.status(400).json({ status: 'erro', mensagem: 'Informe ao menos um policy_id em policy_ids.' });
  }

  const { lmi, vigencia_inicio, vigencia_fim, permitir_inativo_vencido } = updates || {};
  let atualizadas = 0;

  for (const policy of dbStore.policies) {
    if (!policy_ids.includes(policy.id)) continue;
    if (lmi !== undefined) policy.lmi = Number(lmi);
    if (vigencia_inicio !== undefined) policy.vigencia_inicio = vigencia_inicio;
    if (vigencia_fim !== undefined) policy.vigencia_fim = vigencia_fim;
    if (permitir_inativo_vencido !== undefined) policy.permitir_inativo_vencido = Boolean(permitir_inativo_vencido);
    atualizadas++;
  }

  dbStore.persist();
  return res.json({ status: 'sucesso', total_atualizadas: atualizadas });
});

// --- F. Perfis de Acesso (RBAC) ---
// Sem consumidor no Portal da Seguradora hoje — administração interna, exclusiva de ADM.
router.get('/rbac-profiles', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { owner_type, owner_id } = req.query;
  let items = dbStore.rbacProfiles;
  if (owner_type) items = items.filter((p) => p.owner_type === owner_type);
  if (owner_id) items = items.filter((p) => p.owner_id === owner_id);
  return res.json({ status: 'sucesso', profiles: items });
});

router.post('/rbac-profiles', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { owner_type, owner_id, nome_perfil, permissions } = req.body;
  if (!owner_type || !nome_perfil || !permissions) {
    return res.status(400).json({ status: 'erro', mensagem: 'owner_type, nome_perfil e permissions são obrigatórios.' });
  }

  const newProfile: RbacProfile = {
    id: uuidv4(),
    owner_type,
    owner_id,
    nome_perfil,
    permissions,
    created_at: new Date().toISOString()
  };
  dbStore.rbacProfiles.push(newProfile);
  dbStore.persist();
  return res.json({ status: 'sucesso', profile: newProfile });
});

router.put('/rbac-profiles/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  const profile = dbStore.rbacProfiles.find((p) => p.id === id);
  if (!profile) {
    return res.status(404).json({ status: 'erro', mensagem: 'Perfil de acesso não encontrado.' });
  }
  const { nome_perfil, permissions } = req.body;
  if (nome_perfil !== undefined) profile.nome_perfil = nome_perfil;
  if (permissions !== undefined) profile.permissions = permissions;
  dbStore.persist();
  return res.json({ status: 'sucesso', profile });
});

router.delete('/rbac-profiles/:id', (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  dbStore.rbacProfiles = dbStore.rbacProfiles.filter((p) => p.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Perfil de acesso removido com sucesso.' });
});

// --- G. Usuários Internos do Tenant (seguradora/corretora/transportador) ---
// Sem consumidor no Portal da Seguradora hoje — administração interna, exclusiva de ADM.
router.get('/tenant-users', requirePermission('usuarios', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { tenant_id } = req.query;
  let items = dbStore.tenantUsers;
  if (tenant_id) items = items.filter((u) => u.tenant_id === tenant_id);
  const usersSemSenha = items.map(({ password_hash, ...u }) => u);
  return res.json({ status: 'sucesso', users: usersSemSenha });
});

// Mesma lógica de senha temporária usada em POST /tenant/users — mantida em sincronia para que
// um usuário criado por aqui (painel admin interno da Arckatech) também consiga logar depois em
// POST /auth/portal-login. Não há envio de e-mail integrado: a senha em texto plano é devolvida
// UMA ÚNICA VEZ na resposta deste POST.
function gerarSenhaTemporaria(): string {
  return crypto.randomBytes(9).toString('base64url');
}

router.post('/tenant-users', requirePermission('usuarios', 'editar'), async (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { tenant_id, nome, email, rbac_profile_id, is_admin_da_conta } = req.body;
  if (!tenant_id || !nome || !email) {
    return res.status(400).json({ status: 'erro', mensagem: 'tenant_id, nome e email são obrigatórios.' });
  }

  const senhaTemporaria = gerarSenhaTemporaria();
  const passwordHash = await bcrypt.hash(senhaTemporaria, 10);

  const newUser: TenantUser = {
    id: uuidv4(),
    tenant_id,
    nome,
    email,
    password_hash: passwordHash,
    rbac_profile_id,
    is_admin_da_conta: Boolean(is_admin_da_conta),
    status: 'ATIVO',
    created_at: new Date().toISOString()
  };
  dbStore.tenantUsers.push(newUser);
  dbStore.persist();

  const { password_hash, ...userSemSenha } = newUser;
  return res.json({ status: 'sucesso', user: userSemSenha, senha_temporaria: senhaTemporaria });
});

router.put('/tenant-users/:id', requirePermission('usuarios', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  const user = dbStore.tenantUsers.find((u) => u.id === id);
  if (!user) {
    return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado.' });
  }
  const { nome, email, rbac_profile_id, status, is_admin_da_conta } = req.body;
  if (nome !== undefined) user.nome = nome;
  if (email !== undefined) user.email = email;
  if (rbac_profile_id !== undefined) user.rbac_profile_id = rbac_profile_id;
  if (status !== undefined) user.status = status;
  if (is_admin_da_conta !== undefined) user.is_admin_da_conta = Boolean(is_admin_da_conta);
  dbStore.persist();
  const { password_hash, ...userSemSenha } = user;
  return res.json({ status: 'sucesso', user: userSemSenha });
});

router.delete('/tenant-users/:id', requirePermission('usuarios', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  if (!apenasInternalUser(req, res)) return;
  const { id } = req.params;
  dbStore.tenantUsers = dbStore.tenantUsers.filter((u) => u.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Usuário removido com sucesso.' });
});

// --- H. Delegação de Poder Seguradora → Corretora ---
// insurer_id aqui é filtro opcional para ADM (preserva o comportamento de antes: sem informar,
// lista de todas as seguradoras) — só é obrigatório e forçado pelo token quando quem chama é
// uma SEGURADORA.
router.get('/delegation-permissions', requirePermission('delegacao_corretora', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { broker_id } = req.query;
  const ator = req.backoffice;
  let items = dbStore.delegationPermissions;
  if (ator?.actor_type === 'SEGURADORA') {
    if (!ator.insurer_id) {
      return res.status(403).json({ status: 'erro', mensagem: 'Seu usuário não está vinculado a nenhuma seguradora — sem acesso a esta área.' });
    }
    items = items.filter((d) => d.insurer_id === ator.insurer_id);
  } else if (ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  } else if (req.query.insurer_id) {
    items = items.filter((d) => d.insurer_id === req.query.insurer_id);
  }
  if (broker_id) items = items.filter((d) => d.broker_id === broker_id);
  return res.json({ status: 'sucesso', permissions: items });
});

router.put('/delegation-permissions', requirePermission('delegacao_corretora', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { broker_id, actions } = req.body;
  const insurer_id = resolveInsurerId(req, res, req.body.insurer_id);
  if (!insurer_id) return;
  if (!broker_id || !Array.isArray(actions)) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'broker_id e actions (lista de { action, requires_approval }) são obrigatórios.'
    });
  }

  for (const item of actions) {
    const existing = dbStore.delegationPermissions.find(
      (d) => d.insurer_id === insurer_id && d.broker_id === broker_id && d.action === item.action
    );
    if (existing) {
      existing.requires_approval = Boolean(item.requires_approval);
    } else {
      dbStore.delegationPermissions.push({
        id: uuidv4(),
        insurer_id,
        broker_id,
        action: item.action,
        requires_approval: Boolean(item.requires_approval)
      });
    }
  }

  dbStore.persist();
  return res.json({
    status: 'sucesso',
    permissions: dbStore.delegationPermissions.filter((d) => d.insurer_id === insurer_id && d.broker_id === broker_id)
  });
});

// --- Exceções por Segurado (override da matriz de delegação para um tenant específico dentro
// da carteira de uma corretora) — aba "Exceções por segurado" em Permissões e Autonomia. ---
router.get('/delegation-exceptions', requirePermission('delegacao_corretora', 'ver'), (req: BackofficeAuthenticatedRequest, res) => {
  const { broker_id } = req.query;
  const insurer_id = resolveInsurerId(req, res, req.query.insurer_id);
  if (!insurer_id) return;
  if (!broker_id) {
    return res.status(400).json({ status: 'erro', mensagem: 'broker_id é obrigatório.' });
  }
  const items = dbStore.delegationExceptions.filter((e) => e.insurer_id === insurer_id && e.broker_id === broker_id);
  return res.json({ status: 'sucesso', exceptions: items });
});

router.put('/delegation-exceptions', requirePermission('delegacao_corretora', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { broker_id, tenant_id, nivel } = req.body;
  const insurer_id = resolveInsurerId(req, res, req.body.insurer_id);
  if (!insurer_id) return;
  if (!broker_id || !tenant_id || !nivel) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'broker_id, tenant_id e nivel são obrigatórios.'
    });
  }
  const niveisValidos: DelegationExceptionLevel[] = ['AUTONOMO', 'MEDIANTE_APROVACAO', 'BLOQUEADA'];
  if (!niveisValidos.includes(nivel)) {
    return res.status(400).json({
      status: 'erro',
      mensagem: "nivel deve ser 'AUTONOMO', 'MEDIANTE_APROVACAO' ou 'BLOQUEADA'."
    });
  }

  const now = new Date().toISOString();
  let exception: DelegationException | undefined = dbStore.delegationExceptions.find(
    (e) => e.insurer_id === insurer_id && e.broker_id === broker_id && e.tenant_id === tenant_id
  );
  if (exception) {
    exception.nivel = nivel;
    exception.updated_at = now;
  } else {
    exception = { id: uuidv4(), insurer_id, broker_id, tenant_id, nivel, created_at: now, updated_at: now };
    dbStore.delegationExceptions.push(exception);
  }

  dbStore.persist();
  return res.json({ status: 'sucesso', exception });
});

router.delete('/delegation-exceptions/:id', requirePermission('delegacao_corretora', 'editar'), (req: BackofficeAuthenticatedRequest, res) => {
  const { id } = req.params;
  const exception = dbStore.delegationExceptions.find((e) => e.id === id);
  if (!exception) {
    return res.status(404).json({ status: 'erro', mensagem: 'Exceção não encontrada.' });
  }
  const ator = req.backoffice;
  if (ator?.actor_type === 'SEGURADORA' && exception.insurer_id !== ator.insurer_id) {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta exceção não pertence à sua seguradora.' });
  }
  if (ator?.actor_type !== 'SEGURADORA' && ator?.actor_type !== 'INTERNAL_USER') {
    return res.status(403).json({ status: 'erro', mensagem: 'Esta área é exclusiva de seguradoras e da administração Arckatech.' });
  }
  // Remover a exceção faz o segurado voltar a seguir a matriz geral (DelegationPermission).
  dbStore.delegationExceptions = dbStore.delegationExceptions.filter((e) => e.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Exceção removida — segurado volta a seguir a matriz geral.' });
});

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

// --- M. Sublimites por Mercadoria (lista por apólice) ---
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
  const { policy_id, tag, valor } = req.body;
  if (!policyPertenceAoAtor(req, res, policy_id)) return;
  if (!tag) {
    return res.status(400).json({ status: 'erro', mensagem: 'tag é obrigatório.' });
  }

  const newSublimite: PolicySublimite = {
    id: uuidv4(),
    policy_id,
    tag,
    valor: valor || 'R$ 0,00',
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

  const { tag, valor } = req.body;
  if (tag !== undefined) sublimite.tag = tag;
  if (valor !== undefined) sublimite.valor = valor;

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
  const averbacoesDaSeguradora = dbStore.averbacoes.filter((a) => policyIdsDaSeguradora.has(a.policy_id));

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
