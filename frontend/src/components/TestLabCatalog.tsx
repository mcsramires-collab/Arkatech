import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FlaskConical,
  Layers,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  XCircle
} from 'lucide-react';
import { ApiClient } from '../services/api';
import { TestLabPresets, TestLabAnalysis } from './TestLabTools';
import {
  LabTab,
  TestLabCoverageCenter,
  TestLabHistoryCenter,
  TestLabOverview,
  TestLabV2Navigation
} from './TestLabV2Panels';
import { TestLabStudioV2 } from './TestLabStudioV2';

type EngineStatus = 'ACTIVE' | 'PLANNED' | 'INVARIANT';
type RunMode = 'QUICK' | 'STANDARD' | 'EXHAUSTIVE';
type ScenarioStatus = 'PASS' | 'FAIL' | 'GAP';

interface TestLabFlag {
  key: string;
  group: string;
  label: string;
  description: string;
  value_type: string;
  engine_status: EngineStatus;
  generation: string;
  source: { kind: string; path: string };
  tags: string[];
}

interface TestLabGroup {
  key: string;
  label: string;
  description: string;
  order: number;
}

interface TestLabSuite {
  key: string;
  label: string;
  description: string;
  priority: 'P0' | 'P1' | 'P2';
  flag_keys: string[];
}

interface TestLabCatalogData {
  version: string;
  environment_guard: string;
  summary: {
    total_flags: number;
    active: number;
    invariants: number;
    planned: number;
    groups: number;
    suites: number;
  };
  groups: TestLabGroup[];
  flags: TestLabFlag[];
  suites: TestLabSuite[];
  extension_contract: {
    description: string;
    required_fields: string[];
  };
}

interface PlanScenario {
  id: string;
  suite_key: string;
  priority: 'P0' | 'P1' | 'P2';
  title: string;
  description: string;
  covers_flag_keys: string[];
  gap_reason?: string;
}

interface TestLabPlanData {
  mode: RunMode;
  suite_keys: string[];
  selected_flag_keys: string[];
  total_scenarios: number;
  p0: number;
  p1: number;
  estimated_cartesian_cases: number;
  estimated_pairwise_cases: number;
  scenarios: PlanScenario[];
}

interface AssertionResult {
  key: string;
  label: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
  detail?: string;
}

interface ScenarioResult {
  id: string;
  suite_key: string;
  priority: 'P0' | 'P1' | 'P2';
  title: string;
  description: string;
  tags: string[];
  covers_flag_keys: string[];
  status: ScenarioStatus;
  duration_ms: number;
  assertions: AssertionResult[];
  evidence?: Record<string, unknown>;
  error?: string;
}

interface TestLabRunData {
  id: string;
  mode: RunMode;
  suite_keys: string[];
  status: 'PLANNED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  total_planned: number;
  total_executed: number;
  passed: number;
  failed: number;
  gaps: number;
  duration_ms: number;
  scenario_results: ScenarioResult[];
  rerun_of?: string;
  created_at: string;
  completed_at?: string;
}

interface CatalogAudit {
  detected_business_keys: string[];
  uncatalogued_business_keys: string[];
  catalogued_not_detected_in_backend: string[];
  ok: boolean;
}

function StatusBadge({ status }: { status: EngineStatus }) {
  if (status === 'ACTIVE') return <span className="badge badge-success">Motor ativo</span>;
  if (status === 'INVARIANT') return <span className="badge badge-info">Invariante</span>;
  return <span className="badge badge-warning">Planejada / gap</span>;
}

function ScenarioBadge({ status }: { status: ScenarioStatus }) {
  if (status === 'PASS') return <span className="badge badge-success">PASS</span>;
  if (status === 'FAIL') return <span className="badge badge-error">FAIL</span>;
  return <span className="badge badge-warning">GAP</span>;
}

function stringify(value: unknown) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function TestLabCatalog() {
  const [catalog, setCatalog] = useState<TestLabCatalogData | null>(null);
  const [audit, setAudit] = useState<CatalogAudit | null>(null);
  const [history, setHistory] = useState<TestLabRunData[]>([]);
  const [plan, setPlan] = useState<TestLabPlanData | null>(null);
  const [run, setRun] = useState<TestLabRunData | null>(null);
  const [mode, setMode] = useState<RunMode>('STANDARD');
  const [selectedSuites, setSelectedSuites] = useState<Record<string, boolean>>({});
  const [customFlags, setCustomFlags] = useState(false);
  const [selectedFlags, setSelectedFlags] = useState<Record<string, boolean>>({});
  const [selectedGroup, setSelectedGroup] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'ALL' | ScenarioStatus>('ALL');
  const [priorityFilter, setPriorityFilter] = useState<'ALL' | 'P0' | 'P1'>('ALL');
  const [loading, setLoading] = useState(true);
  const [planning, setPlanning] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState<LabTab>('overview');

  const loadBase = async () => {
    setLoading(true);
    setError('');
    const [catalogResponse, auditResponse, historyResponse] = await Promise.all([
      ApiClient.getTestLabCatalog(),
      ApiClient.getTestLabCatalogAudit(),
      ApiClient.getTestLabRuns(25)
    ]);

    if (catalogResponse?.status !== 'sucesso' || !catalogResponse.catalog) {
      const mensagem = String(catalogResponse?.mensagem || '');
      const authError =
        catalogResponse?.codigo === 'ERR-4001' ||
        mensagem.toLowerCase().includes('autenticação') ||
        mensagem.toLowerCase().includes('authentication');

      setError(
        authError
          ? 'O Laboratório V2 está instalado, mas o proxy seguro do painel não conseguiu autenticar no backend. Configure INTERNAL_API_KEY no serviço frontend com o mesmo valor do backend e faça um novo deploy.'
          : mensagem || 'Não foi possível carregar o catálogo do Laboratório.'
      );
      setLoading(false);
      return;
    }

    const nextCatalog = catalogResponse.catalog as TestLabCatalogData;
    setCatalog(nextCatalog);
    setAudit(auditResponse?.audit ?? null);
    setHistory(historyResponse?.runs ?? []);

    setSelectedSuites((current) => {
      if (Object.keys(current).length > 0) return current;
      return Object.fromEntries(
        nextCatalog.suites
          .filter((suite) => suite.priority === 'P0' || suite.priority === 'P1')
          .map((suite) => [suite.key, true])
      );
    });

    setLoading(false);
  };

  useEffect(() => {
    loadBase();
  }, []);

  const selectedSuiteKeys = useMemo(
    () => Object.entries(selectedSuites).filter(([, checked]) => checked).map(([key]) => key),
    [selectedSuites]
  );

  const visibleFlags = useMemo(() => {
    if (!catalog) return [];
    if (selectedGroup === 'all') return catalog.flags;
    return catalog.flags.filter((flag) => flag.group === selectedGroup);
  }, [catalog, selectedGroup]);

  const visibleResults = useMemo(() => {
    const items = run?.scenario_results ?? [];
    return items.filter((item) => {
      if (statusFilter !== 'ALL' && item.status !== statusFilter) return false;
      if (priorityFilter !== 'ALL' && item.priority !== priorityFilter) return false;
      return true;
    });
  }, [run, statusFilter, priorityFilter]);

  const selectedFlagKeys = useMemo(
    () => Object.entries(selectedFlags).filter(([, checked]) => checked).map(([key]) => key),
    [selectedFlags]
  );

  const requestPayload = () => ({
    mode,
    suite_keys: selectedSuiteKeys,
    ...(customFlags ? { selected_flag_keys: selectedFlagKeys } : {})
  });

  const handlePlan = async () => {
    if (selectedSuiteKeys.length === 0) {
      setError('Selecione ao menos uma suíte P0/P1.');
      return;
    }
    if (customFlags && selectedFlagKeys.length === 0) {
      setError('No modo avançado, selecione ao menos uma regra/flag.');
      return;
    }
    setPlanning(true);
    setError('');
    const response = await ApiClient.planTestLab(requestPayload());
    if (response?.status === 'sucesso') {
      setPlan(response.plan);
    } else {
      setError(response?.mensagem || 'Falha ao montar plano de testes.');
    }
    setPlanning(false);
  };

  const handleExecute = async () => {
    if (selectedSuiteKeys.length === 0) {
      setError('Selecione ao menos uma suíte P0/P1.');
      return;
    }
    if (customFlags && selectedFlagKeys.length === 0) {
      setError('No modo avançado, selecione ao menos uma regra/flag.');
      return;
    }
    setRunning(true);
    setError('');
    const response = await ApiClient.executeTestLab(requestPayload());
    if (response?.status === 'sucesso') {
      setRun(response.run);
      setPlan(null);
      const historyResponse = await ApiClient.getTestLabRuns(25);
      if (historyResponse?.status === 'sucesso') setHistory(historyResponse.runs ?? []);
    } else {
      setError(response?.mensagem || 'Falha ao executar o Laboratório.');
    }
    setRunning(false);
  };

  const openHistoryRun = async (id: string) => {
    setError('');
    const response = await ApiClient.getTestLabRun(id);
    if (response?.status === 'sucesso') {
      setRun(response.run);
    } else {
      setError(response?.mensagem || 'Falha ao abrir execução.');
    }
  };

  const handleRerunFailed = async () => {
    if (!run) return;
    setRunning(true);
    setError('');
    const response = await ApiClient.rerunTestLabFailed(run.id);
    if (response?.status === 'sucesso') {
      setRun(response.run);
      const historyResponse = await ApiClient.getTestLabRuns(25);
      if (historyResponse?.status === 'sucesso') setHistory(historyResponse.runs ?? []);
    } else {
      setError(response?.mensagem || 'Não foi possível reexecutar as falhas.');
    }
    setRunning(false);
  };

  const selectPriority = (priority: 'P0' | 'P1' | 'ALL') => {
    if (!catalog) return;
    setSelectedSuites(
      Object.fromEntries(
        catalog.suites
          .filter((suite) => suite.priority === 'P0' || suite.priority === 'P1')
          .map((suite) => [
            suite.key,
            priority === 'ALL' ? true : suite.priority === priority
          ])
      )
    );
    setPlan(null);
  };

  if (loading) {
    return (
      <div className="table-container" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <RefreshCw size={18} className="spin" />
          <span>Carregando Laboratório de Testes...</span>
        </div>
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className="table-container" style={{ padding: '28px' }}>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
          <AlertTriangle size={22} style={{ marginTop: '2px', flexShrink: 0 }} />
          <div>
            <h2 style={{ margin: 0, fontSize: '1.15rem' }}>Laboratório de Testes V2 bloqueado</h2>
            <p style={{ margin: '8px 0 0', color: 'var(--text-secondary)', maxWidth: '900px' }}>
              {error || 'O catálogo não pôde ser carregado.'}
            </p>
            <div style={{ marginTop: '14px', padding: '12px', borderRadius: '8px', background: 'var(--bg-card-hover)' }}>
              A tela antiga de carga não é o Laboratório V2. Depois que a autenticação do painel estiver válida,
              esta área exibirá Visão Geral, Studio de Cenários, Coverage Center, Execuções e Regressão Oficial.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const navigation = <TestLabV2Navigation active={activeTab} onChange={setActiveTab} />;

  if (activeTab === 'overview') {
    return (
      <>
        {navigation}
        <TestLabOverview
          catalog={catalog}
          audit={audit}
          history={history}
          onNavigate={setActiveTab}
        />
      </>
    );
  }

  if (activeTab === 'studio') {
    return (
      <>
        {navigation}
        <TestLabStudioV2 catalog={catalog} />
      </>
    );
  }

  if (activeTab === 'coverage') {
    return (
      <>
        {navigation}
        <TestLabCoverageCenter catalog={catalog} currentRun={run} history={history} />
      </>
    );
  }

  if (activeTab === 'history') {
    return (
      <>
        {navigation}
        <TestLabHistoryCenter
          history={history}
          onOpen={async (id) => {
            await openHistoryRun(id);
            setActiveTab('regression');
          }}
        />
      </>
    );
  }

  return (
    <>
      {navigation}
      <TestLabPresets selection={requestPayload()} apply={value => {
        setMode(value.mode);
        setSelectedSuites(Object.fromEntries(value.suite_keys.filter(key => catalog.suites.some(s => s.key === key)).map(key => [key, true])));
        setCustomFlags(Boolean(value.selected_flag_keys));
        setSelectedFlags(Object.fromEntries((value.selected_flag_keys ?? []).filter(key => catalog.flags.some(f => f.key === key)).map(key => [key, true])));
        setPlan(null);
      }} />
      {run && <TestLabAnalysis key={run.id} run={run} flags={catalog.flags} history={history} />}
      <div className="table-container" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '20px', alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
              <FlaskConical size={22} />
              <h2 style={{ fontFamily: 'var(--font-heading)', fontSize: '1.25rem', margin: 0 }}>
                Laboratório de Testes
              </h2>
            </div>
            <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-secondary)', maxWidth: '900px' }}>
              Regressão automatizada orientada ao catálogo real de regras. Os cenários sintéticos rodam
              isolados e apenas o relatório da execução é persistido.
            </p>
          </div>
          <span className="env-badge teste"><ShieldCheck size={14} /> TEST ONLY</span>
        </div>

        {error && (
          <div style={{ marginTop: '14px', padding: '12px', background: 'var(--bg-card-hover)', borderRadius: '8px' }}>
            <AlertTriangle size={15} style={{ marginRight: '8px', verticalAlign: 'middle' }} />
            {error}
          </div>
        )}

        <div className="grid-stats" style={{ marginTop: '20px' }}>
          <div className="card-stat">
            <span className="stat-label">Itens catalogados</span>
            <span className="stat-value">{catalog.summary.total_flags}</span>
          </div>
          <div className="card-stat">
            <span className="stat-label">Regras ativas</span>
            <span className="stat-value" style={{ color: 'var(--accent-emerald)' }}>{catalog.summary.active}</span>
          </div>
          <div className="card-stat">
            <span className="stat-label">Invariantes</span>
            <span className="stat-value" style={{ color: 'var(--accent-cyan)' }}>{catalog.summary.invariants}</span>
          </div>
          <div className="card-stat">
            <span className="stat-label">Gaps conhecidos</span>
            <span className="stat-value">{catalog.summary.planned}</span>
          </div>
        </div>
      </div>

      <div className="table-container" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center', marginBottom: '18px' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Executar regressão</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '4px' }}>
              P0 é bloqueador de merge. P1 amplia regras, integrações, prazos, coberturas e governança.
            </div>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-secondary" onClick={() => selectPriority('P0')}>Só P0</button>
            <button className="btn btn-secondary" onClick={() => selectPriority('P1')}>Só P1</button>
            <button className="btn btn-secondary" onClick={() => selectPriority('ALL')}>P0 + P1</button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)', gap: '22px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px' }}>
            {catalog.suites
              .filter((suite) => suite.priority === 'P0' || suite.priority === 'P1')
              .map((suite) => (
                <label key={suite.key} style={{
                  display: 'flex',
                  gap: '10px',
                  padding: '12px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-card-hover)',
                  cursor: 'pointer'
                }}>
                  <input
                    type="checkbox"
                    checked={Boolean(selectedSuites[suite.key])}
                    onChange={(event) => {
                      setSelectedSuites({ ...selectedSuites, [suite.key]: event.target.checked });
                      setPlan(null);
                    }}
                  />
                  <div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <strong>{suite.label}</strong>
                      <span className={suite.priority === 'P0' ? 'badge badge-error' : 'badge badge-info'}>
                        {suite.priority}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                      {suite.description}
                    </div>
                  </div>
                </label>
              ))}
          </div>

          <div>
            <div className="form-group">
              <label className="form-label">Modo</label>
              <select
                className="form-select"
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value as RunMode);
                  setPlan(null);
                }}
              >
                <option value="QUICK">Rápido — críticos</option>
                <option value="STANDARD">Padrão — recomendado</option>
                <option value="EXHAUSTIVE">Exaustivo — maior cobertura</option>
              </select>
            </div>


            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: '9px',
              marginTop: '12px',
              fontSize: '0.8rem',
              cursor: 'pointer'
            }}>
              <input
                type="checkbox"
                checked={customFlags}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setCustomFlags(enabled);
                  setPlan(null);
                  if (enabled && Object.keys(selectedFlags).length === 0) {
                    const suiteFlagKeys = new Set(
                      catalog.suites
                        .filter((suite) => selectedSuiteKeys.includes(suite.key))
                        .flatMap((suite) => suite.flag_keys)
                    );
                    setSelectedFlags(
                      Object.fromEntries(
                        catalog.flags.map((flag) => [flag.key, suiteFlagKeys.has(flag.key)])
                      )
                    );
                  }
                }}
              />
              Seleção avançada de regras
            </label>
            {customFlags && (
              <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                {selectedFlagKeys.length} regra(s) selecionada(s). Ajuste os checkboxes no catálogo abaixo.
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '14px' }}>
              <button className="btn btn-secondary" disabled={planning || running} onClick={handlePlan}>
                {planning ? <RefreshCw size={15} className="spin" /> : <Layers size={15} />}
                {planning ? 'Calculando...' : 'Calcular cenários'}
              </button>
              <button className="btn btn-primary" disabled={running || planning} onClick={handleExecute}>
                {running ? <RefreshCw size={15} className="spin" /> : <Play size={15} />}
                {running ? 'Executando...' : 'Executar testes'}
              </button>
            </div>
          </div>
        </div>

        {plan && (
          <div style={{ marginTop: '22px', padding: '16px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-card-hover)' }}>
            <strong>Plano calculado</strong>
            <div className="grid-stats" style={{ marginTop: '12px' }}>
              <div className="card-stat">
                <span className="stat-label">Cenários executáveis/GAP</span>
                <span className="stat-value">{plan.total_scenarios}</span>
              </div>
              <div className="card-stat">
                <span className="stat-label">P0</span>
                <span className="stat-value">{plan.p0}</span>
              </div>
              <div className="card-stat">
                <span className="stat-label">P1</span>
                <span className="stat-value">{plan.p1}</span>
              </div>
              <div className="card-stat">
                <span className="stat-label">Pairwise estimado</span>
                <span className="stat-value">{plan.estimated_pairwise_cases}</span>
              </div>
            </div>
            <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '8px' }}>
              Espaço cartesiano das dimensões selecionadas: {plan.estimated_cartesian_cases.toLocaleString('pt-BR')} combinações.
              O modo padrão evita executar esse universo completo.
            </div>
          </div>
        )}
      </div>

      {run && (
        <div className="table-container" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Resultado — {run.id}</h3>
              <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                {run.mode} · {run.total_executed}/{run.total_planned} cenários · {run.duration_ms} ms
                {run.rerun_of ? ` · reexecução de ${run.rerun_of}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {run.failed > 0 && (
                <button className="btn btn-secondary" disabled={running} onClick={handleRerunFailed}>
                  <RotateCcw size={14} /> Reexecutar {run.failed} falha(s)
                </button>
              )}
              <button className="btn btn-secondary" onClick={() => ApiClient.downloadTestLabCsv(run.id)}>
                <Download size={14} /> Exportar CSV
              </button>
            </div>
          </div>

          <div className="grid-stats" style={{ marginTop: '18px' }}>
            <div className="card-stat">
              <span className="stat-label">Executados</span>
              <span className="stat-value">{run.total_executed}</span>
            </div>
            <div className="card-stat">
              <span className="stat-label">PASS</span>
              <span className="stat-value" style={{ color: 'var(--accent-emerald)' }}>{run.passed}</span>
            </div>
            <div className="card-stat">
              <span className="stat-label">FAIL</span>
              <span className="stat-value" style={{ color: 'var(--accent-red, #e05252)' }}>{run.failed}</span>
            </div>
            <div className="card-stat">
              <span className="stat-label">GAP</span>
              <span className="stat-value">{run.gaps}</span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px', marginTop: '18px' }}>
            <select className="form-select" style={{ width: '180px' }} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as any)}>
              <option value="ALL">Todos os status</option>
              <option value="PASS">PASS</option>
              <option value="FAIL">FAIL</option>
              <option value="GAP">GAP</option>
            </select>
            <select className="form-select" style={{ width: '180px' }} value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as any)}>
              <option value="ALL">P0 + P1</option>
              <option value="P0">P0</option>
              <option value="P1">P1</option>
            </select>
          </div>

          <div style={{ marginTop: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {visibleResults.map((scenario) => (
              <details key={scenario.id} style={{ background: 'var(--bg-card-hover)', borderRadius: 'var(--radius-sm)', padding: '12px 14px' }}>
                <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '10px' }}>
                  {scenario.status === 'PASS' ? <CheckCircle2 size={16} /> : scenario.status === 'FAIL' ? <XCircle size={16} /> : <AlertTriangle size={16} />}
                  <ScenarioBadge status={scenario.status} />
                  <span className={scenario.priority === 'P0' ? 'badge badge-error' : 'badge badge-info'}>{scenario.priority}</span>
                  <strong>{scenario.title}</strong>
                  <code style={{ marginLeft: 'auto', fontSize: '0.68rem' }}>{scenario.id}</code>
                </summary>
                <div style={{ marginTop: '12px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  {scenario.description}
                </div>
                {scenario.error && (
                  <div style={{ marginTop: '10px', color: 'var(--accent-red, #e05252)', fontSize: '0.8rem' }}>
                    {scenario.error}
                  </div>
                )}
                {scenario.assertions.length > 0 && (
                  <table className="custom-table" style={{ marginTop: '12px' }}>
                    <thead>
                      <tr><th>Assertion</th><th>Esperado</th><th>Recebido</th><th>Resultado</th></tr>
                    </thead>
                    <tbody>
                      {scenario.assertions.map((item) => (
                        <tr key={item.key}>
                          <td>{item.label}</td>
                          <td><code>{stringify(item.expected)}</code></td>
                          <td><code>{stringify(item.actual)}</code></td>
                          <td>{item.pass ? <span className="badge badge-success">OK</span> : <span className="badge badge-error">DIVERGIU</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {scenario.evidence && (
                  <pre style={{ marginTop: '10px', maxHeight: '240px', overflow: 'auto', fontSize: '0.7rem' }}>
                    {JSON.stringify(scenario.evidence, null, 2)}
                  </pre>
                )}
              </details>
            ))}
          </div>
        </div>
      )}

      <div className="table-container" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '14px' }}>
          {audit?.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Governança do catálogo</h3>
        </div>
        {audit?.ok ? (
          <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
            Nenhuma chave <code>regras:*</code> detectada no backend está sem definição no Laboratório.
          </div>
        ) : (
          <div>
            <strong>Flags sem catálogo:</strong>
            <div style={{ marginTop: '8px' }}>
              {audit?.uncatalogued_business_keys.map((key) => <code key={key} style={{ display: 'block' }}>{key}</code>)}
            </div>
          </div>
        )}
      </div>

      <div className="table-container" style={{ padding: '24px' }}>
        <h3 style={{ margin: '0 0 12px', fontSize: '1rem' }}>Histórico de execuções</h3>
        {history.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Nenhuma execução registrada.</div>
        ) : (
          <table className="custom-table">
            <thead>
              <tr><th>Execução</th><th>Modo</th><th>PASS</th><th>FAIL</th><th>GAP</th><th>Data</th><th></th></tr>
            </thead>
            <tbody>
              {history.map((item) => (
                <tr key={item.id}>
                  <td><code>{item.id}</code></td>
                  <td>{item.mode}</td>
                  <td>{item.passed}</td>
                  <td>{item.failed}</td>
                  <td>{item.gaps}</td>
                  <td>{new Date(item.created_at).toLocaleString('pt-BR')}</td>
                  <td><button className="btn btn-secondary" onClick={() => openHistoryRun(item.id)}>Abrir</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="table-container" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <Layers size={18} />
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Catálogo de regras e flags</h3>
        </div>
        <div style={{ marginBottom: '14px', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
          {catalog.extension_contract.description}
        </div>
        <select className="form-select" style={{ width: '300px', marginBottom: '14px' }} value={selectedGroup} onChange={(event) => setSelectedGroup(event.target.value)}>
          <option value="all">Todos os grupos</option>
          {catalog.groups.map((group) => <option key={group.key} value={group.key}>{group.label}</option>)}
        </select>

        <table className="custom-table">
          <thead>
            <tr>
              {customFlags && <th>Testar</th>}
              <th>Regra / Flag</th><th>Tipo</th><th>Status</th><th>Geração</th><th>Origem técnica</th>
            </tr>
          </thead>
          <tbody>
            {visibleFlags.map((flag) => (
              <tr key={flag.key}>
                {customFlags && (
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Testar ${flag.label}`}
                      checked={Boolean(selectedFlags[flag.key])}
                      onChange={(event) => {
                        setSelectedFlags({ ...selectedFlags, [flag.key]: event.target.checked });
                        setPlan(null);
                      }}
                    />
                  </td>
                )}
                <td>
                  <strong>{flag.label}</strong>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '3px' }}>{flag.description}</div>
                  <code style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{flag.key}</code>
                </td>
                <td>{flag.value_type}</td>
                <td><StatusBadge status={flag.engine_status} /></td>
                <td>{flag.generation}</td>
                <td>
                  <div style={{ fontSize: '0.75rem' }}>{flag.source.kind}</div>
                  <code style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{flag.source.path}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
