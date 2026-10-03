import React, { useMemo, useState } from 'react';
import {
  Building2,
  Mail,
  Plus,
  Power,
  RefreshCw,
  Search,
  Users,
  X
} from 'lucide-react';
import {
  EcosystemApi,
  EcosystemEntityType,
  EcosystemPartner
} from '../services/ecosystemApi';

const typeLabels: Record<EcosystemEntityType, string> = {
  SEGURADORA: 'Seguradora',
  CORRETORA: 'Corretora / Co-corretora',
  ASSESSORIA: 'Assessoria',
  AMBOS: 'Corretora + Assessoria'
};

const emptyForm = {
  entity_type: 'CORRETORA' as EcosystemEntityType,
  cnpj: '',
  razao_social: '',
  nome_fantasia: '',
  admin_nome: '',
  admin_email: ''
};

export function EcosystemRegistryLauncher() {
  const [open, setOpen] = useState(false);
  const [partners, setPartners] = useState<EcosystemPartner[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [filter, setFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState<'TODOS' | EcosystemEntityType>('TODOS');
  const [form, setForm] = useState(emptyForm);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const response = await EcosystemApi.list();
      if (response.status !== 'sucesso') {
        setError(response.mensagem || 'Não foi possível carregar o cadastro do ecossistema.');
        return;
      }
      setPartners(response.partners || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const openRegistry = async () => {
    setOpen(true);
    await load();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setMessage('');

    if (!form.cnpj.trim() || !form.razao_social.trim()) {
      setError('Informe CNPJ e Razão Social.');
      return;
    }

    setSaving(true);
    try {
      const response = await EcosystemApi.create({
        entity_type: form.entity_type,
        cnpj: form.cnpj.trim(),
        razao_social: form.razao_social.trim(),
        nome_fantasia: form.nome_fantasia.trim() || undefined,
        admin_nome: form.admin_nome.trim() || undefined,
        admin_email: form.admin_email.trim() || undefined
      });

      if (response.status !== 'sucesso') {
        setError(response.mensagem || 'Falha ao cadastrar a empresa.');
        return;
      }

      setForm(emptyForm);
      setMessage(`${typeLabels[response.partner.entity_type as EcosystemEntityType]} cadastrada com sucesso.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (partner: EcosystemPartner) => {
    setError('');
    setMessage('');
    const next = partner.status === 'ATIVO' ? 'INATIVO' : 'ATIVO';
    const response = await EcosystemApi.update(partner.kind, partner.id, { status: next });
    if (response.status !== 'sucesso') {
      setError(response.mensagem || 'Não foi possível alterar o status.');
      return;
    }
    setMessage(`${partner.razao_social}: ${next}.`);
    await load();
  };

  const changePartnerType = async (
    partner: EcosystemPartner,
    entityType: 'CORRETORA' | 'ASSESSORIA' | 'AMBOS'
  ) => {
    const response = await EcosystemApi.update(partner.kind, partner.id, {
      entity_type: entityType
    });
    if (response.status !== 'sucesso') {
      setError(response.mensagem || 'Não foi possível alterar o tipo do parceiro.');
      return;
    }
    setMessage(`${partner.razao_social}: tipo atualizado para ${typeLabels[entityType]}.`);
    await load();
  };

  const resendInvitation = async (partner: EcosystemPartner) => {
    let email = partner.admin_email || '';
    let name = partner.admin_nome || partner.razao_social;
    if (!email) {
      email = window.prompt('E-mail do administrador/responsável:', '') || '';
      if (!email) return;
      name = window.prompt('Nome do administrador/responsável:', name) || name;
    }

    const response = await EcosystemApi.resendInvitation(partner.kind, partner.id, {
      admin_email: email,
      admin_nome: name
    });
    if (response.status !== 'sucesso') {
      setError(response.mensagem || 'Não foi possível reenviar o convite.');
      return;
    }
    setMessage(`Convite reenviado para ${email}.`);
    await load();
  };

  const filtered = useMemo(() => {
    const search = filter.trim().toLowerCase();
    return partners.filter((partner) => {
      if (typeFilter !== 'TODOS' && partner.entity_type !== typeFilter) return false;
      if (!search) return true;
      return [partner.razao_social, partner.nome_fantasia, partner.cnpj, partner.admin_email]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(search));
    });
  }, [partners, filter, typeFilter]);

  const counts = useMemo(() => ({
    total: partners.length,
    seguradoras: partners.filter((item) => item.entity_type === 'SEGURADORA').length,
    corretoras: partners.filter((item) => item.entity_type === 'CORRETORA' || item.entity_type === 'AMBOS').length,
    assessorias: partners.filter((item) => item.entity_type === 'ASSESSORIA' || item.entity_type === 'AMBOS').length
  }), [partners]);

  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        onClick={openRegistry}
        style={{
          position: 'fixed',
          right: 24,
          bottom: 24,
          zIndex: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          boxShadow: '0 10px 32px rgba(0,0,0,0.28)'
        }}
        title="Cadastrar seguradoras, corretoras, co-corretoras e assessorias"
      >
        <Building2 size={17} /> Cadastro do Ecossistema
      </button>

      {open && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100,
            background: 'rgba(0,0,0,0.72)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20
          }}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpen(false);
          }}
        >
          <div
            className="table-container"
            style={{
              width: 'min(1400px, 96vw)',
              maxHeight: '92vh',
              overflow: 'auto',
              padding: 24,
              background: 'var(--bg-primary, #101215)'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ margin: 0, display: 'flex', gap: 9, alignItems: 'center' }}>
                  <Building2 size={23} /> Cadastro do Ecossistema
                </h2>
                <p style={{ margin: '7px 0 0', color: 'var(--text-secondary)', maxWidth: 900 }}>
                  Cadastre empresas que participam da operação. Uma co-corretora usa o mesmo cadastro de
                  Corretora: “co-corretora” é o papel que ela assume na apólice, não uma empresa duplicada.
                </p>
              </div>
              <button className="btn btn-secondary" onClick={() => setOpen(false)} aria-label="Fechar cadastro do ecossistema">
                <X size={17} />
              </button>
            </div>

            <div className="grid-stats" style={{ marginTop: 18 }}>
              <div className="card-stat"><span className="stat-label">Empresas</span><span className="stat-value">{counts.total}</span></div>
              <div className="card-stat"><span className="stat-label">Seguradoras</span><span className="stat-value">{counts.seguradoras}</span></div>
              <div className="card-stat"><span className="stat-label">Corretoras / Co</span><span className="stat-value">{counts.corretoras}</span></div>
              <div className="card-stat"><span className="stat-label">Assessorias</span><span className="stat-value">{counts.assessorias}</span></div>
            </div>

            {error && (
              <div style={{ marginTop: 14, padding: 12, borderRadius: 8, border: '1px solid var(--accent-red)', color: 'var(--accent-red)' }}>
                {error}
              </div>
            )}
            {message && (
              <div style={{ marginTop: 14, padding: 12, borderRadius: 8, border: '1px solid var(--accent-emerald)', color: 'var(--accent-emerald)' }}>
                {message}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 0.8fr) minmax(0, 1.7fr)', gap: 22, marginTop: 20 }}>
              <form onSubmit={submit} style={{ padding: 18, border: '1px solid var(--border-color)', borderRadius: 12, alignSelf: 'start' }}>
                <h3 style={{ marginTop: 0 }}>Nova empresa</h3>
                <div className="form-group">
                  <label className="form-label">Tipo de cadastro</label>
                  <select className="form-select" value={form.entity_type} onChange={(event) => setForm({ ...form, entity_type: event.target.value as EcosystemEntityType })}>
                    <option value="SEGURADORA">Seguradora</option>
                    <option value="CORRETORA">Corretora / pode atuar como co-corretora</option>
                    <option value="ASSESSORIA">Assessoria</option>
                    <option value="AMBOS">Corretora + Assessoria</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">CNPJ</label>
                  <input className="form-input" value={form.cnpj} onChange={(event) => setForm({ ...form, cnpj: event.target.value })} placeholder="Numérico ou alfanumérico" />
                </div>
                <div className="form-group">
                  <label className="form-label">Razão Social</label>
                  <input className="form-input" value={form.razao_social} onChange={(event) => setForm({ ...form, razao_social: event.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Nome Fantasia</label>
                  <input className="form-input" value={form.nome_fantasia} onChange={(event) => setForm({ ...form, nome_fantasia: event.target.value })} />
                </div>
                <div className="form-group">
                  <label className="form-label">Responsável / administrador</label>
                  <input className="form-input" value={form.admin_nome} onChange={(event) => setForm({ ...form, admin_nome: event.target.value })} placeholder="Opcional" />
                </div>
                <div className="form-group">
                  <label className="form-label">E-mail de acesso</label>
                  <input type="email" className="form-input" value={form.admin_email} onChange={(event) => setForm({ ...form, admin_email: event.target.value })} placeholder="Opcional — envia convite" />
                </div>
                <button type="submit" className="btn btn-primary" disabled={saving} style={{ width: '100%', marginTop: 8 }}>
                  {saving ? <RefreshCw size={16} className="spin" /> : <Plus size={16} />}
                  {saving ? 'Cadastrando...' : 'Cadastrar empresa'}
                </button>
              </form>

              <div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                  <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
                    <Search size={15} style={{ position: 'absolute', left: 11, top: 12, opacity: 0.6 }} />
                    <input className="form-input" style={{ paddingLeft: 34 }} value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Buscar CNPJ, razão social ou e-mail" />
                  </div>
                  <select className="form-select" style={{ width: 220 }} value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as typeof typeFilter)}>
                    <option value="TODOS">Todos os tipos</option>
                    <option value="SEGURADORA">Seguradoras</option>
                    <option value="CORRETORA">Corretoras</option>
                    <option value="ASSESSORIA">Assessorias</option>
                    <option value="AMBOS">Corretora + Assessoria</option>
                  </select>
                  <button className="btn btn-secondary" onClick={load} disabled={loading} type="button">
                    <RefreshCw size={15} className={loading ? 'spin' : ''} /> Atualizar
                  </button>
                </div>

                <div style={{ overflowX: 'auto', border: '1px solid var(--border-color)', borderRadius: 10 }}>
                  <table className="custom-table">
                    <thead>
                      <tr>
                        <th>Empresa</th>
                        <th>Tipo / papel possível</th>
                        <th>Status</th>
                        <th>Apólices</th>
                        <th>Responsável</th>
                        <th>Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((partner) => (
                        <tr key={`${partner.kind}-${partner.id}`}>
                          <td>
                            <strong>{partner.nome_fantasia || partner.razao_social}</strong>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 3 }}>{partner.razao_social}</div>
                            <code style={{ fontSize: '0.7rem' }}>{partner.cnpj}</code>
                          </td>
                          <td>
                            {partner.kind === 'broker' ? (
                              <select
                                className="form-select"
                                style={{ minWidth: 190 }}
                                value={partner.entity_type}
                                onChange={(event) => changePartnerType(partner, event.target.value as 'CORRETORA' | 'ASSESSORIA' | 'AMBOS')}
                              >
                                <option value="CORRETORA">Corretora / Co-corretora</option>
                                <option value="ASSESSORIA">Assessoria</option>
                                <option value="AMBOS">Corretora + Assessoria</option>
                              </select>
                            ) : (
                              <span className="badge badge-info">Seguradora</span>
                            )}
                            {partner.capabilities.pode_atuar_como_cocorretora && (
                              <div style={{ marginTop: 5, fontSize: '0.7rem', color: 'var(--text-muted)' }}>Pode ser selecionada como co-corretora</div>
                            )}
                          </td>
                          <td><span className={partner.status === 'ATIVO' ? 'badge badge-success' : 'badge badge-error'}>{partner.status}</span></td>
                          <td>{partner.policies_count}</td>
                          <td>
                            <div>{partner.admin_nome || '—'}</div>
                            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{partner.admin_email || 'Sem e-mail'}</div>
                          </td>
                          <td>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <button type="button" className="btn btn-secondary" onClick={() => toggleStatus(partner)} title={partner.status === 'ATIVO' ? 'Inativar' : 'Reativar'}>
                                <Power size={13} /> {partner.status === 'ATIVO' ? 'Inativar' : 'Reativar'}
                              </button>
                              <button type="button" className="btn btn-secondary" onClick={() => resendInvitation(partner)}>
                                <Mail size={13} /> Convite
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {!loading && filtered.length === 0 && (
                        <tr><td colSpan={6} style={{ textAlign: 'center', padding: 28, color: 'var(--text-muted)' }}><Users size={20} style={{ marginBottom: 5 }} /><br />Nenhuma empresa encontrada.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
