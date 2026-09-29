import React, { useState } from 'react';
import { ApiClient } from '../services/api';

type Selection = { mode: 'QUICK' | 'STANDARD' | 'EXHAUSTIVE'; suite_keys: string[]; selected_flag_keys?: string[] };
type Preset = { name: string; selection: Selection };
const storageKey = 'arckatech.testLab.presets.v1';
export function TestLabPresets({ selection, apply }: { selection: Selection; apply: (value: Selection) => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [presets, setPresets] = useState<Preset[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
      return Array.isArray(saved) ? saved.filter(p => typeof p.name === 'string' && Array.isArray(p.selection?.suite_keys) && ['QUICK','STANDARD','EXHAUSTIVE'].includes(p.selection?.mode)) : [];
    } catch { return []; }
  });
  const update = (items: Preset[]) => {
    try { localStorage.setItem(storageKey, JSON.stringify(items)); setPresets(items); setError(''); }
    catch { setError('Não foi possível salvar neste navegador.'); }
  };
  return <section className="table-container" style={{ padding: 24 }}>
    <h3>Presets e suítes customizadas</h3>
    <p>Salve a seleção de suítes, regras e modo neste navegador.</p>
    <input aria-label="Nome do preset" className="form-input" maxLength={80} value={name} onChange={e => setName(e.target.value)} />
    <button className="btn btn-secondary" disabled={!name.trim() || !selection.suite_keys.length} onClick={() => update([...presets.filter(p => p.name !== name.trim()), { name: name.trim(), selection }])}>Salvar preset</button>
    {error && <p role="alert">{error}</p>}
    {presets.map(p => <div key={p.name} style={{ display: 'flex', gap: 12, marginTop: 10 }}>
      <strong>{p.name}</strong>
      <button className="btn btn-secondary" onClick={() => apply(p.selection)}>Aplicar {p.name}</button>
      <button className="btn btn-secondary" onClick={() => update(presets.filter(item => item.name !== p.name))}>Excluir {p.name}</button>
    </div>)}
  </section>;
}

type Result = { id: string; status: string; covers_flag_keys: string[]; error?: string; assertions: unknown[] };
type Run = { id: string; scenario_results: Result[] };
type Flag = { key: string; label: string; engine_status: string };
function download(name: string, content: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function TestLabAnalysis({ run, flags, history }: { run: Run; flags: Flag[]; history: { id: string }[] }) {
  const [baseline, setBaseline] = useState<Run | null>(null);
  const [error, setError] = useState('');
  const coverage = flags.map(flag => {
    const results = run.scenario_results.filter(r => r.covers_flag_keys.includes(flag.key));
    const status = flag.engine_status === 'PLANNED' ? 'GAP' : !results.length ? 'NÃO EXECUTADO' : results.some(r => r.status === 'FAIL') ? 'FAIL' : results.some(r => r.status === 'GAP') ? 'GAP' : 'PASS';
    return { key: flag.key, label: flag.label, status, scenarios: results.map(r => r.id) };
  });
  const oldResults = new Map((baseline?.scenario_results ?? []).map(r => [r.id, r]));
  const newResults = new Map(run.scenario_results.map(r => [r.id, r]));
  const changes = baseline ? [...new Set([...oldResults.keys(), ...newResults.keys()])].map(id => ({ id, before: oldResults.get(id)?.status ?? 'AUSENTE', after: newResults.get(id)?.status ?? 'AUSENTE' })).filter(c => c.before !== c.after) : [];
  return <section className="table-container" style={{ padding: 24 }}>
    <h3>Cobertura do catálogo e gaps</h3>
    <p>{coverage.filter(c => c.status === 'PASS').length} de {coverage.length} regras com todos os cenários executados aprovados nesta execução. Regras não executadas não contam como PASS.</p>
    <button className="btn btn-secondary" onClick={() => download(run.id + '.json', run)}>Exportar JSON detalhado</button>
    <button className="btn btn-secondary" onClick={() => download(run.id + '-gaps.json', { run_id: run.id, coverage, gaps: run.scenario_results.filter(r => r.status === 'GAP') })}>Exportar cobertura e gaps</button>
    <details><summary>Inspecionar cobertura por regra</summary><table className="custom-table"><thead><tr><th>Regra</th><th>Resultado</th><th>Cenários</th></tr></thead><tbody>{coverage.map(c => <tr key={c.key}><td>{c.label}</td><td>{c.status}</td><td>{c.scenarios.length}</td></tr>)}</tbody></table></details>
    <h3>Comparação de execuções</h3>
    <select aria-label="Execução de referência" className="form-select" value={baseline?.id ?? ''} onChange={async e => {
      const id = e.target.value;
      setBaseline(null); setError('');
      if (!id) return;
      const response = await ApiClient.getTestLabRun(id);
      if (response?.run) setBaseline(response.run); else setError(response?.mensagem || 'Falha ao carregar referência.');
    }}><option value="">Selecione a referência</option>{history.filter(h => h.id !== run.id).map(h => <option key={h.id} value={h.id}>{h.id}</option>)}</select>
    {error && <p role="alert">{error}</p>}
    {baseline && <><p>{changes.length} mudança(s) de resultado; cenários adicionados e removidos aparecem como AUSENTE.</p><table className="custom-table"><thead><tr><th>Cenário</th><th>Referência</th><th>Atual</th></tr></thead><tbody>{changes.map(c => <tr key={c.id}><td>{c.id}</td><td>{c.before}</td><td>{c.after}</td></tr>)}</tbody></table></>}
  </section>;
}
