import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  FlaskConical,
  Grid3X3,
  Layers3,
  Play,
  RefreshCw,
  Settings2,
  Trash2
} from 'lucide-react';
import { ApiClient } from '../services/api';
import {
  LabCatalogData,
  labMuted,
  labSectionStyle
} from './TestLabV2Panels';

type Primitive = string | number | boolean | null;

interface Capability {
  key: string;
  label: string;
  group: string;
  description: string;
  engine_status: 'ACTIVE' | 'PLANNED' | 'INVARIANT';
  value_type: string;
  generation: string;
  interactive: boolean;
  control: 'BOOLEAN' | 'ENUM' | 'NUMBER' | 'DATE' | 'STRING' | 'MULTISELECT' | 'OFFICIAL_ONLY';
  options?: Array<{ value: Primitive; label: string }>;
  suggested_values?: Primitive[];
  reason?: string;
}

interface StudioCapabilities {
  version: string;
  max_cases: number;
  default_reference_date: string;
  capabilities: Capability[];
  interactive_count: number;
  official_only_count: number;
}

interface StudioPreview {
  name: string;
  strategy: 'SINGLE' | 'PAIRWISE' | 'CARTESIAN';
  reference_date: string;
  cartesian_estimate: number;
  cases: number;
  preview: Array<Record<string, Primitive>>;
  truncated_preview: boolean;
}

interface StudioRun {
  id: string;
  name: string;
  strategy: string;
  reference_date: string;
  cases: number;
  passed: number;
  failed: number;
  duration_ms: number;
  results: Array<{
    index: number;
    assignment: Record<string, Primitive>;
    status: 'PASS' | 'FAIL';
    duration_ms: number;
    actual: {
      status: string;
      codigo: string;
      matched_policy?: string;
      policy_id?: string;
      mensagem: string;
      valor_considerado_averbacao?: number;
      regras_internas_aplicadas?: string[];
      variaveis_faltantes?: string[];
    };
    assertions: Array<{
      key: string;
      expected: unknown;
      actual: unknown;
      pass: boolean;
    }>;
  }>;
}

function primitiveFromText(value: string, control: Capability['control']): Primitive {
  if (control === 'NUMBER') {
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return value;
}

function ValuesEditor(props: {
  capability: Capability;
  values: Primitive[];
  onChange: (values: Primitive[]) => void;
}) {
  const cap = props.capability;

  if (cap.control === 'BOOLEAN') {
    return (
      <div style={{ display: 'flex', gap: 12 }}>
        {[false, true].map((value) => (
          <label key={String(value)} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={props.values.includes(value)}
              onChange={(event) => {
                const next = event.target.checked
                  ? Array.from(new Set([...props.values, value]))
                  : props.values.filter((item) => item !== value);
                props.onChange(next.length ? next : [value]);
              }}
            />
            {value ? 'Ligado' : 'Desligado'}
          </label>
        ))}
      </div>
    );
  }

  if ((cap.control === 'ENUM' || cap.control === 'MULTISELECT') && cap.options?.length) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
        {cap.options.map((option) => {
          const key = JSON.stringify(option.value);
          const checked = props.values.some((item) => JSON.stringify(item) === key);
          return (
            <label
              key={key}
              style={{
                padding: '6px 8px',
                border: '1px solid var(--border-color)',
                borderRadius: 8,
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                background: checked ? 'var(--bg-card)' : 'transparent'
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...props.values, option.value]
                    : props.values.filter((item) => JSON.stringify(item) !== key);
                  props.onChange(next.length ? next : [option.value]);
                }}
              />
              {option.label}
            </label>
          );
        })}
      </div>
    );
  }

  return (
    <input
      className="form-input"
      value={props.values.map((value) => String(value ?? '')).join(', ')}
      placeholder={cap.control === 'DATE' ? 'ISO dates separadas por vírgula' : 'Valores separados por vírgula'}
      onChange={(event) => {
        const pieces = event.target.value.split(',').map((item) => item.trim()).filter(Boolean);
        props.onChange(pieces.length ? pieces.map((item) => primitiveFromText(item, cap.control)) : ['']);
      }}
    />
  );
}

export function TestLabStudioV2(props: { catalog: LabCatalogData }) {
  const [studio, setStudio] = useState<StudioCapabilities | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, Primitive[]>>({});
  const [strategy, setStrategy] = useState<'SINGLE' | 'PAIRWISE' | 'CARTESIAN'>('PAIRWISE');
  const [name, setName] = useState('Cenário de negócio');
  const [referenceDate, setReferenceDate] = useState('2026-09-29T12:00:00.000-03:00');
  const [ramo, setRamo] = useState('RCTRC');
  const [matchingMode, setMatchingMode] = useState<'AUTO' | 'EXPLICIT'>('EXPLICIT');
  const [secondaryEnabled, setSecondaryEnabled] = useState(false);
  const [secondaryStart, setSecondaryStart] = useState('2026-01-01T00:00:00.000-03:00');
  const [secondaryEnd, setSecondaryEnd] = useState('2026-12-31T23:59:59.999-03:00');
  const [observation, setObservation] = useState('');
  const [supplementedJson, setSupplementedJson] = useState('{}');
  const [includeCoverage, setIncludeCoverage] = useState(false);
  const [expectedStatus, setExpectedStatus] = useState('');
  const [expectedCode, setExpectedCode] = useState('');
  const [expectedPolicy, setExpectedPolicy] = useState('');
  const [preview, setPreview] = useState<StudioPreview | null>(null);
  const [run, setRun] = useState<StudioRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    ApiClient.getTestLabStudioCapabilities().then((response) => {
      if (response?.status !== 'sucesso' || !response.studio) {
        setError(response?.mensagem || 'Não foi possível carregar o Studio.');
        return;
      }

      const next = response.studio as StudioCapabilities;
      setStudio(next);
      setReferenceDate(next.default_reference_date);

      const defaults = [
        'policy.status',
        'policy.lmi',
        'policy.vigencia_inicio',
        'policy.vigencia_fim',
        'document.tipo',
        'document.valor_carga',
        'document.tp_amb',
        'document.funcao_cnpj_segurado',
        'ingestion.channel'
      ].filter((key) => next.capabilities.some((item) => item.key === key && item.interactive));

      setSelectedKeys(defaults);
      setValues(Object.fromEntries(defaults.map((key) => {
        const cap = next.capabilities.find((item) => item.key === key)!;
        let chosen: Primitive[] = cap.suggested_values?.length ? [cap.suggested_values[0]!] : [''];
        if (key === 'policy.status') chosen = ['ATIVA'];
        if (key === 'policy.lmi') chosen = [100000];
        if (key === 'policy.vigencia_inicio') chosen = ['2026-01-01T00:00:00.000-03:00'];
        if (key === 'policy.vigencia_fim') chosen = ['2026-12-31T23:59:59.999-03:00'];
        if (key === 'document.tipo') chosen = ['CTE'];
        if (key === 'document.valor_carga') chosen = [1000];
        if (key === 'document.tp_amb') chosen = [2];
        if (key === 'document.funcao_cnpj_segurado') chosen = ['EMISSOR'];
        if (key === 'ingestion.channel') chosen = ['INTERNAL'];
        return [key, chosen];
      })));
    });
  }, []);

  const capabilities = studio?.capabilities ?? [];
  const interactive = capabilities.filter((item) => item.interactive);
  const available = interactive.filter((item) => !selectedKeys.includes(item.key));

  const grouped = useMemo(() => {
    return props.catalog.groups.map((group) => ({
      group,
      items: selectedKeys
        .map((key) => capabilities.find((item) => item.key === key))
        .filter((item): item is Capability => Boolean(item) && item!.group === group.key)
    })).filter((row) => row.items.length);
  }, [props.catalog.groups, selectedKeys, capabilities]);

  const payload = () => {
    let supplemented: Record<string, unknown> = {};
    if (supplementedJson.trim()) {
      const parsed = JSON.parse(supplementedJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) supplemented = parsed;
    }

    return {
      name,
      strategy,
      reference_date: referenceDate,
      max_cases: studio?.max_cases ?? 100,
      dimensions: selectedKeys.map((key) => ({ key, values: values[key] ?? [] })),
      fixture: {
        ramo,
        matching_mode: matchingMode,
        observation_text: observation || undefined,
        supplemented_vars: supplemented,
        include_coverage_in_document: includeCoverage,
        secondary_policy: {
          enabled: secondaryEnabled,
          vigencia_inicio: secondaryStart,
          vigencia_fim: secondaryEnd
        }
      },
      expectation: {
        status: expectedStatus || undefined,
        codigo: expectedCode || undefined,
        matched_policy: expectedPolicy || undefined
      }
    };
  };

  const calculate = async () => {
    setLoading(true);
    setError('');
    setRun(null);
    try {
      const response = await ApiClient.previewTestLabStudio(payload());
      if (response?.status === 'sucesso') setPreview(response.preview);
      else setError(response?.mensagem || 'Falha ao calcular a matriz.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Configuração inválida.');
    } finally {
      setLoading(false);
    }
  };

  const execute = async () => {
    setRunning(true);
    setError('');
    try {
      const response = await ApiClient.executeTestLabStudio(payload());
      if (response?.status === 'sucesso') {
        setRun(response.run);
        if (!preview) {
          const p = await ApiClient.previewTestLabStudio(payload());
          if (p?.status === 'sucesso') setPreview(p.preview);
        }
      } else {
        setError(response?.mensagem || 'Falha ao executar o cenário.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Configuração inválida.');
    } finally {
      setRunning(false);
    }
  };

  if (!studio) {
    return <section style={labSectionStyle}><RefreshCw size={18} className="spin" /> Carregando Studio...</section>;
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section style={labSectionStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 18, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <FlaskConical size={22} />
              <h2 style={{ margin: 0 }}>Studio de Cenários</h2>
            </div>
            <p style={{ margin: '6px 0 0', color: 'var(--text-secondary)', maxWidth: 900 }}>
              Configure dimensões do catálogo. O backend cria um contexto sintético isolado,
              gera o documento e chama o pipeline real de ingestão e averbação.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <span className="badge badge-success">{studio.interactive_count} interativas</span>
            <span className="badge badge-info">{studio.official_only_count} oficiais</span>
          </div>
        </div>
      </section>

      {error && (
        <section style={{ ...labSectionStyle, borderColor: 'var(--accent-red)' }}>
          <AlertTriangle size={16} style={{ marginRight: 8 }} />{error}
        </section>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(300px, 1fr)', gap: 16 }}>
        <div style={{ display: 'grid', gap: 16 }}>
          <section style={labSectionStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0 }}>1. Dimensões</h3>
                <p style={{ ...labMuted, margin: '4px 0 0' }}>Múltiplos valores alimentam a matriz.</p>
              </div>
              <select
                className="form-select"
                style={{ maxWidth: 330 }}
                value=""
                onChange={(event) => {
                  const key = event.target.value;
                  if (!key) return;
                  const cap = capabilities.find((item) => item.key === key);
                  if (!cap) return;
                  setSelectedKeys([...selectedKeys, key]);
                  const suggested = cap.suggested_values?.filter((item) => item !== null) ?? [];
                  setValues({ ...values, [key]: suggested.length ? [suggested[0]!] : [''] });
                  setPreview(null);
                }}
              >
                <option value="">+ Adicionar regra</option>
                {available.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
            </div>

            <div style={{ display: 'grid', gap: 18 }}>
              {grouped.map((row) => (
                <div key={row.group.key}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                    <Layers3 size={15} /><strong>{row.group.label}</strong>
                    <span style={labMuted}>{row.items.length} dimensão(ões)</span>
                  </div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {row.items.map((cap) => (
                      <div key={cap.key} style={{ padding: 12, border: '1px solid var(--border-color)', borderRadius: 10, background: 'var(--bg-card-hover)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                          <div>
                            <strong>{cap.label}</strong>
                            <code style={{ display: 'block', ...labMuted, marginTop: 3 }}>{cap.key}</code>
                          </div>
                          <button className="btn btn-secondary" onClick={() => {
                            setSelectedKeys(selectedKeys.filter((key) => key !== cap.key));
                            setPreview(null);
                          }}><Trash2 size={14} /></button>
                        </div>
                        <p style={{ ...labMuted, margin: '8px 0' }}>{cap.description}</p>
                        <ValuesEditor capability={cap} values={values[cap.key] ?? []} onChange={(next) => {
                          setValues({ ...values, [cap.key]: next });
                          setPreview(null);
                        }} />
                        {cap.suggested_values && cap.suggested_values.length > 1 && (
                          <button className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => {
                            setValues({ ...values, [cap.key]: cap.suggested_values!.filter((item) => item !== null) });
                            setPreview(null);
                          }}>
                            Usar valores do catálogo
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section style={labSectionStyle}>
            <h3 style={{ marginTop: 0 }}>2. Fixture e matching</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <div className="form-group"><label className="form-label">Nome</label><input className="form-input" value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="form-group"><label className="form-label">Data de referência</label><input className="form-input" value={referenceDate} onChange={(e) => setReferenceDate(e.target.value)} /></div>
              <div className="form-group">
                <label className="form-label">Ramo</label>
                <select className="form-select" value={ramo} onChange={(e) => setRamo(e.target.value)}>
                  <option value="RCTRC">RCTR-C</option><option value="RCDC">RC-DC</option><option value="RCV">RC-V</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Seleção da apólice</label>
                <select className="form-select" value={matchingMode} onChange={(e) => setMatchingMode(e.target.value as 'AUTO' | 'EXPLICIT')}>
                  <option value="EXPLICIT">Policy explícita</option><option value="AUTO">Matching automático</option>
                </select>
              </div>
            </div>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
              <input type="checkbox" checked={secondaryEnabled} onChange={(e) => setSecondaryEnabled(e.target.checked)} />
              Criar Policy B / Seguradora B para renovação ou sobreposição
            </label>
            {secondaryEnabled && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
                <div className="form-group"><label className="form-label">Início Policy B</label><input className="form-input" value={secondaryStart} onChange={(e) => setSecondaryStart(e.target.value)} /></div>
                <div className="form-group"><label className="form-label">Fim Policy B</label><input className="form-input" value={secondaryEnd} onChange={(e) => setSecondaryEnd(e.target.value)} /></div>
              </div>
            )}

            <div className="form-group" style={{ marginTop: 12 }}>
              <label className="form-label">OBS do documento</label>
              <textarea className="form-input" rows={3} value={observation} onChange={(e) => setObservation(e.target.value)} placeholder="PLACA=ABC1D23; MOTORISTA=12345678901" />
            </div>
            <div className="form-group" style={{ marginTop: 12 }}>
              <label className="form-label">Variáveis suplementares JSON</label>
              <textarea className="form-input" rows={3} value={supplementedJson} onChange={(e) => setSupplementedJson(e.target.value)} />
            </div>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
              <input type="checkbox" checked={includeCoverage} onChange={(e) => setIncludeCoverage(e.target.checked)} />
              Incluir valor da cobertura Studio no documento
            </label>
          </section>

          <section style={labSectionStyle}>
            <h3 style={{ marginTop: 0 }}>3. Esperado × obtido</h3>
            <p style={{ ...labMuted, marginTop: -6 }}>Sem expectativa o Studio explora. Com expectativa cada caso vira PASS/FAIL.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">Status esperado</label>
                <select className="form-select" value={expectedStatus} onChange={(e) => setExpectedStatus(e.target.value)}>
                  <option value="">Não validar</option><option value="sucesso">Sucesso</option><option value="aviso">Aviso</option><option value="pendente">Pendente</option><option value="erro">Erro</option>
                </select>
              </div>
              <div className="form-group"><label className="form-label">Código esperado</label><input className="form-input" value={expectedCode} onChange={(e) => setExpectedCode(e.target.value)} placeholder="SUC-2000 / ERR-4021" /></div>
              <div className="form-group">
                <label className="form-label">Policy esperada</label>
                <select className="form-select" value={expectedPolicy} onChange={(e) => setExpectedPolicy(e.target.value)}>
                  <option value="">Não validar</option><option value="PRIMARY">Seguradora A</option><option value="SECONDARY">Seguradora B</option>
                </select>
              </div>
            </div>
          </section>
        </div>

        <aside>
          <section style={{ ...labSectionStyle, position: 'sticky', top: 16 }}>
            <h3 style={{ marginTop: 0 }}>Matrix Builder</h3>
            <div className="form-group">
              <label className="form-label">Estratégia</label>
              <select className="form-select" value={strategy} onChange={(e) => { setStrategy(e.target.value as 'SINGLE' | 'PAIRWISE' | 'CARTESIAN'); setPreview(null); }}>
                <option value="SINGLE">Um caso</option><option value="PAIRWISE">Pairwise</option><option value="CARTESIAN">Cartesiano</option>
              </select>
            </div>

            <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={labMuted}>Dimensões</span><strong>{selectedKeys.length}</strong></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={labMuted}>Cartesiano</span><strong>{preview?.cartesian_estimate ?? '—'}</strong></div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={labMuted}>Casos</span><strong>{preview?.cases ?? '—'}</strong></div>
            </div>

            <button className="btn btn-secondary" style={{ width: '100%', marginTop: 14 }} disabled={loading || running} onClick={calculate}>
              {loading ? <RefreshCw size={15} className="spin" /> : <Grid3X3 size={15} />}{loading ? 'Calculando...' : 'Visualizar matriz'}
            </button>
            <button className="btn btn-primary" style={{ width: '100%', marginTop: 8 }} disabled={running || loading} onClick={execute}>
              {running ? <RefreshCw size={15} className="spin" /> : <Play size={15} />}{running ? 'Executando...' : 'Executar matriz'}
            </button>

            {preview && (
              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: 'pointer' }}>Primeiras combinações</summary>
                <div style={{ display: 'grid', gap: 6, marginTop: 8, maxHeight: 360, overflow: 'auto' }}>
                  {preview.preview.slice(0, 10).map((row, index) => (
                    <pre key={index} style={{ padding: 8, borderRadius: 8, background: 'var(--bg-card-hover)', whiteSpace: 'pre-wrap', fontSize: '0.68rem' }}>{JSON.stringify(row, null, 2)}</pre>
                  ))}
                </div>
              </details>
            )}
          </section>
        </aside>
      </div>

      {run && (
        <section style={labSectionStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <div><h3 style={{ margin: 0 }}>Execution Center — {run.name}</h3><div style={{ ...labMuted, marginTop: 4 }}>{run.id} · {run.strategy} · {run.duration_ms} ms</div></div>
            <div style={{ display: 'flex', gap: 8 }}><span className="badge badge-success">{run.passed} PASS</span><span className={run.failed ? 'badge badge-error' : 'badge badge-success'}>{run.failed} FAIL</span></div>
          </div>
          <div style={{ overflowX: 'auto', marginTop: 16 }}>
            <table className="custom-table">
              <thead><tr><th>Caso</th><th>Resultado</th><th>Status</th><th>Código</th><th>Policy</th><th>Tempo</th><th>Detalhes</th></tr></thead>
              <tbody>
                {run.results.map((result) => (
                  <tr key={result.index}>
                    <td>#{result.index + 1}</td>
                    <td><span className={result.status === 'PASS' ? 'badge badge-success' : 'badge badge-error'}>{result.status}</span></td>
                    <td>{result.actual.status}</td>
                    <td><code>{result.actual.codigo}</code></td>
                    <td>{result.actual.matched_policy ?? '—'}</td>
                    <td>{result.duration_ms} ms</td>
                    <td>
                      <details>
                        <summary style={{ cursor: 'pointer' }}>abrir</summary>
                        <div style={{ minWidth: 420, maxWidth: 720, padding: 10 }}>
                          <strong>Entrada</strong><pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.72rem' }}>{JSON.stringify(result.assignment, null, 2)}</pre>
                          {result.assertions.length > 0 && <><strong>Esperado × obtido</strong><pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.72rem' }}>{JSON.stringify(result.assertions, null, 2)}</pre></>}
                          <strong>Motor</strong><pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.72rem' }}>{JSON.stringify(result.actual, null, 2)}</pre>
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section style={labSectionStyle}>
        <details>
          <summary style={{ cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }}><Settings2 size={16} /> Regras cobertas apenas pela regressão oficial</summary>
          <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            {capabilities.filter((item) => !item.interactive).map((item) => (
              <div key={item.key} style={{ padding: 10, borderRadius: 8, background: 'var(--bg-card-hover)' }}>
                <strong>{item.label}</strong><code style={{ display: 'block', ...labMuted }}>{item.key}</code><div style={{ ...labMuted, marginTop: 4 }}>{item.reason}</div>
              </div>
            ))}
          </div>
        </details>
      </section>
    </div>
  );
}
