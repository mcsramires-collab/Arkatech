import React, { useState, useEffect } from 'react';
import {
  ShieldCheck,
  Users,
  FileText,
  Settings,
  Zap,
  Layers,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Play,
  RotateCcw,
  RefreshCw,
  Plus,
  Edit3,
  Trash2,
  ExternalLink,
  Lock,
  Globe,
  Download,
  Upload,
  BarChart3,
  BookOpen,
  ListChecks
} from 'lucide-react';
import { ApiClient } from './services/api';
import { Tenant, Policy, PolicyRule, DocumentRule, ResponseTemplate, BatchTestRun, Insurer, Broker, TipoDocumento } from './types';

export function App() {
  const [activeTab, setActiveTab] = useState<
    | 'dashboard'
    | 'tenants'
    | 'policies'
    | 'documentrules'
    | 'templates'
    | 'emitter'
    | 'import'
    | 'simulator'
    | 'report'
    | 'apidocs'
    | 'recovery'
  >('dashboard');

  // Recovery link token state check (url query or hash)
  const [recoveryTokenInput, setRecoveryTokenInput] = useState('');
  const [recoveryData, setRecoveryData] = useState<any>(null);
  const [recoveryFormVars, setRecoveryFormVars] = useState<Record<string, string>>({});
  const [recoveryMessage, setRecoveryMessage] = useState<any>(null);

  // Stats & Data States
  const [stats, setStats] = useState<any>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [templates, setTemplates] = useState<ResponseTemplate[]>([]);
  const [documentRules, setDocumentRules] = useState<DocumentRule[]>([]);
  const [insurers, setInsurers] = useState<Insurer[]>([]);
  const [brokers, setBrokers] = useState<Broker[]>([]);

  // Selected State Filters
  const [selectedTenantId, setSelectedTenantId] = useState<string>('');

  // Form States
  const [newTenant, setNewTenant] = useState({
    cnpj: '',
    razao_social: '',
    ambiente: 'teste',
    role: 'TRANSPORTADOR',
    token_duration_hours: 8
  });

  const [newRule, setNewRule] = useState({
    policy_id: '',
    tipo_doc: 'CTE',
    tag_path: '',
    nome_variavel: '',
    obrigatoria: true,
    exemplo_preenchimento: '',
    instrucao_recuperacao: ''
  });

  // Nova Apólice
  const [newPolicy, setNewPolicy] = useState({
    numero_apolice: '',
    ramo: 'RCTRC',
    tenant_id: '',
    insurer_id: '',
    broker_id: '',
    permitir_inativo_vencido: false
  });

  // Nova Regra de Documento (Sefaz)
  const [newDocRule, setNewDocRule] = useState({
    tipo_documento: 'CTE' as TipoDocumento,
    tag_path: '',
    nome_variavel: '',
    obrigatoria: true,
    observacao: ''
  });
  const [docRuleFilter, setDocRuleFilter] = useState<TipoDocumento>('CTE');

  // Importação em Lote
  const [importTenantId, setImportTenantId] = useState('');
  const [importRamo, setImportRamo] = useState('RCTRC');
  const [importFiles, setImportFiles] = useState<FileList | null>(null);
  const [importResult, setImportResult] = useState<any>(null);
  const [importLoading, setImportLoading] = useState(false);

  // Relatório
  const [selectedReportTenants, setSelectedReportTenants] = useState<Record<string, boolean>>({});
  const [reportData, setReportData] = useState<any>(null);
  const [reportLoading, setReportLoading] = useState(false);

  // Documentação da API
  const [apiDocsContent, setApiDocsContent] = useState<string>('');
  const [apiDocsLoading, setApiDocsLoading] = useState(false);

  // Emitter State
  const [emitterTenantId, setEmitterTenantId] = useState('');
  const [emitterRamo, setEmitterRamo] = useState('RCTRC');
  const [emitterTipoDoc, setEmitterTipoDoc] = useState<TipoDocumento>('CTE');
  const [emitterPolicyId, setEmitterPolicyId] = useState('');
  const [emitterIncluirVars, setEmitterIncluirVars] = useState(false);
  const [emitterXml, setEmitterXml] = useState('');
  const [emitterResult, setEmitterResult] = useState<any>(null);
  const [generatedToken, setGeneratedToken] = useState<string>('');

  // Simulator State
  const [simDistribuicao, setSimDistribuicao] = useState<'ROUND_ROBIN' | 'CUSTOM'>('ROUND_ROBIN');
  const [simTotalDocs, setSimTotalDocs] = useState<number>(100);
  const [selectedSimTenants, setSelectedSimTenants] = useState<Record<string, boolean>>({});
  const [customTenantCounts, setCustomTenantCounts] = useState<Record<string, number>>({});
  const [simResult, setSimResult] = useState<BatchTestRun | null>(null);
  const [simLoading, setSimLoading] = useState(false);

  // Template Edit State
  const [editingTemplate, setEditingTemplate] = useState<ResponseTemplate | null>(null);
  const [customText, setCustomText] = useState('');

  // Auto Load
  useEffect(() => {
    loadData();

    // Direct url check for /recuperar/token
    const path = window.location.pathname;
    if (path.includes('/recuperar/')) {
      const tok = path.split('/recuperar/')[1];
      if (tok) {
        setRecoveryTokenInput(tok);
        setActiveTab('recovery');
        fetchRecoveryInfo(tok);
      }
    }
  }, []);

  const loadData = async () => {
    const s = await ApiClient.getDashboardStats();
    if (s.status === 'sucesso') setStats(s.stats);

    const t = await ApiClient.getTenants();
    if (t.status === 'sucesso') {
      setTenants(t.tenants);
      if (t.tenants.length > 0 && !selectedTenantId) {
        setSelectedTenantId(t.tenants[0].id);
        setEmitterTenantId(t.tenants[0].id);
      }
    }

    const p = await ApiClient.getPolicies();
    if (p.status === 'sucesso') setPolicies(p.policies);

    const r = await ApiClient.getPolicyRules();
    if (r.status === 'sucesso') setRules(r.rules);

    const tmpl = await ApiClient.getTemplates();
    if (tmpl.status === 'sucesso') setTemplates(tmpl.templates);

    const docRules = await ApiClient.getDocumentRules();
    if (docRules.status === 'sucesso') setDocumentRules(docRules.rules);

    const ins = await ApiClient.getInsurers();
    if (ins.status === 'sucesso') setInsurers(ins.insurers);

    const brk = await ApiClient.getBrokers();
    if (brk.status === 'sucesso') setBrokers(brk.brokers);
  };

  // Create Tenant
  const handleCreateTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await ApiClient.createTenant(newTenant);
    if (res.status === 'sucesso') {
      alert('Cliente cadastrado com sucesso!');
      setNewTenant({ cnpj: '', razao_social: '', ambiente: 'teste', role: 'TRANSPORTADOR', token_duration_hours: 8 });
      loadData();
    } else {
      alert(res.mensagem);
    }
  };

  // Toggle Tenant Environment
  const handleToggleEnvironment = async (tenant: Tenant) => {
    const nextEnv = tenant.ambiente === 'teste' ? 'producao' : 'teste';
    const res = await ApiClient.updateTenant(tenant.id, { ambiente: nextEnv });
    if (res.status === 'sucesso') {
      loadData();
    }
  };

  // Toggle Policy Flag
  const handleTogglePolicyBypass = async (policy: Policy) => {
    const res = await ApiClient.updatePolicy(policy.id, {
      permitir_inativo_vencido: !policy.permitir_inativo_vencido
    });
    if (res.status === 'sucesso') {
      loadData();
    }
  };

  // Create Policy
  const handleCreatePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPolicy.numero_apolice || !newPolicy.tenant_id || !newPolicy.insurer_id || !newPolicy.broker_id) {
      alert('Preencha número da apólice, cliente, seguradora e corretora.');
      return;
    }
    const res = await ApiClient.createPolicy(newPolicy);
    if (res.status === 'sucesso') {
      setNewPolicy({ numero_apolice: '', ramo: 'RCTRC', tenant_id: '', insurer_id: '', broker_id: '', permitir_inativo_vencido: false });
      loadData();
    } else {
      alert(res.mensagem);
    }
  };

  const handleDeletePolicy = async (id: string) => {
    if (confirm('Deseja realmente excluir esta apólice? As variáveis vinculadas a ela também serão removidas.')) {
      await ApiClient.deletePolicy(id);
      loadData();
    }
  };

  // Document Rules (Sefaz)
  const handleCreateDocRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDocRule.tag_path || !newDocRule.nome_variavel) {
      alert('Informe a tag/caminho e o nome da variável.');
      return;
    }
    const res = await ApiClient.createDocumentRule(newDocRule);
    if (res.status === 'sucesso') {
      setNewDocRule({ tipo_documento: docRuleFilter, tag_path: '', nome_variavel: '', obrigatoria: true, observacao: '' });
      loadData();
    } else {
      alert(res.mensagem);
    }
  };

  const handleToggleDocRuleObrigatoria = async (rule: DocumentRule) => {
    await ApiClient.updateDocumentRule(rule.id, { obrigatoria: !rule.obrigatoria });
    loadData();
  };

  const handleDeleteDocRule = async (id: string) => {
    if (confirm('Deseja remover esta regra de documento? Ela deixará de ser exigida em todos os documentos desse tipo.')) {
      await ApiClient.deleteDocumentRule(id);
      loadData();
    }
  };


  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRule.policy_id || !newRule.nome_variavel) {
      alert('Selecione uma apólice e informe o nome da variável.');
      return;
    }
    const res = await ApiClient.createPolicyRule(newRule);
    if (res.status === 'sucesso') {
      setNewRule({ policy_id: '', tipo_doc: 'CTE', tag_path: '', nome_variavel: '', obrigatoria: true, exemplo_preenchimento: '', instrucao_recuperacao: '' });
      loadData();
    }
  };

  // Delete Rule
  const handleDeleteRule = async (id: string) => {
    if (confirm('Deseja remover esta regra?')) {
      await ApiClient.deletePolicyRule(id);
      loadData();
    }
  };

  // Save Response Template
  const handleSaveTemplate = async () => {
    if (!editingTemplate) return;
    const res = await ApiClient.updateTemplate(editingTemplate.id, customText);
    if (res.status === 'sucesso') {
      setEditingTemplate(null);
      loadData();
    }
  };

  // Generate Mock & Token in Emitter
  const handleGenerateMockInEmitter = async () => {
    if (!emitterTenantId) return;
    const res = await ApiClient.generateMock({
      tenant_id: emitterTenantId,
      tipo_doc: emitterTipoDoc,
      policy_id: emitterPolicyId || undefined,
      incluir_variaveis_apolice: emitterIncluirVars
    });
    if (res.status === 'sucesso') {
      setEmitterXml(res.xml_content);
    } else {
      alert(res.mensagem);
    }
  };

  // Download do XML gerado/carregado no Emissor
  const handleDownloadXml = () => {
    if (!emitterXml) {
      alert('Gere ou cole um XML antes de baixar.');
      return;
    }
    const blob = new Blob([emitterXml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `arckatech_${emitterTipoDoc.toLowerCase()}_${Date.now()}.xml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Importação em Lote de XMLs
  const handleImportLote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!importTenantId || !importFiles || importFiles.length === 0) {
      alert('Selecione um cliente e ao menos um arquivo XML.');
      return;
    }
    setImportLoading(true);
    setImportResult(null);
    const res = await ApiClient.importarLote(importTenantId, importRamo, importFiles);
    setImportResult(res);
    setImportLoading(false);
    loadData();
  };

  // Relatório por Cliente
  const handleGerarRelatorio = async () => {
    setReportLoading(true);
    const ids = Object.keys(selectedReportTenants).filter((id) => selectedReportTenants[id]);
    const res = await ApiClient.getRelatorio(ids);
    if (res.status === 'sucesso') {
      setReportData(res);
    } else {
      alert(res.mensagem);
    }
    setReportLoading(false);
  };

  // Documentação da API
  const handleLoadApiDocs = async () => {
    if (apiDocsContent) return;
    setApiDocsLoading(true);
    const res = await ApiClient.getApiDocs();
    if (res.status === 'sucesso') setApiDocsContent(res.content);
    setApiDocsLoading(false);
  };

  const handleGenerateTokenInEmitter = async () => {
    const tenant = tenants.find((t) => t.id === emitterTenantId);
    if (!tenant) return;
    const res = await ApiClient.getToken(tenant.client_id, tenant.client_secret_hash);
    if (res.status === 'sucesso') {
      setGeneratedToken(res.access_token);
    }
  };

  const handleSubmitAverbacaoInEmitter = async () => {
    if (!generatedToken) {
      alert('Gere primeiro o Token de Autenticação para o cliente selecionado.');
      return;
    }
    const res = await ApiClient.averbarDocumento(generatedToken, emitterRamo, emitterXml);
    setEmitterResult(res);
    loadData();
  };

  // Batch Simulator Execution
  const handleRunSimulation = async () => {
    setSimLoading(true);
    setSimResult(null);

    const testTenants = tenants.filter((t) => t.ambiente === 'teste');
    const selectedIds = Object.keys(selectedSimTenants).filter((id) => selectedSimTenants[id]);

    if (selectedIds.length === 0) {
      alert('Selecione ao menos um cliente do ambiente de teste para a simulação.');
      setSimLoading(false);
      return;
    }

    const configs = selectedIds.map((id) => ({
      tenant_id: id,
      quantidade: customTenantCounts[id] || 10
    }));

    const payload = {
      distribuicao: simDistribuicao,
      total_docs: simTotalDocs,
      configuracao_clientes: configs,
      ramo: 'RCTRC'
    };

    const res = await ApiClient.executeBatchSimulation(payload);
    if (res.status === 'sucesso') {
      setSimResult(res.batchRun);
    } else {
      alert(res.mensagem);
    }
    setSimLoading(false);
    loadData();
  };

  // Fetch Recovery Info
  const fetchRecoveryInfo = async (token: string) => {
    const res = await ApiClient.getRecoverySession(token);
    if (res.status === 'sucesso') {
      setRecoveryData(res);
    } else {
      setRecoveryData(null);
      alert(res.mensagem);
    }
  };

  const handleSubmitRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await ApiClient.submitRecovery(recoveryTokenInput, recoveryFormVars);
    setRecoveryMessage(res);
    loadData();
  };

  return (
    <div className="app-layout">
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">
            <ShieldCheck size={26} />
          </div>
          <div>
            <div className="brand-title">ARCKATECH</div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Seguros de Carga</div>
          </div>
        </div>

        <nav>
          <ul className="nav-menu">
            <li>
              <button
                className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
                onClick={() => setActiveTab('dashboard')}
              >
                <Layers size={18} /> Painel Geral
              </button>
            </li>
            <li>
              <button
                className={`nav-item ${activeTab === 'tenants' ? 'active' : ''}`}
                onClick={() => setActiveTab('tenants')}
              >
                <Users size={18} /> Clientes & Perfis
              </button>
            </li>
            <li>
              <button
                className={`nav-item ${activeTab === 'policies' ? 'active' : ''}`}
                onClick={() => setActiveTab('policies')}
              >
                <FileText size={18} /> Apólices & Regras
              </button>
            </li>
            <li>
              <button
                className={`nav-item ${activeTab === 'documentrules' ? 'active' : ''}`}
                onClick={() => setActiveTab('documentrules')}
              >
                <ListChecks size={18} /> Regras por Documento
              </button>
            </li>
            <li>
              <button
                className={`nav-item ${activeTab === 'templates' ? 'active' : ''}`}
                onClick={() => setActiveTab('templates')}
              >
                <Settings size={18} /> Textos de Retorno
              </button>
            </li>
            <li>
              <button
                className={`nav-item ${activeTab === 'emitter' ? 'active' : ''}`}
                onClick={() => setActiveTab('emitter')}
              >
                <Zap size={18} /> Emissor & MOCK
              </button>
            </li>
            <li>
              <button
                className={`nav-item ${activeTab === 'import' ? 'active' : ''}`}
                onClick={() => setActiveTab('import')}
              >
                <Upload size={18} /> Importação em Lote
              </button>
            </li>
            <li>
              <button
                className={`nav-item ${activeTab === 'simulator' ? 'active' : ''}`}
                onClick={() => setActiveTab('simulator')}
              >
                <Play size={18} /> Simulador Multi-Cliente
              </button>
            </li>
            <li>
              <button
                className={`nav-item ${activeTab === 'report' ? 'active' : ''}`}
                onClick={() => setActiveTab('report')}
              >
                <BarChart3 size={18} /> Relatórios
              </button>
            </li>
            <li>
              <button
                className={`nav-item ${activeTab === 'apidocs' ? 'active' : ''}`}
                onClick={() => {
                  setActiveTab('apidocs');
                  handleLoadApiDocs();
                }}
              >
                <BookOpen size={18} /> Documentação API
              </button>
            </li>
            <li>
              <button
                className={`nav-item ${activeTab === 'recovery' ? 'active' : ''}`}
                onClick={() => setActiveTab('recovery')}
              >
                <ExternalLink size={18} /> Link de Recuperação
              </button>
            </li>
          </ul>
        </nav>
      </aside>

      {/* Main Content Area */}
      <main className="main-content">
        <header className="top-bar">
          <div>
            <h1 className="page-title">Plataforma de Averbação ARCKATECH</h1>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              Motor de Averbação Sefaz (RCTRC, RCDC, RCV) & Gestão de Regras
            </p>
          </div>
          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <span className="env-badge teste">
              <Globe size={14} /> AMBIENTE TESTE
            </span>
            <span className="env-badge producao">
              <Lock size={14} /> AMBIENTE PRODUÇÃO
            </span>
          </div>
        </header>

        {/* TAB 1: DASHBOARD */}
        {activeTab === 'dashboard' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="grid-stats">
              <div className="card-stat">
                <span className="stat-label">Total de Clientes</span>
                <span className="stat-value">{stats?.totalClientes || 0}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {stats?.clientesTeste || 0} em Teste | {stats?.clientesProd || 0} em Produção
                </span>
              </div>
              <div className="card-stat">
                <span className="stat-label">Total de Averbações</span>
                <span className="stat-value">{stats?.totalAverbacoes || 0}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {stats?.averbacoesProd || 0} Reais | {stats?.averbacoesTeste || 0} Simuladas
                </span>
              </div>
              <div className="card-stat">
                <span className="stat-label">Apólices Cadastradas</span>
                <span className="stat-value">{stats?.totalApolices || 0}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>RCTRC, RCDC e RCV</span>
              </div>
              <div className="card-stat">
                <span className="stat-label">Segurança & LGPD</span>
                <span className="stat-value" style={{ color: 'var(--accent-emerald)', fontSize: '1.4rem' }}>
                  ISO 27001
                </span>
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Criptografia AES-256 + SHA-256</span>
              </div>
            </div>

            <div className="table-container" style={{ padding: '24px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', marginBottom: '16px' }}>
                Resumo dos Clientes Cadastrados
              </h2>
              <table className="custom-table">
                <thead>
                  <tr>
                    <th>Razão Social / CNPJ</th>
                    <th>Perfil</th>
                    <th>Ambiente</th>
                    <th>Status</th>
                    <th>Duração Token</th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <strong>{t.razao_social}</strong>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>CNPJ: {t.cnpj}</div>
                      </td>
                      <td>
                        <span className="badge badge-info">{t.role}</span>
                      </td>
                      <td>
                        <span className={`env-badge ${t.ambiente}`}>{t.ambiente}</span>
                      </td>
                      <td>
                        {t.status === 'ATIVO' ? (
                          <span className="badge badge-success">ATIVO</span>
                        ) : (
                          <span className="badge badge-error">INATIVO</span>
                        )}
                      </td>
                      <td>{t.token_duration_hours} horas</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 2: CLIENTES & PERFIS */}
        {activeTab === 'tenants' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Form Cadastro */}
            <div className="table-container" style={{ padding: '24px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', marginBottom: '16px' }}>
                Novo Cadastro de Cliente / Tenant
              </h2>
              <form onSubmit={handleCreateTenant} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '16px' }}>
                <div className="form-group">
                  <label className="form-label">Razão Social</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="Empresa Ltda"
                    value={newTenant.razao_social}
                    onChange={(e) => setNewTenant({ ...newTenant, razao_social: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">CNPJ</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="00.000.000/0001-00"
                    value={newTenant.cnpj}
                    onChange={(e) => setNewTenant({ ...newTenant, cnpj: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Ambiente de Operação</label>
                  <select
                    className="form-select"
                    value={newTenant.ambiente}
                    onChange={(e) => setNewTenant({ ...newTenant, ambiente: e.target.value as any })}
                  >
                    <option value="teste">Teste (Simulações & Mock)</option>
                    <option value="producao">Produção (Operação Real)</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Perfil / Função</label>
                  <select
                    className="form-select"
                    value={newTenant.role}
                    onChange={(e) => setNewTenant({ ...newTenant, role: e.target.value })}
                  >
                    <option value="TRANSPORTADOR">Transportador / Embarcador</option>
                    <option value="SEGURADORA">Seguradora</option>
                    <option value="CORRETORA">Corretora</option>
                    <option value="ADMIN">Administrador ARCKATECH</option>
                  </select>
                </div>
                <div style={{ gridColumn: 'span 4', display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="btn btn-primary">
                    <Plus size={16} /> Cadastrar Cliente
                  </button>
                </div>
              </form>
            </div>

            {/* Listagem com Alteração de Ambiente */}
            <div className="table-container">
              <table className="custom-table">
                <thead>
                  <tr>
                    <th>Cliente / CNPJ</th>
                    <th>Ambiente Atual</th>
                    <th>Status</th>
                    <th>Client ID & Secrets</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <strong>{t.razao_social}</strong>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t.cnpj}</div>
                      </td>
                      <td>
                        <span className={`env-badge ${t.ambiente}`}>{t.ambiente}</span>
                      </td>
                      <td>
                        {t.status === 'ATIVO' ? (
                          <span className="badge badge-success">ATIVO</span>
                        ) : (
                          <span className="badge badge-error">INATIVO</span>
                        )}
                      </td>
                      <td>
                        <div style={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>ID: {t.client_id}</div>
                        <div style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--text-muted)' }}>Secret: {t.client_secret_hash}</div>
                      </td>
                      <td>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '6px 12px', fontSize: '0.75rem' }}
                          onClick={() => handleToggleEnvironment(t)}
                        >
                          <RotateCcw size={12} /> Alternar para {t.ambiente === 'teste' ? 'Produção' : 'Teste'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 3: APÓLICES & REGRAS */}
        {activeTab === 'policies' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {/* Criar Nova Apólice */}
            <div className="table-container" style={{ padding: '24px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', marginBottom: '16px' }}>
                Cadastrar Nova Apólice
              </h2>
              <form onSubmit={handleCreatePolicy} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
                <div className="form-group">
                  <label className="form-label">Número da Apólice</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="ex: POL-RCTRC-2026-010"
                    value={newPolicy.numero_apolice}
                    onChange={(e) => setNewPolicy({ ...newPolicy, numero_apolice: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Ramo</label>
                  <select
                    className="form-select"
                    value={newPolicy.ramo}
                    onChange={(e) => setNewPolicy({ ...newPolicy, ramo: e.target.value })}
                  >
                    <option value="RCTRC">RCTRC</option>
                    <option value="RCDC">RCDC</option>
                    <option value="RCV">RCV</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Transportador / Embarcador</label>
                  <select
                    className="form-select"
                    value={newPolicy.tenant_id}
                    onChange={(e) => setNewPolicy({ ...newPolicy, tenant_id: e.target.value })}
                  >
                    <option value="">-- Selecione o Cliente --</option>
                    {tenants.map((t) => (
                      <option key={t.id} value={t.id}>{t.razao_social}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Seguradora</label>
                  <select
                    className="form-select"
                    value={newPolicy.insurer_id}
                    onChange={(e) => setNewPolicy({ ...newPolicy, insurer_id: e.target.value })}
                  >
                    <option value="">-- Selecione a Seguradora --</option>
                    {insurers.map((i) => (
                      <option key={i.id} value={i.id}>{i.nome}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Corretora</label>
                  <select
                    className="form-select"
                    value={newPolicy.broker_id}
                    onChange={(e) => setNewPolicy({ ...newPolicy, broker_id: e.target.value })}
                  >
                    <option value="">-- Selecione a Corretora --</option>
                    {brokers.map((b) => (
                      <option key={b.id} value={b.id}>{b.nome}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}>
                    <input
                      type="checkbox"
                      checked={newPolicy.permitir_inativo_vencido}
                      onChange={(e) => setNewPolicy({ ...newPolicy, permitir_inativo_vencido: e.target.checked })}
                    />
                    Permitir averbação com apólice vencida/cliente inativo (SUC-2001)
                  </label>
                </div>
                <div style={{ gridColumn: 'span 3', display: 'flex', justifyContent: 'flex-end' }}>
                  <button type="submit" className="btn btn-primary">
                    <Plus size={16} /> Cadastrar Apólice
                  </button>
                </div>
              </form>
            </div>

            <div className="table-container" style={{ padding: '24px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', marginBottom: '16px' }}>
                Apólices e Exceções de Cadastro
              </h2>
              <table className="custom-table">
                <thead>
                  <tr>
                    <th>Nº Apólice / Ramo</th>
                    <th>Cliente Vinculado</th>
                    <th>Status Apólice</th>
                    <th>Flag Exceção (Inativo/Vencido)</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((p) => {
                    const tenant = tenants.find((t) => t.id === p.tenant_id);
                    return (
                      <tr key={p.id}>
                        <td>
                          <strong>{p.numero_apolice}</strong>
                          <span className="badge badge-info" style={{ marginLeft: '8px' }}>{p.ramo}</span>
                        </td>
                        <td>{tenant?.razao_social || p.tenant_id}</td>
                        <td>
                          <span className={`badge ${p.status === 'ATIVA' ? 'badge-success' : 'badge-error'}`}>
                            {p.status}
                          </span>
                        </td>
                        <td>
                          <button
                            className={`btn ${p.permitir_inativo_vencido ? 'btn-primary' : 'btn-secondary'}`}
                            style={{ padding: '6px 12px', fontSize: '0.75rem' }}
                            onClick={() => handleTogglePolicyBypass(p)}
                          >
                            {p.permitir_inativo_vencido ? 'Permitir (Warning SUC-2001)' : 'Bloquear (Erro)'}
                          </button>
                        </td>
                        <td>
                          <button
                            className="btn btn-danger"
                            style={{ padding: '6px 10px', fontSize: '0.75rem' }}
                            onClick={() => handleDeletePolicy(p.id)}
                          >
                            <Trash2 size={12} /> Excluir
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Builder de Variáveis de Negócio da Apólice */}
            <div className="table-container" style={{ padding: '24px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', marginBottom: '8px' }}>
                Criar Variável de Negócio da Apólice
              </h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                Variáveis específicas exigidas pela seguradora/corretora para aquela cobertura (ex: "Container"). São diferentes das tags padrão Sefaz — veja a aba "Regras por Documento" para essas.
              </p>
              <form onSubmit={handleCreateRule} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: '16px' }}>
                <div className="form-group">
                  <label className="form-label">Selecione a Apólice</label>
                  <select
                    className="form-select"
                    value={newRule.policy_id}
                    onChange={(e) => setNewRule({ ...newRule, policy_id: e.target.value })}
                  >
                    <option value="">-- Escolha uma Apólice --</option>
                    {policies.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.numero_apolice} ({p.ramo})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Tipo Documento</label>
                  <select
                    className="form-select"
                    value={newRule.tipo_doc}
                    onChange={(e) => setNewRule({ ...newRule, tipo_doc: e.target.value as any })}
                  >
                    <option value="CTE">CTe (Conhecimento de Transporte)</option>
                    <option value="NFE">NFe (Nota Fiscal Eletrônica)</option>
                    <option value="NFSE">NFSe (Nota Fiscal de Serviços)</option>
                    <option value="MDFE">MDFe (Manifesto de Documentos Fiscais)</option>
                    <option value="TODOS">Todos os Documentos</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Nome da Variável</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="ex: Container"
                    value={newRule.nome_variavel}
                    onChange={(e) => setNewRule({ ...newRule, nome_variavel: e.target.value })}
                    required
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Exemplo de Preenchimento</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="ex: R$ 25.000,00"
                    value={newRule.exemplo_preenchimento}
                    onChange={(e) => setNewRule({ ...newRule, exemplo_preenchimento: e.target.value })}
                  />
                </div>

                <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}>
                    <input
                      type="checkbox"
                      checked={newRule.obrigatoria}
                      onChange={(e) => setNewRule({ ...newRule, obrigatoria: e.target.checked })}
                    />
                    Obrigatória
                  </label>
                </div>

                <div style={{ gridColumn: 'span 5', display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                  <button type="submit" className="btn btn-primary">
                    <Plus size={16} /> Adicionar Variável à Apólice
                  </button>
                </div>
              </form>
            </div>

            {/* Listagem de Regras Existentes */}
            <div className="table-container">
              <table className="custom-table">
                <thead>
                  <tr>
                    <th>Apólice</th>
                    <th>Documento</th>
                    <th>Nome Variável</th>
                    <th>Exemplo de Preenchimento</th>
                    <th>Obrigatoriedade</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => {
                    const pol = policies.find((p) => p.id === r.policy_id);
                    return (
                      <tr key={r.id}>
                        <td>{pol?.numero_apolice || r.policy_id}</td>
                        <td>
                          <span className="badge badge-info">{r.tipo_doc}</span>
                        </td>
                        <td><strong>{r.nome_variavel}</strong></td>
                        <td><code>{r.exemplo_preenchimento || '-'}</code></td>
                        <td>
                          {r.obrigatoria ? (
                            <span className="badge badge-error">OBRIGATÓRIA</span>
                          ) : (
                            <span className="badge badge-success">OPCIONAL</span>
                          )}
                        </td>
                        <td>
                          <button
                            className="btn btn-danger"
                            style={{ padding: '4px 8px', fontSize: '0.75rem' }}
                            onClick={() => handleDeleteRule(r.id)}
                          >
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB EXTRA: REGRAS DE OBRIGATORIEDADE POR TIPO DE DOCUMENTO (PADRÃO SEFAZ) */}
        {activeTab === 'documentrules' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="table-container" style={{ padding: '24px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', marginBottom: '8px' }}>
                Regras de Obrigatoriedade de Tag por Tipo de Documento
              </h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                Estas regras valem para <strong>todos os documentos daquele tipo</strong>, independente da apólice ou seguradora usada.
                As tags nativas do padrão Sefaz já nascem cadastradas como obrigatórias (marcadas "Obrigatória Sefaz"); você pode alternar a obrigatoriedade, incluir novas tags, ou remover alguma.
              </p>

              <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                {(['CTE', 'NFE', 'NFSE', 'MDFE'] as TipoDocumento[]).map((tipo) => (
                  <button
                    key={tipo}
                    className={`btn ${docRuleFilter === tipo ? 'btn-primary' : 'btn-secondary'}`}
                    style={{ padding: '8px 16px', fontSize: '0.8rem' }}
                    onClick={() => {
                      setDocRuleFilter(tipo);
                      setNewDocRule({ ...newDocRule, tipo_documento: tipo });
                    }}
                  >
                    {tipo}
                  </button>
                ))}
              </div>

              <form onSubmit={handleCreateDocRule} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '16px', marginBottom: '24px' }}>
                <div className="form-group">
                  <label className="form-label">Tag XML / Caminho</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="ex: infCarga.qCarga"
                    value={newDocRule.tag_path}
                    onChange={(e) => setNewDocRule({ ...newDocRule, tag_path: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Nome Amigável</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="ex: Peso da Carga"
                    value={newDocRule.nome_variavel}
                    onChange={(e) => setNewDocRule({ ...newDocRule, nome_variavel: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Observação</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="ex: Exigida a partir de 2026"
                    value={newDocRule.observacao}
                    onChange={(e) => setNewDocRule({ ...newDocRule, observacao: e.target.value })}
                  />
                </div>
                <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', gap: '12px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}>
                    <input
                      type="checkbox"
                      checked={newDocRule.obrigatoria}
                      onChange={(e) => setNewDocRule({ ...newDocRule, obrigatoria: e.target.checked })}
                    />
                    Obrigatória
                  </label>
                  <button type="submit" className="btn btn-primary" style={{ marginLeft: 'auto' }}>
                    <Plus size={16} /> Incluir Tag em {docRuleFilter}
                  </button>
                </div>
              </form>

              <table className="custom-table">
                <thead>
                  <tr>
                    <th>Tag XML / Caminho</th>
                    <th>Nome da Variável</th>
                    <th>Origem</th>
                    <th>Observação</th>
                    <th>Obrigatoriedade</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {documentRules
                    .filter((r) => r.tipo_documento === docRuleFilter)
                    .map((r) => (
                      <tr key={r.id}>
                        <td><code>{r.tag_path}</code></td>
                        <td><strong>{r.nome_variavel}</strong></td>
                        <td>
                          {r.origem === 'SEFAZ_PADRAO' ? (
                            <span className="badge badge-info">SEFAZ PADRÃO</span>
                          ) : (
                            <span className="badge badge-warning">CUSTOM</span>
                          )}
                        </td>
                        <td style={{ fontSize: '0.8rem' }}>{r.observacao || '-'}</td>
                        <td>
                          <button
                            className={`btn ${r.obrigatoria ? 'btn-primary' : 'btn-secondary'}`}
                            style={{ padding: '6px 12px', fontSize: '0.75rem' }}
                            onClick={() => handleToggleDocRuleObrigatoria(r)}
                          >
                            {r.obrigatoria ? 'OBRIGATÓRIA' : 'OPCIONAL'}
                          </button>
                        </td>
                        <td>
                          <button
                            className="btn btn-danger"
                            style={{ padding: '4px 8px', fontSize: '0.75rem' }}
                            onClick={() => handleDeleteDocRule(r.id)}
                          >
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 4: TEXTOS DE RETORNO DA API */}
        {activeTab === 'templates' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="table-container" style={{ padding: '24px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', marginBottom: '8px' }}>
                Gestão de Textos e Códigos de Retorno da API (`response_templates`)
              </h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                Edite as mensagens que serão entregues pela API para cada código de erro/sucesso. Os placeholders serão substituídos dinamicamente.
              </p>

              {editingTemplate && (
                <div style={{ background: 'var(--bg-card-hover)', padding: '20px', borderRadius: 'var(--radius-md)', marginBottom: '24px', border: '1px solid var(--primary)' }}>
                  <h3 style={{ fontSize: '1rem', marginBottom: '12px' }}>
                    Editando Código: <strong>{editingTemplate.codigo}</strong>
                  </h3>
                  <div className="form-group" style={{ marginBottom: '12px' }}>
                    <label className="form-label">Texto Customizado</label>
                    <textarea
                      className="form-textarea"
                      value={customText}
                      onChange={(e) => setCustomText(e.target.value)}
                    />
                  </div>
                  <div style={{ marginBottom: '12px' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Placeholders Disponíveis: </span>
                    {editingTemplate.placeholders.map((ph) => (
                      <span key={ph} className="chip" onClick={() => setCustomText(customText + ' ' + ph)}>
                        {ph}
                      </span>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: '12px' }}>
                    <button className="btn btn-primary" onClick={handleSaveTemplate}>
                      Salvar Alterações
                    </button>
                    <button className="btn btn-secondary" onClick={() => setEditingTemplate(null)}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}

              <table className="custom-table">
                <thead>
                  <tr>
                    <th>Código</th>
                    <th>Tipo</th>
                    <th>Categoria</th>
                    <th>Mensagem Atual de Retorno</th>
                    <th>Ação</th>
                  </tr>
                </thead>
                <tbody>
                  {templates.map((t) => (
                    <tr key={t.id}>
                      <td><strong>{t.codigo}</strong></td>
                      <td>
                        <span className={`badge ${t.tipo === 'sucesso' ? 'badge-success' : t.tipo === 'aviso' ? 'badge-warning' : 'badge-error'}`}>
                          {t.tipo}
                        </span>
                      </td>
                      <td>{t.categoria}</td>
                      <td style={{ fontSize: '0.85rem' }}>{t.texto_customizado || t.texto_padrao}</td>
                      <td>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '6px 12px', fontSize: '0.75rem' }}
                          onClick={() => {
                            setEditingTemplate(t);
                            setCustomText(t.texto_customizado || t.texto_padrao);
                          }}
                        >
                          <Edit3 size={12} /> Editar
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* TAB 5: EMISSOR & MOCK */}
        {activeTab === 'emitter' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="table-container" style={{ padding: '24px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', marginBottom: '16px' }}>
                Testador de Averbação & Gerador de XML de Teste Sefaz
              </h2>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div className="form-group">
                    <label className="form-label">Cliente / Tenant (Transportador)</label>
                    <select
                      className="form-select"
                      value={emitterTenantId}
                      onChange={(e) => setEmitterTenantId(e.target.value)}
                    >
                      {tenants.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.razao_social} ({t.ambiente.toUpperCase()})
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Tipo de Documento a Gerar</label>
                    <select
                      className="form-select"
                      value={emitterTipoDoc}
                      onChange={(e) => setEmitterTipoDoc(e.target.value as TipoDocumento)}
                    >
                      <option value="CTE">CT-e</option>
                      <option value="NFE">NF-e</option>
                      <option value="NFSE">NFS-e</option>
                      <option value="MDFE">MDF-e</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Ramo da Apólice (para averbar)</label>
                    <select
                      className="form-select"
                      value={emitterRamo}
                      onChange={(e) => setEmitterRamo(e.target.value)}
                    >
                      <option value="RCTRC">RCTRC - Rodo Carga</option>
                      <option value="RCDC">RCDC - Rodo Desaparecimento</option>
                      <option value="RCV">RCV - Rodo Veículos</option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label">Apólice a Usar (para embutir variáveis no XML)</label>
                    <select
                      className="form-select"
                      value={emitterPolicyId}
                      onChange={(e) => setEmitterPolicyId(e.target.value)}
                    >
                      <option value="">-- Nenhuma (não embutir variáveis) --</option>
                      {policies
                        .filter((p) => p.tenant_id === emitterTenantId)
                        .map((p) => (
                          <option key={p.id} value={p.id}>{p.numero_apolice} ({p.ramo})</option>
                        ))}
                    </select>
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}>
                    <input
                      type="checkbox"
                      checked={emitterIncluirVars}
                      onChange={(e) => setEmitterIncluirVars(e.target.checked)}
                    />
                    Incluir as variáveis da apólice preenchidas no campo de OBS do XML
                  </label>

                  <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                    <button className="btn btn-secondary" onClick={handleGenerateMockInEmitter}>
                      <RefreshCw size={16} /> Gerar XML de Teste
                    </button>
                    <button className="btn btn-secondary" onClick={handleDownloadXml}>
                      <Download size={16} /> Baixar XML
                    </button>
                    <button className="btn btn-secondary" onClick={handleGenerateTokenInEmitter}>
                      <Lock size={16} /> Gerar JWT Token
                    </button>
                  </div>

                  {generatedToken && (
                    <div style={{ fontSize: '0.75rem', background: '#111', padding: '10px', borderRadius: '6px', overflowWrap: 'break-word' }}>
                      <strong>Token JWT Ativo:</strong> {generatedToken}
                    </div>
                  )}

                  <button className="btn btn-primary" onClick={handleSubmitAverbacaoInEmitter}>
                    <Play size={16} /> Enviar Averbação para API
                  </button>
                </div>

                <div className="form-group">
                  <label className="form-label">Conteúdo XML / JSON</label>
                  <textarea
                    className="form-textarea"
                    style={{ height: '260px' }}
                    value={emitterXml}
                    onChange={(e) => setEmitterXml(e.target.value)}
                    placeholder="Cole ou gere um XML Sefaz CTe/NFe/NFSe/MDFe"
                  />
                </div>
              </div>

              {emitterResult && (
                <div style={{ marginTop: '24px' }}>
                  <h3 style={{ fontSize: '1rem', marginBottom: '12px' }}>Resposta da API:</h3>
                  <div className="code-block">
                    {JSON.stringify(emitterResult, null, 2)}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB EXTRA: IMPORTAÇÃO EM LOTE DE XMLs */}
        {activeTab === 'import' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="table-container" style={{ padding: '24px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', marginBottom: '8px' }}>
                Importação em Lote de XMLs para um Transportador
              </h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                Envie vários arquivos XML de uma vez para um cliente e veja, documento a documento, se ele averba ou é recusado — e o código de recusa de cada um.
              </p>

              <form onSubmit={handleImportLote} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '16px', alignItems: 'flex-end' }}>
                <div className="form-group">
                  <label className="form-label">Cliente / Transportador</label>
                  <select
                    className="form-select"
                    value={importTenantId}
                    onChange={(e) => setImportTenantId(e.target.value)}
                  >
                    <option value="">-- Selecione o Cliente --</option>
                    {tenants.map((t) => (
                      <option key={t.id} value={t.id}>{t.razao_social}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Ramo da Apólice</label>
                  <select
                    className="form-select"
                    value={importRamo}
                    onChange={(e) => setImportRamo(e.target.value)}
                  >
                    <option value="RCTRC">RCTRC</option>
                    <option value="RCDC">RCDC</option>
                    <option value="RCV">RCV</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Arquivos XML (múltiplos)</label>
                  <input
                    type="file"
                    className="form-input"
                    multiple
                    accept=".xml"
                    onChange={(e) => setImportFiles(e.target.files)}
                  />
                </div>
                <button type="submit" className="btn btn-primary" disabled={importLoading}>
                  {importLoading ? <RefreshCw size={16} className="spin" /> : <Upload size={16} />}
                  {importLoading ? 'Importando...' : 'Importar Lote'}
                </button>
              </form>

              {importResult && (
                <div style={{ marginTop: '28px' }}>
                  {importResult.status !== 'sucesso' ? (
                    <p style={{ color: 'var(--accent-red, #e05252)' }}>{importResult.mensagem}</p>
                  ) : (
                    <>
                      <div className="grid-stats" style={{ marginBottom: '20px' }}>
                        <div className="card-stat">
                          <span className="stat-label">Total de Arquivos</span>
                          <span className="stat-value">{importResult.total}</span>
                        </div>
                        <div className="card-stat">
                          <span className="stat-label">Averbados / Avisos</span>
                          <span className="stat-value" style={{ color: 'var(--accent-emerald)' }}>{importResult.total_sucesso}</span>
                        </div>
                        <div className="card-stat">
                          <span className="stat-label">Recusados</span>
                          <span className="stat-value" style={{ color: 'var(--accent-red, #e05252)' }}>{importResult.total_erro}</span>
                        </div>
                      </div>
                      <table className="custom-table">
                        <thead>
                          <tr>
                            <th>Arquivo</th>
                            <th>Status</th>
                            <th>Código</th>
                            <th>Mensagem</th>
                          </tr>
                        </thead>
                        <tbody>
                          {importResult.resultados.map((r: any, idx: number) => (
                            <tr key={idx}>
                              <td>{r.arquivo}</td>
                              <td>
                                {r.status === 'erro' ? (
                                  <span className="badge badge-error">RECUSADO</span>
                                ) : r.status === 'aviso' ? (
                                  <span className="badge badge-warning">AVISO</span>
                                ) : (
                                  <span className="badge badge-success">AVERBADO</span>
                                )}
                              </td>
                              <td><code>{r.codigo}</code></td>
                              <td style={{ fontSize: '0.8rem' }}>{r.mensagem}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 6: SIMULADOR MULTI-CLIENTE */}
        {activeTab === 'simulator' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="table-container" style={{ padding: '24px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', marginBottom: '8px' }}>
                Simulador de Carga em Lote Multi-Cliente (10 a 100.000 documentos)
              </h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                Selecione os clientes do ambiente de teste para disparar simulações de carga de alto volume e verificar métricas de throughput e latência por cliente.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
                <div>
                  <h3 style={{ fontSize: '0.95rem', marginBottom: '12px' }}>Selecione os Clientes-Alvo (Ambiente Teste):</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {tenants
                      .filter((t) => t.ambiente === 'teste')
                      .map((t) => (
                        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'var(--bg-card-hover)', padding: '10px 14px', borderRadius: 'var(--radius-sm)' }}>
                          <input
                            type="checkbox"
                            checked={!!selectedSimTenants[t.id]}
                            onChange={(e) =>
                              setSelectedSimTenants({ ...selectedSimTenants, [t.id]: e.target.checked })
                            }
                          />
                          <div style={{ flex: 1 }}>
                            <strong>{t.razao_social}</strong>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t.cnpj}</div>
                          </div>
                          {simDistribuicao === 'CUSTOM' && (
                            <input
                              type="number"
                              className="form-input"
                              style={{ width: '90px', padding: '4px 8px' }}
                              value={customTenantCounts[t.id] || 10}
                              onChange={(e) =>
                                setCustomTenantCounts({
                                  ...customTenantCounts,
                                  [t.id]: Number(e.target.value)
                                })
                              }
                            />
                          )}
                        </div>
                      ))}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div className="form-group">
                    <label className="form-label">Modo de Distribuição de Carga</label>
                    <select
                      className="form-select"
                      value={simDistribuicao}
                      onChange={(e) => setSimDistribuicao(e.target.value as any)}
                    >
                      <option value="ROUND_ROBIN">Round-Robin (Divisão igualitária entre clientes)</option>
                      <option value="CUSTOM">Customizado (Quantidade fixa por cliente)</option>
                    </select>
                  </div>

                  {simDistribuicao === 'ROUND_ROBIN' && (
                    <div className="form-group">
                      <label className="form-label">Volume Total de Documentos</label>
                      <div style={{ display: 'flex', gap: '10px' }}>
                        {[10, 100, 1000, 10000, 100000].map((vol) => (
                          <button
                            key={vol}
                            className={`btn ${simTotalDocs === vol ? 'btn-primary' : 'btn-secondary'}`}
                            style={{ padding: '8px 14px', fontSize: '0.8rem' }}
                            onClick={() => setSimTotalDocs(vol)}
                          >
                            {vol.toLocaleString()} docs
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <button className="btn btn-primary" onClick={handleRunSimulation} disabled={simLoading}>
                    {simLoading ? <RefreshCw size={16} className="spin" /> : <Play size={16} />}
                    {simLoading ? 'Executando Lote...' : 'Iniciar Simulação em Lote'}
                  </button>
                </div>
              </div>

              {simResult && (
                <div style={{ marginTop: '32px' }}>
                  <h3 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.1rem', marginBottom: '16px' }}>
                    Relatório de Métricas Segmentadas do Lote
                  </h3>

                  <div className="grid-stats" style={{ marginBottom: '24px' }}>
                    <div className="card-stat">
                      <span className="stat-label">Total Processado</span>
                      <span className="stat-value">{simResult.metricas_globais.total}</span>
                    </div>
                    <div className="card-stat">
                      <span className="stat-label">Throughput Real</span>
                      <span className="stat-value" style={{ color: 'var(--accent-cyan)' }}>
                        {simResult.metricas_globais.throughput_docs_sec} docs/seg
                      </span>
                    </div>
                    <div className="card-stat">
                      <span className="stat-label">Sucessos / Avisos</span>
                      <span className="stat-value" style={{ color: 'var(--accent-emerald)' }}>
                        {simResult.metricas_globais.sucessos}
                      </span>
                    </div>
                    <div className="card-stat">
                      <span className="stat-label">Tempo Total (ms)</span>
                      <span className="stat-value">{simResult.metricas_globais.tempo_total_ms} ms</span>
                    </div>
                  </div>

                  <h4 style={{ fontSize: '0.95rem', marginBottom: '12px' }}>Segmentação por Cliente:</h4>
                  <table className="custom-table">
                    <thead>
                      <tr>
                        <th>Cliente / Razão Social</th>
                        <th>Documentos Enviados</th>
                        <th>Sucessos</th>
                        <th>Falhas</th>
                        <th>Tempo Médio por Doc (ms)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(simResult.metricas_por_cliente).map(([tId, m]) => (
                        <tr key={tId}>
                          <td>
                            <strong>{m.razao_social}</strong>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{m.cnpj}</div>
                          </td>
                          <td>{m.total}</td>
                          <td><span className="badge badge-success">{m.sucessos}</span></td>
                          <td><span className="badge badge-error">{m.erros}</span></td>
                          <td>{m.tempo_medio_ms} ms</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB EXTRA: RELATÓRIO POR CLIENTE OU CONJUNTO DE CLIENTES */}
        {activeTab === 'report' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="table-container" style={{ padding: '24px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', marginBottom: '8px' }}>
                Relatório por Cliente ou Conjunto de Clientes
              </h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                Selecione um ou mais clientes (nenhum selecionado = todos) e gere o relatório consolidado de averbações.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '20px', maxWidth: '480px' }}>
                {tenants.map((t) => (
                  <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'var(--bg-card-hover)', padding: '10px 14px', borderRadius: 'var(--radius-sm)' }}>
                    <input
                      type="checkbox"
                      checked={!!selectedReportTenants[t.id]}
                      onChange={(e) => setSelectedReportTenants({ ...selectedReportTenants, [t.id]: e.target.checked })}
                    />
                    <div>
                      <strong>{t.razao_social}</strong>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t.cnpj}</div>
                    </div>
                  </label>
                ))}
              </div>

              <button className="btn btn-primary" onClick={handleGerarRelatorio} disabled={reportLoading}>
                {reportLoading ? <RefreshCw size={16} className="spin" /> : <BarChart3 size={16} />}
                {reportLoading ? 'Gerando...' : 'Gerar Relatório'}
              </button>

              {reportData && (
                <div style={{ marginTop: '28px' }}>
                  <div className="grid-stats" style={{ marginBottom: '24px' }}>
                    <div className="card-stat">
                      <span className="stat-label">Total de Averbações</span>
                      <span className="stat-value">{reportData.consolidado.total_averbacoes}</span>
                    </div>
                    <div className="card-stat">
                      <span className="stat-label">Sucesso / Aviso</span>
                      <span className="stat-value" style={{ color: 'var(--accent-emerald)' }}>{reportData.consolidado.total_sucesso}</span>
                    </div>
                    <div className="card-stat">
                      <span className="stat-label">Recusas</span>
                      <span className="stat-value" style={{ color: 'var(--accent-red, #e05252)' }}>{reportData.consolidado.total_erro}</span>
                    </div>
                    <div className="card-stat">
                      <span className="stat-label">Valor Total Averbado</span>
                      <span className="stat-value">
                        {reportData.consolidado.valor_total_averbado.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                      </span>
                    </div>
                  </div>

                  <table className="custom-table">
                    <thead>
                      <tr>
                        <th>Cliente</th>
                        <th>Total</th>
                        <th>Sucesso</th>
                        <th>Erro</th>
                        <th>Valor Averbado</th>
                        <th>CTe / NFe / NFSe / MDFe</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reportData.por_cliente.map((c: any) => (
                        <tr key={c.tenant_id}>
                          <td>
                            <strong>{c.razao_social}</strong>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{c.cnpj}</div>
                          </td>
                          <td>{c.total_averbacoes}</td>
                          <td><span className="badge badge-success">{c.total_sucesso}</span></td>
                          <td><span className="badge badge-error">{c.total_erro}</span></td>
                          <td>{c.valor_total_averbado.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
                          <td style={{ fontSize: '0.8rem' }}>
                            {c.por_tipo_documento.CTE} / {c.por_tipo_documento.NFE} / {c.por_tipo_documento.NFSE} / {c.por_tipo_documento.MDFE}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB EXTRA: DOCUMENTAÇÃO DA API */}
        {activeTab === 'apidocs' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="table-container" style={{ padding: '24px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', marginBottom: '16px' }}>
                Documentação da API — Cada Endpoint e Como Usá-lo
              </h2>
              {apiDocsLoading ? (
                <p>Carregando documentação...</p>
              ) : (
                <pre
                  className="code-block"
                  style={{ whiteSpace: 'pre-wrap', maxHeight: '70vh', overflowY: 'auto', fontSize: '0.8rem', lineHeight: 1.6 }}
                >
                  {apiDocsContent || 'Documentação indisponível no momento.'}
                </pre>
              )}
            </div>
          </div>
        )}

        {/* TAB 7: LINK DE RECUPERAÇÃO DE VARIÁVEIS */}
        {activeTab === 'recovery' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            <div className="table-container" style={{ padding: '24px' }}>
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.2rem', marginBottom: '8px' }}>
                Diferencial ARCKATECH: Preenchimento da Variável Faltante via Link
              </h2>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '20px' }}>
                Insira o token de recuperação gerado no erro `ERR-4004` para simular a experiência web do cliente final suplementando os dados.
              </p>

              <div style={{ display: 'flex', gap: '12px', marginBottom: '24px' }}>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Informe o token_recuperacao (ex: rec_...)"
                  style={{ width: '400px' }}
                  value={recoveryTokenInput}
                  onChange={(e) => setRecoveryTokenInput(e.target.value)}
                />
                <button className="btn btn-primary" onClick={() => fetchRecoveryInfo(recoveryTokenInput)}>
                  Buscar Dados
                </button>
              </div>

              {recoveryData && (
                <form onSubmit={handleSubmitRecovery} style={{ background: 'var(--bg-card-hover)', padding: '24px', borderRadius: 'var(--radius-lg)' }}>
                  <h3 style={{ fontSize: '1rem', marginBottom: '12px' }}>
                    Averbação Pendente para: <strong>{recoveryData.cliente}</strong> ({recoveryData.cnpj})
                  </h3>
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '16px' }}>
                    Apólice: {recoveryData.apolice} | Ramo: {recoveryData.ramo}
                  </p>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '20px' }}>
                    {recoveryData.variaveis_faltantes?.map((vName: string) => (
                      <div key={vName} className="form-group">
                        <label className="form-label">Informe o valor para a variável exigida: <strong>{vName}</strong></label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder={`Digite o valor de ${vName}`}
                          value={recoveryFormVars[vName] || ''}
                          onChange={(e) => setRecoveryFormVars({ ...recoveryFormVars, [vName]: e.target.value })}
                          required
                        />
                      </div>
                    ))}
                  </div>

                  <button type="submit" className="btn btn-primary">
                    <CheckCircle2 size={16} /> Concluir e Averbar Documento
                  </button>
                </form>
              )}

              {recoveryMessage && (
                <div style={{ marginTop: '24px' }}>
                  <h3 style={{ fontSize: '1rem', marginBottom: '12px' }}>Resultado Final da Averbação Suplementada:</h3>
                  <div className="code-block">
                    {JSON.stringify(recoveryMessage, null, 2)}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
