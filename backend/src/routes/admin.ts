import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from '../services/dbStore';
import { ResponseTemplate, Tenant, Policy, PolicyRule } from '../types';
import { MockGeneratorService } from '../services/mockGenerator';
import { BatchRunnerService } from '../services/batchRunner';
import { PurgeService } from '../services/purgeService';

const router = Router();

// --- 1. GESTÃO DE CLIENTES / TENANTS (com flag ambiente: teste vs producao) ---
router.get('/tenants', (req, res) => {
  return res.json({ status: 'sucesso', tenants: dbStore.tenants });
});

router.post('/tenants', (req, res) => {
  const { cnpj, razao_social, ambiente, status, role, token_duration_hours } = req.body;

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
    created_at: new Date().toISOString()
  };

  dbStore.tenants.unshift(newTenant);
  dbStore.persist();

  return res.json({ status: 'sucesso', tenant: newTenant });
});

router.put('/tenants/:id', (req, res) => {
  const { id } = req.params;
  const tenant = dbStore.tenants.find((t) => t.id === id);

  if (!tenant) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cliente não localizado.' });
  }

  const { status, ambiente, razao_social, token_duration_hours } = req.body;
  if (status) tenant.status = status;
  if (ambiente) tenant.ambiente = ambiente;
  if (razao_social) tenant.razao_social = razao_social;
  if (token_duration_hours) tenant.token_duration_hours = Number(token_duration_hours);

  dbStore.persist();
  return res.json({ status: 'sucesso', tenant });
});

// --- 2. GESTÃO DE SEGURADORAS & CORRETORAS ---
router.get('/insurers', (req, res) => res.json({ status: 'sucesso', insurers: dbStore.insurers }));
router.get('/brokers', (req, res) => res.json({ status: 'sucesso', brokers: dbStore.brokers }));

// --- 3. GESTÃO DE APÓLICES & REGRAS DINÂMICAS ---
router.get('/policies', (req, res) => res.json({ status: 'sucesso', policies: dbStore.policies }));

router.post('/policies', (req, res) => {
  const { numero_apolice, ramo, tenant_id, insurer_id, broker_id, permitir_inativo_vencido, status } = req.body;

  const newPolicy: Policy = {
    id: `pol_${ramo.toLowerCase()}_${Date.now()}`,
    numero_apolice,
    ramo,
    tenant_id,
    insurer_id,
    broker_id,
    status: status || 'ATIVA',
    permitir_inativo_vencido: Boolean(permitir_inativo_vencido),
    vigencia_inicio: new Date().toISOString(),
    vigencia_fim: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
  };

  dbStore.policies.unshift(newPolicy);
  dbStore.persist();
  return res.json({ status: 'sucesso', policy: newPolicy });
});

router.put('/policies/:id', (req, res) => {
  const { id } = req.params;
  const policy = dbStore.policies.find((p) => p.id === id);

  if (!policy) {
    return res.status(404).json({ status: 'erro', mensagem: 'Apólice não localizada.' });
  }

  const { status, permitir_inativo_vencido } = req.body;
  if (status !== undefined) policy.status = status;
  if (permitir_inativo_vencido !== undefined) policy.permitir_inativo_vencido = Boolean(permitir_inativo_vencido);

  dbStore.persist();
  return res.json({ status: 'sucesso', policy });
});

// Regras da Apólice
router.get('/policy-rules', (req, res) => res.json({ status: 'sucesso', rules: dbStore.policyRules }));

router.post('/policy-rules', (req, res) => {
  const { policy_id, tipo_doc, tag_path, nome_variavel, obrigatoria, instrucao_recuperacao } = req.body;

  const newRule: PolicyRule = {
    id: uuidv4(),
    policy_id,
    tipo_doc: tipo_doc || 'TODOS',
    tag_path,
    nome_variavel,
    obrigatoria: obrigatoria !== undefined ? Boolean(obrigatoria) : true,
    instrucao_recuperacao
  };

  dbStore.policyRules.push(newRule);
  dbStore.persist();
  return res.json({ status: 'sucesso', rule: newRule });
});

router.delete('/policy-rules/:id', (req, res) => {
  const { id } = req.params;
  dbStore.policyRules = dbStore.policyRules.filter((r) => r.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Regra removida com sucesso.' });
});

// --- 4. GESTÃO DE TEXTOS DE RETORNO EDITÁVEIS (response_templates) ---
router.get('/templates', (req, res) => {
  return res.json({ status: 'sucesso', templates: dbStore.responseTemplates });
});

router.put('/templates/:id', (req, res) => {
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

// --- 5. GERADOR MOCK DE DOCUMENTOS FICTÍCIOS (Apenas Clientes 'teste') ---
router.post('/mock/generate', (req, res) => {
  const { tenant_id, tipo_doc } = req.body;

  try {
    const xmlContent = MockGeneratorService.generateMockXML(tenant_id, tipo_doc || 'CTE');
    return res.json({ status: 'sucesso', xml_content: xmlContent });
  } catch (err: any) {
    return res.status(400).json({ status: 'erro', mensagem: err.message });
  }
});

// --- 6. SIMULADOR DE CARGA EM LOTE MULTI-CLIENTE ---
router.post('/simulador/executar', async (req, res) => {
  try {
    const batchRun = await BatchRunnerService.executeBatch(req.body);
    return res.json({ status: 'sucesso', batchRun });
  } catch (err: any) {
    return res.status(400).json({ status: 'erro', mensagem: err.message });
  }
});

router.get('/simulador/historico', (req, res) => {
  return res.json({ status: 'sucesso', historico: dbStore.batchTestRuns });
});

// --- 7. EXPURGO AUTOMÁTICO DE DADOS DE TESTE ---
router.post('/expurgo', (req, res) => {
  const { dias } = req.body;
  const result = PurgeService.purgeTestData(Number(dias || 30));
  return res.json({ status: 'sucesso', result });
});

// Dashboard Analytics
router.get('/dashboard-stats', (req, res) => {
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

export default router;
