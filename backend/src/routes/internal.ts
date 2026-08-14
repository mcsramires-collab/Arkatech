import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from '../services/dbStore';
import { Tenant, Insurer, InternalUser } from '../types';

const router = Router();

/**
 * Rotas de uso exclusivo da equipe ARCKATECH (ADM/Agente) — acesso irrestrito,
 * sem as limitações de carteira que Seguradora/Corretora/Transportador têm.
 */

// --- Visão Irrestrita de Todos os Tenants ---
router.get('/tenants', (req, res) => {
  return res.json({ status: 'sucesso', tenants: dbStore.tenants });
});

// --- Provisionamento de Seguradoras (onboarding manual, feito pelo time comercial/ADM) ---
router.get('/insurers', (req, res) => {
  return res.json({ status: 'sucesso', insurers: dbStore.insurers });
});

router.post('/insurers', (req, res) => {
  const { cnpj, razao_social, nome_fantasia } = req.body;
  if (!cnpj || !razao_social) {
    return res.status(400).json({ status: 'erro', mensagem: 'cnpj e razao_social são obrigatórios.' });
  }

  const cnpjLimpo = cnpj.replace(/\D/g, '');
  const newTenant: Tenant = {
    id: `tenant_seguradora_${cnpjLimpo}_${Date.now()}`,
    cnpj,
    razao_social,
    status: 'ATIVO',
    ambiente: 'producao',
    client_id: `client_prod_seguradora_${cnpjLimpo}`,
    client_secret_hash: `secret_${cnpjLimpo}`,
    role: 'SEGURADORA',
    token_duration_hours: 8,
    created_at: new Date().toISOString(),
    conta_ativada: true
  };
  dbStore.tenants.push(newTenant);

  const newInsurer: Insurer = {
    id: `ins_${cnpjLimpo}_${Date.now()}`,
    tenant_id: newTenant.id,
    cnpj,
    nome: razao_social,
    razao_social,
    nome_fantasia,
    created_at: new Date().toISOString()
  };
  dbStore.insurers.push(newInsurer);

  dbStore.persist();
  return res.json({ status: 'sucesso', tenant: newTenant, insurer: newInsurer });
});

router.put('/insurers/:id', (req, res) => {
  const { id } = req.params;
  const insurer = dbStore.insurers.find((i) => i.id === id);
  if (!insurer) {
    return res.status(404).json({ status: 'erro', mensagem: 'Seguradora não encontrada.' });
  }
  const { razao_social, nome_fantasia } = req.body;
  if (razao_social !== undefined) insurer.razao_social = razao_social;
  if (nome_fantasia !== undefined) insurer.nome_fantasia = nome_fantasia;

  const tenant = dbStore.tenants.find((t) => t.id === insurer.tenant_id);
  if (tenant && razao_social !== undefined) tenant.razao_social = razao_social;

  dbStore.persist();
  return res.json({ status: 'sucesso', insurer });
});

router.delete('/insurers/:id', (req, res) => {
  const { id } = req.params;
  const insurer = dbStore.insurers.find((i) => i.id === id);
  if (!insurer) {
    return res.status(404).json({ status: 'erro', mensagem: 'Seguradora não encontrada.' });
  }
  // Desativa em vez de excluir de fato — preserva o histórico de apólices/averbações já vinculado.
  const tenant = dbStore.tenants.find((t) => t.id === insurer.tenant_id);
  if (tenant) tenant.status = 'INATIVO';

  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Seguradora desativada (histórico preservado).' });
});

// --- Gestão de ADM / Agentes ARCKATECH ---
router.get('/users', (req, res) => {
  return res.json({ status: 'sucesso', users: dbStore.internalUsers });
});

router.post('/users', (req, res) => {
  const { nome, email, role, rbac_profile_id } = req.body;
  if (!nome || !email || !role) {
    return res.status(400).json({ status: 'erro', mensagem: 'nome, email e role (ADM ou AGENTE) são obrigatórios.' });
  }
  if (role === 'AGENTE' && !rbac_profile_id) {
    return res.status(400).json({ status: 'erro', mensagem: 'rbac_profile_id é obrigatório para usuários do tipo AGENTE.' });
  }

  const newUser: InternalUser = {
    id: uuidv4(),
    nome,
    email,
    password_hash: `hash_${uuidv4()}`,
    role,
    rbac_profile_id: role === 'AGENTE' ? rbac_profile_id : undefined,
    status: 'ATIVO',
    created_at: new Date().toISOString()
  };
  dbStore.internalUsers.push(newUser);
  dbStore.persist();
  return res.json({ status: 'sucesso', user: newUser });
});

router.put('/users/:id', (req, res) => {
  const { id } = req.params;
  const user = dbStore.internalUsers.find((u) => u.id === id);
  if (!user) {
    return res.status(404).json({ status: 'erro', mensagem: 'Usuário interno não encontrado.' });
  }
  const { nome, email, rbac_profile_id, status } = req.body;
  if (nome !== undefined) user.nome = nome;
  if (email !== undefined) user.email = email;
  if (rbac_profile_id !== undefined) user.rbac_profile_id = rbac_profile_id;
  if (status !== undefined) user.status = status;

  dbStore.persist();
  return res.json({ status: 'sucesso', user });
});

router.delete('/users/:id', (req, res) => {
  const { id } = req.params;
  dbStore.internalUsers = dbStore.internalUsers.filter((u) => u.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Usuário interno removido com sucesso.' });
});

// --- Relatório Global (sem limitação de carteira) ---
router.get('/relatorio', (req, res) => {
  const transportadores = dbStore.tenants.filter((t) => t.role === 'TRANSPORTADOR');

  const porCliente = transportadores.map((tenant) => {
    const averbacoesDoCliente = dbStore.averbacoes.filter((a) => a.tenant_id === tenant.id);
    const sucesso = averbacoesDoCliente.filter((a) => a.status === 'SUCESSO');
    const erro = averbacoesDoCliente.filter((a) => a.status === 'ERRO');

    return {
      tenant_id: tenant.id,
      razao_social: tenant.razao_social,
      cnpj: tenant.cnpj,
      ambiente: tenant.ambiente,
      total_averbacoes: averbacoesDoCliente.length,
      total_sucesso: sucesso.length,
      total_erro: erro.length,
      valor_total_averbado: sucesso.reduce((acc, a) => acc + (a.valor_considerado_averbacao || a.valor_carga || 0), 0)
    };
  });

  const consolidado = {
    total_seguradoras: dbStore.tenants.filter((t) => t.role === 'SEGURADORA').length,
    total_corretoras: dbStore.tenants.filter((t) => t.role === 'CORRETORA').length,
    total_transportadores: transportadores.length,
    total_averbacoes: dbStore.averbacoes.length,
    total_sucesso: dbStore.averbacoes.filter((a) => a.status === 'SUCESSO').length,
    total_erro: dbStore.averbacoes.filter((a) => a.status === 'ERRO').length,
    total_aprovacoes_pendentes: dbStore.approvalRequests.filter((a) => a.status === 'PENDENTE').length,
    total_contas_pendentes_ativacao: dbStore.tenants.filter((t) => t.role === 'TRANSPORTADOR' && !t.conta_ativada).length
  };

  return res.json({ status: 'sucesso', consolidado, por_cliente: porCliente });
});

export default router;
