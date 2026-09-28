import { dbStore } from './dbStore';
import { aplicarAcaoDelegada } from './delegatedActions';

describe('delegatedActions - criar cliente', () => {
  beforeEach(() => {
    dbStore.tenants = [];
    dbStore.policies = [];
    dbStore.activationTokens = [];
    jest.spyOn(dbStore, 'persist').mockImplementation(() => undefined);
  });

  afterEach(() => {
    dbStore.tenants = [];
    dbStore.policies = [];
    dbStore.activationTokens = [];
    jest.restoreAllMocks();
  });

  it('cria segurado delegado com perfil operacional e credenciais não previsíveis', () => {
    const result = aplicarAcaoDelegada('CRIAR_CLIENTE', 'ins-1', 'brk-1', {
      cnpj: '12ABC34501DE35',
      razao_social: 'Embarcador Exemplo',
      ramo: 'RCTRC',
      numero_apolice: 'AP-123',
      tipo_operacao: 'EMBARCADOR',
      contato_nome: 'Operação',
      contato_email: 'operacao@example.com'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.cliente_novo).toBe(true);
    expect(result.tenant).toMatchObject({
      role: 'TRANSPORTADOR',
      tipo_operacao: 'EMBARCADOR',
      conta_ativada: false
    });
    expect(result.tenant.client_id).not.toBe('client_prod_12ABC34501DE35');
    expect(result.tenant.client_secret_hash).not.toBe('secret_12ABC34501DE35');
    expect(result.tenant.client_secret_hash).toMatch(/^\$2[aby]\$/);
    expect(dbStore.activationTokens).toHaveLength(0);
  });

  it('rejeita tipo operacional inválido antes de criar tenant', () => {
    const result = aplicarAcaoDelegada('CRIAR_CLIENTE', 'ins-1', 'brk-1', {
      cnpj: '12ABC34501DE35',
      razao_social: 'Cliente',
      ramo: 'RCTRC',
      numero_apolice: 'AP-123',
      tipo_operacao: 'OUTRO'
    });

    expect(result.ok).toBe(false);
    expect(dbStore.tenants).toHaveLength(0);
    expect(dbStore.policies).toHaveLength(0);
  });

  it('não recria a conta quando só adiciona nova apólice a segurado existente', () => {
    dbStore.tenants = [{
      id: 'tenant-1',
      cnpj: '12ABC34501DE35',
      razao_social: 'Cliente',
      status: 'ATIVO',
      ambiente: 'producao',
      client_id: 'client-existing',
      client_secret_hash: '$2b$12$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuu',
      role: 'TRANSPORTADOR',
      tipo_operacao: 'AMBOS',
      token_duration_hours: 8,
      conta_ativada: true,
      created_at: new Date().toISOString()
    }] as any;

    const result = aplicarAcaoDelegada('CRIAR_CLIENTE', 'ins-1', 'brk-1', {
      cnpj: '12ABC34501DE35',
      razao_social: 'Cliente',
      ramo: 'RCDC',
      numero_apolice: 'AP-456',
      tipo_operacao: 'TRANSPORTADOR'
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cliente_novo).toBe(false);
    expect(result.tenant.id).toBe('tenant-1');
    expect(result.tenant.tipo_operacao).toBe('AMBOS');
  });
});
