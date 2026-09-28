import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, FlaskConical, Layers, RefreshCw, ShieldCheck } from 'lucide-react';
import { ApiClient } from '../services/api';

type EngineStatus = 'ACTIVE' | 'PLANNED' | 'INVARIANT';

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

function StatusBadge({ status }: { status: EngineStatus }) {
  if (status === 'ACTIVE') return <span className="badge badge-success">Motor ativo</span>;
  if (status === 'INVARIANT') return <span className="badge badge-info">Invariante</span>;
  return <span className="badge badge-warning">Planejada / gap</span>;
}

export function TestLabCatalog() {
  const [catalog, setCatalog] = useState<TestLabCatalogData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string>('all');

  const load = async () => {
    setLoading(true);
    setError('');
    const response = await ApiClient.getTestLabCatalog();
    if (response?.status === 'sucesso' && response.catalog) {
      setCatalog(response.catalog);
    } else {
      setError(response?.mensagem || 'Não foi possível carregar o catálogo do Laboratório de Testes.');
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const visibleFlags = useMemo(() => {
    if (!catalog) return [];
    if (selectedGroup === 'all') return catalog.flags;
    return catalog.flags.filter((flag) => flag.group === selectedGroup);
  }, [catalog, selectedGroup]);

  if (loading) {
    return (
      <div className="table-container" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <RefreshCw size={18} className="spin" />
          <span>Carregando catálogo de testes...</span>
        </div>
      </div>
    );
  }

  if (!catalog || error) {
    return (
      <div className="table-container" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--accent-red, #e05252)' }}>
          <AlertTriangle size={18} />
          <strong>{error || 'Catálogo indisponível.'}</strong>
        </div>
        <button className="btn btn-secondary" style={{ marginTop: '12px' }} onClick={load}>
          <RefreshCw size={14} /> Tentar novamente
        </button>
      </div>
    );
  }

  return (
    <>
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
              Catálogo dinâmico das regras, flags, invariantes de segurança e dimensões que serão usadas pelo runner
              automático. Novas flags são incluídas no catálogo e passam a aparecer nesta interface sem criar tela
              específica para cada uma.
            </p>
          </div>
          <span className="env-badge teste">
            <ShieldCheck size={14} /> TEST ONLY
          </span>
        </div>

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
            <span className="stat-label">Gaps mapeados</span>
            <span className="stat-value">{catalog.summary.planned}</span>
          </div>
        </div>

        <div style={{
          marginTop: '20px',
          padding: '14px 16px',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-card-hover)',
          fontSize: '0.82rem',
          color: 'var(--text-secondary)'
        }}>
          <strong style={{ color: 'var(--text-primary)' }}>Contrato de extensão:</strong>{' '}
          {catalog.extension_contract.description}
        </div>
      </div>

      <div className="table-container" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
          <Layers size={18} />
          <h3 style={{ margin: 0, fontSize: '1rem' }}>Suítes prioritárias</h3>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '12px' }}>
          {catalog.suites.map((suite) => (
            <div key={suite.key} style={{
              background: 'var(--bg-card-hover)',
              borderRadius: 'var(--radius-sm)',
              padding: '14px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', marginBottom: '8px' }}>
                <strong>{suite.label}</strong>
                <span className="badge badge-error">{suite.priority}</span>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                {suite.description}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                {suite.flag_keys.length} dimensões/regras vinculadas
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="table-container" style={{ padding: '24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem' }}>Catálogo de regras e flags</h3>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '4px' }}>
              Fonte única usada futuramente pelo construtor de cenários e pelo runner.
            </div>
          </div>
          <select
            className="form-select"
            style={{ width: '300px' }}
            value={selectedGroup}
            onChange={(event) => setSelectedGroup(event.target.value)}
          >
            <option value="all">Todos os grupos</option>
            {catalog.groups.map((group) => (
              <option key={group.key} value={group.key}>{group.label}</option>
            ))}
          </select>
        </div>

        <table className="custom-table">
          <thead>
            <tr>
              <th>Regra / Flag</th>
              <th>Tipo</th>
              <th>Status</th>
              <th>Geração</th>
              <th>Origem técnica</th>
            </tr>
          </thead>
          <tbody>
            {visibleFlags.map((flag) => (
              <tr key={flag.key}>
                <td>
                  <strong>{flag.label}</strong>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '3px' }}>
                    {flag.description}
                  </div>
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

        {visibleFlags.length === 0 && (
          <div style={{ padding: '20px', color: 'var(--text-muted)', textAlign: 'center' }}>
            Nenhuma regra neste grupo.
          </div>
        )}
      </div>

      <div className="table-container" style={{ padding: '18px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px', fontSize: '0.82rem' }}>
          <CheckCircle2 size={16} />
          <span>
            Próxima etapa do laboratório: construtor de cenários, geração automática de combinações/bordas e relatório
            PASS/FAIL por suíte. O simulador de carga atual permanece disponível abaixo.
          </span>
        </div>
      </div>
    </>
  );
}
