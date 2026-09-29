import React, { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  FlaskConical,
  Grid3X3,
  History,
  ShieldCheck,
  XCircle
} from 'lucide-react';

export type LabTab = 'overview' | 'studio' | 'coverage' | 'history' | 'regression';

export interface LabCatalogFlag {
  key: string;
  group: string;
  label: string;
  description: string;
  value_type: string;
  engine_status: 'ACTIVE' | 'PLANNED' | 'INVARIANT';
  generation: string;
  source: { kind: string; path: string };
  options?: Array<{ value: string | number | boolean; label: string }>;
  suggested_values?: Array<string | number | boolean>;
  depends_on?: string[];
  tags: string[];
}

export interface LabCatalogData {
  summary: {
    total_flags: number;
    active: number;
    invariants: number;
    planned: number;
    groups: number;
    suites: number;
  };
  groups: Array<{ key: string; label: string; description: string; order: number }>;
  flags: LabCatalogFlag[];
  suites: Array<{
    key: string;
    label: string;
    description: string;
    priority: 'P0' | 'P1' | 'P2';
    flag_keys: string[];
  }>;
}

export interface LabScenarioResult {
  id: string;
  suite_key: string;
  priority: 'P0' | 'P1' | 'P2';
  title: string;
  covers_flag_keys: string[];
  status: 'PASS' | 'FAIL' | 'GAP';
  duration_ms: number;
  assertions?: unknown[];
  evidence?: Record<string, unknown>;
  error?: string;
}

export interface LabRunData {
  id: string;
  mode: string;
  suite_keys: string[];
  total_planned: number;
  total_executed: number;
  passed: number;
  failed: number;
  gaps: number;
  duration_ms: number;
  scenario_results: LabScenarioResult[];
  created_at: string;
  completed_at?: string;
}

export interface LabAuditData {
  detected_business_keys: string[];
  uncatalogued_business_keys: string[];
  catalogued_not_detected_in_backend: string[];
  ok: boolean;
}

export const labSectionStyle: React.CSSProperties = {
  padding: 24,
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border-color)',
  background: 'var(--bg-card)'
};

export const labMuted: React.CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '0.78rem'
};

function pct(part: number, total: number) {
  return total ? Math.round((part / total) * 100) : 0;
}

function StatCard(props: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'success' | 'danger' | 'warning' | 'info';
}) {
  const color =
    props.tone === 'success'
      ? 'var(--accent-emerald)'
      : props.tone === 'danger'
        ? 'var(--accent-red)'
        : props.tone === 'warning'
          ? 'var(--accent-amber)'
          : props.tone === 'info'
            ? 'var(--accent-cyan)'
            : 'var(--text-primary)';

  return (
    <div className="card-stat" style={{ minHeight: 112 }}>
      <span className="stat-label">{props.label}</span>
      <span className="stat-value" style={{ color }}>{props.value}</span>
      {props.hint && <span style={{ ...labMuted, marginTop: 6 }}>{props.hint}</span>}
    </div>
  );
}

export function TestLabV2Navigation(props: {
  active: LabTab;
  onChange: (tab: LabTab) => void;
}) {
  const items: Array<{ key: LabTab; label: string; icon: React.ReactNode }> = [
    { key: 'overview', label: 'Visão Geral', icon: <Activity size={16} /> },
    { key: 'studio', label: 'Studio de Cenários', icon: <FlaskConical size={16} /> },
    { key: 'coverage', label: 'Cobertura', icon: <Grid3X3 size={16} /> },
    { key: 'history', label: 'Execuções', icon: <History size={16} /> },
    { key: 'regression', label: 'Regressão Oficial', icon: <ShieldCheck size={16} /> }
  ];

  return (
    <div className="table-container" style={{ padding: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {items.map((item) => (
        <button
          key={item.key}
          className={props.active === item.key ? 'btn btn-primary' : 'btn btn-secondary'}
          onClick={() => props.onChange(item.key)}
          style={{ display: 'flex', gap: 7, alignItems: 'center' }}
        >
          {item.icon}{item.label}
        </button>
      ))}
    </div>
  );
}

export function TestLabOverview(props: {
  catalog: LabCatalogData;
  audit: LabAuditData | null;
  history: LabRunData[];
  onNavigate: (tab: LabTab) => void;
}) {
  const latest = props.history[0];
  const latestPassRate = latest ? pct(latest.passed, latest.total_executed) : 0;
  const p0 = latest?.scenario_results?.filter((item) => item.priority === 'P0') ?? [];
  const p0Failed = p0.filter((item) => item.status === 'FAIL').length;
  const p0Gaps = p0.filter((item) => item.status === 'GAP').length;
  const p0Pass = p0.filter((item) => item.status === 'PASS').length;

  const groups = props.catalog.groups.map((group) => {
    const flags = props.catalog.flags.filter((flag) => flag.group === group.key);
    return {
      ...group,
      active: flags.filter((flag) => flag.engine_status === 'ACTIVE').length,
      invariant: flags.filter((flag) => flag.engine_status === 'INVARIANT').length,
      planned: flags.filter((flag) => flag.engine_status === 'PLANNED').length
    };
  });

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section style={labSectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <FlaskConical size={24} />
              <h2 style={{ margin: 0 }}>Laboratório de Testes V2</h2>
            </div>
            <p style={{ margin: '8px 0 0', color: 'var(--text-secondary)', maxWidth: 940 }}>
              Centro de qualidade do motor: regressão oficial, exploração interativa,
              matriz de combinações, cobertura por regra e esperado × obtido.
            </p>
          </div>
          <span className="env-badge teste"><ShieldCheck size={14} /> TEST ONLY</span>
        </div>

        <div className="grid-stats" style={{ marginTop: 20 }}>
          <StatCard label="Regras catalogadas" value={props.catalog.summary.total_flags} hint={String(props.catalog.summary.groups) + ' grupos'} />
          <StatCard label="Motor ativo" value={props.catalog.summary.active} tone="success" hint="Com efeito verificável" />
          <StatCard label="Invariantes" value={props.catalog.summary.invariants} tone="info" hint="Segurança e contratos" />
          <StatCard label="Gaps conhecidos" value={props.catalog.summary.planned} tone={props.catalog.summary.planned ? 'warning' : 'success'} hint="Nunca contam como PASS" />
          <StatCard
            label="Última regressão"
            value={latest ? String(latestPassRate) + '%' : '—'}
            tone={!latest ? undefined : latest.failed || latest.gaps ? 'warning' : 'success'}
            hint={latest ? String(latest.passed) + ' PASS · ' + String(latest.failed) + ' FAIL · ' + String(latest.gaps) + ' GAP' : 'Nenhuma execução'}
          />
        </div>
      </section>

      <section style={labSectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0 }}>Gate P0</h3>
            <p style={{ ...labMuted, margin: '5px 0 0' }}>Qualquer FAIL ou GAP P0 deve bloquear a evolução.</p>
          </div>
          {latest ? (
            p0Failed === 0 && p0Gaps === 0 ? (
              <span className="badge badge-success"><CheckCircle2 size={14} /> P0 saudável</span>
            ) : (
              <span className="badge badge-error"><XCircle size={14} /> {p0Failed} FAIL · {p0Gaps} GAP</span>
            )
          ) : <span className="badge badge-warning">Sem execução</span>}
        </div>
        <div style={{ marginTop: 16, height: 10, background: 'var(--bg-card-hover)', borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ width: String(pct(p0Pass, p0.length)) + '%', height: '100%', background: 'var(--accent-emerald)' }} />
        </div>
      </section>

      <section style={labSectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', marginBottom: 16 }}>
          <div>
            <h3 style={{ margin: 0 }}>Mapa do catálogo</h3>
            <p style={{ ...labMuted, margin: '5px 0 0' }}>Cobertura funcional e lacunas por domínio.</p>
          </div>
          <button className="btn btn-secondary" onClick={() => props.onNavigate('coverage')}>
            <BarChart3 size={15} /> Coverage Center
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 10 }}>
          {groups.map((group) => (
            <div key={group.key} style={{ padding: 14, borderRadius: 10, background: 'var(--bg-card-hover)' }}>
              <strong>{group.label}</strong>
              <div style={{ ...labMuted, marginTop: 4, minHeight: 34 }}>{group.description}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <span className="badge badge-success">{group.active} ativas</span>
                {group.invariant > 0 && <span className="badge badge-info">{group.invariant} invariantes</span>}
                {group.planned > 0 && <span className="badge badge-warning">{group.planned} gaps</span>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section style={labSectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: 0 }}>Explorar antes de alterar o produto</h3>
            <p style={{ ...labMuted, margin: '5px 0 0' }}>
              Monte apólice, documento e regras sintéticas, veja a matriz e execute o motor real.
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => props.onNavigate('studio')}>
            <FlaskConical size={16} /> Abrir Studio
          </button>
        </div>
      </section>

      {props.audit && !props.audit.ok && (
        <section style={{ ...labSectionStyle, borderColor: 'var(--accent-amber)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <AlertTriangle size={20} />
            <div>
              <strong>Auditoria encontrou divergências</strong>
              <div style={{ ...labMuted, marginTop: 5 }}>
                {props.audit.uncatalogued_business_keys.length} chave(s) sem catálogo e{' '}
                {props.audit.catalogued_not_detected_in_backend.length} item(ns) catalogados sem detecção.
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function coverageStatus(flag: LabCatalogFlag, run?: LabRunData) {
  if (flag.engine_status === 'PLANNED') return 'GAP';
  if (!run) return 'NÃO EXECUTADO';
  const results = run.scenario_results?.filter((item) => item.covers_flag_keys.includes(flag.key)) ?? [];
  if (!results.length) return 'NÃO EXECUTADO';
  if (results.some((item) => item.status === 'FAIL')) return 'FAIL';
  if (results.some((item) => item.status === 'GAP')) return 'GAP';
  return 'PASS';
}

export function TestLabCoverageCenter(props: {
  catalog: LabCatalogData;
  currentRun: LabRunData | null;
  history: LabRunData[];
}) {
  const [groupFilter, setGroupFilter] = useState('all');
  const run = props.currentRun ?? props.history[0];
  const rows = props.catalog.flags
    .map((flag) => ({
      flag,
      status: coverageStatus(flag, run),
      scenarios: run?.scenario_results?.filter((item) => item.covers_flag_keys.includes(flag.key)) ?? []
    }))
    .filter((row) => groupFilter === 'all' || row.flag.group === groupFilter);

  const counts = {
    pass: rows.filter((row) => row.status === 'PASS').length,
    fail: rows.filter((row) => row.status === 'FAIL').length,
    gap: rows.filter((row) => row.status === 'GAP').length,
    notRun: rows.filter((row) => row.status === 'NÃO EXECUTADO').length
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section style={labSectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div>
            <h2 style={{ margin: 0 }}>Coverage Center</h2>
            <p style={{ ...labMuted, margin: '5px 0 0' }}>Regra × execução. Ausência nunca vira PASS.</p>
          </div>
          <select className="form-select" style={{ maxWidth: 300 }} value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
            <option value="all">Todos os grupos</option>
            {props.catalog.groups.map((group) => <option key={group.key} value={group.key}>{group.label}</option>)}
          </select>
        </div>
        <div className="grid-stats" style={{ marginTop: 18 }}>
          <StatCard label="PASS" value={counts.pass} tone="success" />
          <StatCard label="FAIL" value={counts.fail} tone={counts.fail ? 'danger' : 'success'} />
          <StatCard label="GAP" value={counts.gap} tone={counts.gap ? 'warning' : 'success'} />
          <StatCard label="Não executado" value={counts.notRun} />
        </div>
      </section>

      <section style={{ ...labSectionStyle, overflowX: 'auto' }}>
        <table className="custom-table">
          <thead>
            <tr><th>Grupo</th><th>Regra</th><th>Motor</th><th>Cobertura</th><th>Cenários</th><th>Fonte</th></tr>
          </thead>
          <tbody>
            {rows.map(({ flag, status, scenarios }) => (
              <tr key={flag.key}>
                <td>{props.catalog.groups.find((group) => group.key === flag.group)?.label ?? flag.group}</td>
                <td>
                  <strong>{flag.label}</strong>
                  <code style={{ display: 'block', ...labMuted }}>{flag.key}</code>
                </td>
                <td>
                  <span className={flag.engine_status === 'ACTIVE' ? 'badge badge-success' : flag.engine_status === 'INVARIANT' ? 'badge badge-info' : 'badge badge-warning'}>
                    {flag.engine_status}
                  </span>
                </td>
                <td>
                  <span className={status === 'PASS' ? 'badge badge-success' : status === 'FAIL' ? 'badge badge-error' : status === 'GAP' ? 'badge badge-warning' : 'badge badge-info'}>
                    {status}
                  </span>
                </td>
                <td>{scenarios.length}</td>
                <td>
                  <div>{flag.source.kind}</div>
                  <code style={labMuted}>{flag.source.path}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export function TestLabHistoryCenter(props: {
  history: LabRunData[];
  onOpen: (id: string) => void;
}) {
  return (
    <section style={labSectionStyle}>
      <h2 style={{ margin: 0 }}>Execuções e regressões</h2>
      <p style={{ ...labMuted, margin: '5px 0 16px' }}>Histórico oficial persistido pelo backend.</p>
      {props.history.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>Nenhuma execução registrada.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="custom-table">
            <thead>
              <tr><th>Execução</th><th>Modo</th><th>PASS</th><th>FAIL</th><th>GAP</th><th>Duração</th><th>Data</th><th></th></tr>
            </thead>
            <tbody>
              {props.history.map((item) => (
                <tr key={item.id}>
                  <td><code>{item.id}</code></td>
                  <td>{item.mode}</td>
                  <td><span className="badge badge-success">{item.passed}</span></td>
                  <td><span className={item.failed ? 'badge badge-error' : 'badge badge-success'}>{item.failed}</span></td>
                  <td><span className={item.gaps ? 'badge badge-warning' : 'badge badge-success'}>{item.gaps}</span></td>
                  <td>{item.duration_ms} ms</td>
                  <td>{new Date(item.created_at).toLocaleString('pt-BR')}</td>
                  <td><button className="btn btn-secondary" onClick={() => props.onOpen(item.id)}>Abrir</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
