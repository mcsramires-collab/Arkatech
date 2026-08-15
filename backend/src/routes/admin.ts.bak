import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { dbStore } from '../services/dbStore';
import { ResponseTemplate, Tenant, Policy, PolicyRule, DocumentRule, TipoDocumento, InsurerCoverage, RbacProfile, TenantUser } from '../types';
import { MockGeneratorService } from '../services/mockGenerator';
import { BatchRunnerService } from '../services/batchRunner';
import { PurgeService } from '../services/purgeService';
import { AverbacaoService } from '../services/averbacao';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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

// --- 3. GESTÃO DE APÓLICES (CRUD completo: criar, editar, excluir) ---
router.get('/policies', (req, res) => res.json({ status: 'sucesso', policies: dbStore.policies }));

router.post('/policies', (req, res) => {
  const { numero_apolice, ramo, tenant_id, insurer_id, broker_id, permitir_inativo_vencido, status, vigencia_inicio, vigencia_fim } = req.body;

  if (!numero_apolice || !ramo || !tenant_id || !insurer_id || !broker_id) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'numero_apolice, ramo, tenant_id, insurer_id e broker_id são obrigatórios.'
    });
  }

  const newPolicy: Policy = {
    id: `pol_${ramo.toLowerCase()}_${Date.now()}`,
    numero_apolice,
    ramo,
    tenant_id,
    insurer_id,
    broker_id,
    status: status || 'ATIVA',
    permitir_inativo_vencido: Boolean(permitir_inativo_vencido),
    vigencia_inicio: vigencia_inicio || new Date().toISOString(),
    vigencia_fim: vigencia_fim || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
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

  const { status, permitir_inativo_vencido, numero_apolice, ramo, insurer_id, broker_id, vigencia_inicio, vigencia_fim } = req.body;
  if (status !== undefined) policy.status = status;
  if (permitir_inativo_vencido !== undefined) policy.permitir_inativo_vencido = Boolean(permitir_inativo_vencido);
  if (numero_apolice !== undefined) policy.numero_apolice = numero_apolice;
  if (ramo !== undefined) policy.ramo = ramo;
  if (insurer_id !== undefined) policy.insurer_id = insurer_id;
  if (broker_id !== undefined) policy.broker_id = broker_id;
  if (vigencia_inicio !== undefined) policy.vigencia_inicio = vigencia_inicio;
  if (vigencia_fim !== undefined) policy.vigencia_fim = vigencia_fim;

  dbStore.persist();
  return res.json({ status: 'sucesso', policy });
});

router.delete('/policies/:id', (req, res) => {
  const { id } = req.params;
  const exists = dbStore.policies.some((p) => p.id === id);
  if (!exists) {
    return res.status(404).json({ status: 'erro', mensagem: 'Apólice não localizada.' });
  }
  dbStore.policies = dbStore.policies.filter((p) => p.id !== id);
  // Remove também as variáveis (policyRules) atreladas a essa apólice
  dbStore.policyRules = dbStore.policyRules.filter((r) => r.policy_id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Apólice removida com sucesso.' });
});

// --- 4. VARIÁVEIS DE NEGÓCIO DA APÓLICE (PolicyRule) — CRUD completo ---
router.get('/policy-rules', (req, res) => res.json({ status: 'sucesso', rules: dbStore.policyRules }));

router.post('/policy-rules', (req, res) => {
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

router.put('/policy-rules/:id', (req, res) => {
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

router.delete('/policy-rules/:id', (req, res) => {
  const { id } = req.params;
  dbStore.policyRules = dbStore.policyRules.filter((r) => r.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Variável removida com sucesso.' });
});

// --- 5. REGRAS DE OBRIGATORIEDADE POR TIPO DE DOCUMENTO (DocumentRule — padrão Sefaz) ---
router.get('/document-rules', (req, res) => {
  const { tipo_documento } = req.query;
  let items = dbStore.documentRules;
  if (tipo_documento) {
    items = items.filter((r) => r.tipo_documento === (tipo_documento as string));
  }
  return res.json({ status: 'sucesso', rules: items });
});

router.post('/document-rules', (req, res) => {
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

router.put('/document-rules/:id', (req, res) => {
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

router.delete('/document-rules/:id', (req, res) => {
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

// --- 7. GERADOR MOCK DE DOCUMENTOS FICTÍCIOS (Apenas Clientes 'teste') ---
router.post('/mock/generate', (req, res) => {
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
router.post('/importar-lote', upload.array('arquivos', 200), async (req, res) => {
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

// --- 10. EXPURGO AUTOMÁTICO DE DADOS DE TESTE ---
router.post('/expurgo', (req, res) => {
  const { dias } = req.body;
  const result = PurgeService.purgeTestData(Number(dias || 30));
  return res.json({ status: 'sucesso', result });
});

// --- 11. RELATÓRIO POR CLIENTE OU CONJUNTO DE CLIENTES ---
router.get('/relatorio', (req, res) => {
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
router.get('/docs', (req, res) => {
  try {
    const docPath = path.join(__dirname, '../../docs/API_DOCUMENTATION.md');
    const content = fs.readFileSync(docPath, 'utf-8');
    return res.json({ status: 'sucesso', content });
  } catch (err: any) {
    return res.status(500).json({ status: 'erro', mensagem: 'Documentação não encontrada no servidor.' });
  }
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

// --- B. Cadastro de Cliente pela Seguradora (cria tenant + apólice, ou detecta conflito) ---
router.post('/insurer-clients', (req, res) => {
  const {
    insurer_id,
    broker_id,
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
    contato_celular
  } = req.body;

  if (!insurer_id || !broker_id || !cnpj || !razao_social || !ramo || !numero_apolice) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'insurer_id, broker_id, cnpj, razao_social, ramo e numero_apolice são obrigatórios.'
    });
  }

  const cnpjLimpo = String(cnpj).replace(/\D/g, '');
  let tenant = dbStore.tenants.find((t) => t.cnpj.replace(/\D/g, '') === cnpjLimpo);

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
      conta_ativada: false
    };
    dbStore.tenants.push(tenant);

    // Dispara token de ativação (Termo de Uso) — aceite ainda pendente
    dbStore.activationTokens.push({
      id: uuidv4(),
      tenant_id: tenant.id,
      token: `act_${uuidv4()}`,
      termo_versao: 'v1',
      aceite: false,
      expira_em: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      created_at: new Date().toISOString()
    });
  }

  const newPolicy: Policy = {
    id: `pol_${String(ramo).toLowerCase()}_${Date.now()}`,
    numero_apolice,
    ramo,
    tenant_id: tenant.id,
    insurer_id,
    broker_id,
    status: 'ATIVA',
    permitir_inativo_vencido: Boolean(permitir_inativo_vencido),
    vigencia_inicio: vigencia_inicio || new Date().toISOString(),
    vigencia_fim: vigencia_fim || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    lmi: lmi !== undefined ? Number(lmi) : undefined,
    aceita_averbacao_como_destinatario: Boolean(aceita_averbacao_como_destinatario)
  };
  dbStore.policies.push(newPolicy);
  dbStore.persist();

  return res.json({ status: 'sucesso', tenant, policy: newPolicy });
});

// --- C. Assumir Apólice em Conflito ---
router.post('/insurer-clients/:tenantId/assume-policy', (req, res) => {
  const { tenantId } = req.params;
  const { insurer_id, broker_id, ramo, numero_apolice, lmi, vigencia_inicio, vigencia_fim, permitir_inativo_vencido, aceita_averbacao_como_destinatario } =
    req.body;

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
router.get('/insurer-coverages', (req, res) => {
  const { insurer_id } = req.query;
  let items = dbStore.insurerCoverages;
  if (insurer_id) items = items.filter((c) => c.insurer_id === insurer_id);
  return res.json({ status: 'sucesso', coverages: items });
});

router.post('/insurer-coverages', (req, res) => {
  const { insurer_id, ramo, titulo, exemplo_preenchimento, obrigatoria, aplicar_todos_clientes, tenant_id, tipo_valor } = req.body;

  if (!insurer_id || !titulo) {
    return res.status(400).json({ status: 'erro', mensagem: 'insurer_id e titulo são obrigatórios.' });
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

router.put('/insurer-coverages/:id', (req, res) => {
  const { id } = req.params;
  const coverage = dbStore.insurerCoverages.find((c) => c.id === id);
  if (!coverage) {
    return res.status(404).json({ status: 'erro', mensagem: 'Cobertura adicional não encontrada.' });
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

router.delete('/insurer-coverages/:id', (req, res) => {
  const { id } = req.params;
  dbStore.insurerCoverages = dbStore.insurerCoverages.filter((c) => c.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Cobertura adicional removida com sucesso.' });
});

// --- E. Manutenção em Massa de Apólices ---
router.post('/policies/bulk-update', (req, res) => {
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
router.get('/rbac-profiles', (req, res) => {
  const { owner_type, owner_id } = req.query;
  let items = dbStore.rbacProfiles;
  if (owner_type) items = items.filter((p) => p.owner_type === owner_type);
  if (owner_id) items = items.filter((p) => p.owner_id === owner_id);
  return res.json({ status: 'sucesso', profiles: items });
});

router.post('/rbac-profiles', (req, res) => {
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

router.put('/rbac-profiles/:id', (req, res) => {
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

router.delete('/rbac-profiles/:id', (req, res) => {
  const { id } = req.params;
  dbStore.rbacProfiles = dbStore.rbacProfiles.filter((p) => p.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Perfil de acesso removido com sucesso.' });
});

// --- G. Usuários Internos do Tenant (seguradora/corretora/transportador) ---
router.get('/tenant-users', (req, res) => {
  const { tenant_id } = req.query;
  let items = dbStore.tenantUsers;
  if (tenant_id) items = items.filter((u) => u.tenant_id === tenant_id);
  return res.json({ status: 'sucesso', users: items });
});

router.post('/tenant-users', (req, res) => {
  const { tenant_id, nome, email, rbac_profile_id, is_admin_da_conta } = req.body;
  if (!tenant_id || !nome || !email) {
    return res.status(400).json({ status: 'erro', mensagem: 'tenant_id, nome e email são obrigatórios.' });
  }

  const newUser: TenantUser = {
    id: uuidv4(),
    tenant_id,
    nome,
    email,
    password_hash: `hash_${uuidv4()}`,
    rbac_profile_id,
    is_admin_da_conta: Boolean(is_admin_da_conta),
    status: 'ATIVO',
    created_at: new Date().toISOString()
  };
  dbStore.tenantUsers.push(newUser);
  dbStore.persist();
  return res.json({ status: 'sucesso', user: newUser });
});

router.put('/tenant-users/:id', (req, res) => {
  const { id } = req.params;
  const user = dbStore.tenantUsers.find((u) => u.id === id);
  if (!user) {
    return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado.' });
  }
  const { nome, email, rbac_profile_id, status } = req.body;
  if (nome !== undefined) user.nome = nome;
  if (email !== undefined) user.email = email;
  if (rbac_profile_id !== undefined) user.rbac_profile_id = rbac_profile_id;
  if (status !== undefined) user.status = status;
  dbStore.persist();
  return res.json({ status: 'sucesso', user });
});

router.delete('/tenant-users/:id', (req, res) => {
  const { id } = req.params;
  dbStore.tenantUsers = dbStore.tenantUsers.filter((u) => u.id !== id);
  dbStore.persist();
  return res.json({ status: 'sucesso', mensagem: 'Usuário removido com sucesso.' });
});

// --- H. Delegação de Poder Seguradora → Corretora ---
router.get('/delegation-permissions', (req, res) => {
  const { insurer_id, broker_id } = req.query;
  let items = dbStore.delegationPermissions;
  if (insurer_id) items = items.filter((d) => d.insurer_id === insurer_id);
  if (broker_id) items = items.filter((d) => d.broker_id === broker_id);
  return res.json({ status: 'sucesso', permissions: items });
});

router.put('/delegation-permissions', (req, res) => {
  const { insurer_id, broker_id, actions } = req.body;
  if (!insurer_id || !broker_id || !Array.isArray(actions)) {
    return res.status(400).json({
      status: 'erro',
      mensagem: 'insurer_id, broker_id e actions (lista de { action, requires_approval }) são obrigatórios.'
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

// --- I. Fila de Aprovação (ações da corretora sujeitas a requires_approval) ---
router.get('/approval-requests', (req, res) => {
  const { insurer_id, status } = req.query;
  let items = dbStore.approvalRequests;
  if (insurer_id) items = items.filter((a) => a.insurer_id === insurer_id);
  if (status) items = items.filter((a) => a.status === status);
  return res.json({ status: 'sucesso', requests: items });
});

router.post('/approval-requests/:id/resolve', (req, res) => {
  const { id } = req.params;
  const { status, resolved_by } = req.body;

  const request = dbStore.approvalRequests.find((a) => a.id === id);
  if (!request) {
    return res.status(404).json({ status: 'erro', mensagem: 'Solicitação de aprovação não encontrada.' });
  }
  if (status !== 'APROVADO' && status !== 'REJEITADO') {
    return res.status(400).json({ status: 'erro', mensagem: "status deve ser 'APROVADO' ou 'REJEITADO'." });
  }

  request.status = status;
  request.resolved_at = new Date().toISOString();
  request.resolved_by = resolved_by;

  dbStore.persist();
  return res.json({ status: 'sucesso', request });
});

export default router;
