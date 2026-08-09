const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://arckatech-apiarcka.ck5f84.easypanel.host';

export class ApiClient {
  private static async request(endpoint: string, options: RequestInit = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    try {
      const response = await fetch(url, { ...options, headers });
      const data = await response.json();
      return data;
    } catch (err: any) {
      console.error(`Erro na requisição ${endpoint}:`, err);
      return { status: 'erro', mensagem: 'Falha de conexão com a API Backend ARCKATECH.' };
    }
  }

  // Dashboard & Stats
  static getDashboardStats() {
    return this.request('/api/v1/admin/dashboard-stats');
  }

  // Auth Token
  static getToken(clientId: string, clientSecret: string) {
    return this.request('/api/v1/auth/token', {
      method: 'POST',
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret })
    });
  }

  // Averbação
  static averbarDocumento(token: string, ramo: string, xmlContent: string, supplementedVars?: any) {
    return this.request('/api/v1/averbar', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ramo, xml_content: xmlContent, supplemented_vars: supplementedVars })
    });
  }

  static getAverbacoes(token: string) {
    return this.request('/api/v1/averbacoes', {
      headers: { Authorization: `Bearer ${token}` }
    });
  }

  // Recuperação por Link/Token
  static getRecoverySession(recoveryToken: string) {
    return this.request(`/api/v1/averbar/recuperar/${recoveryToken}`);
  }

  static submitRecovery(recoveryToken: string, supplementedVars: Record<string, any>) {
    return this.request('/api/v1/averbar/recuperar', {
      method: 'POST',
      body: JSON.stringify({ recovery_token: recoveryToken, supplemented_vars: supplementedVars })
    });
  }

  // Admin - Tenants
  static getTenants() {
    return this.request('/api/v1/admin/tenants');
  }

  static createTenant(tenantData: any) {
    return this.request('/api/v1/admin/tenants', {
      method: 'POST',
      body: JSON.stringify(tenantData)
    });
  }

  static updateTenant(id: string, updates: any) {
    return this.request(`/api/v1/admin/tenants/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
  }

  // Admin - Seguradoras & Corretoras
  static getInsurers() {
    return this.request('/api/v1/admin/insurers');
  }

  static getBrokers() {
    return this.request('/api/v1/admin/brokers');
  }

  // Admin - Apólices & Regras
  static getPolicies() {
    return this.request('/api/v1/admin/policies');
  }

  static createPolicy(policyData: any) {
    return this.request('/api/v1/admin/policies', {
      method: 'POST',
      body: JSON.stringify(policyData)
    });
  }

  static updatePolicy(id: string, updates: any) {
    return this.request(`/api/v1/admin/policies/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
  }

  static getPolicyRules() {
    return this.request('/api/v1/admin/policy-rules');
  }

  static createPolicyRule(ruleData: any) {
    return this.request('/api/v1/admin/policy-rules', {
      method: 'POST',
      body: JSON.stringify(ruleData)
    });
  }

  static updatePolicyRule(id: string, updates: any) {
    return this.request(`/api/v1/admin/policy-rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
  }

  static deletePolicyRule(id: string) {
    return this.request(`/api/v1/admin/policy-rules/${id}`, {
      method: 'DELETE'
    });
  }

  static deletePolicy(id: string) {
    return this.request(`/api/v1/admin/policies/${id}`, {
      method: 'DELETE'
    });
  }

  // Admin - Regras de Obrigatoriedade por Tipo de Documento (padrão Sefaz)
  static getDocumentRules(tipoDocumento?: string) {
    const qs = tipoDocumento ? `?tipo_documento=${tipoDocumento}` : '';
    return this.request(`/api/v1/admin/document-rules${qs}`);
  }

  static createDocumentRule(ruleData: any) {
    return this.request('/api/v1/admin/document-rules', {
      method: 'POST',
      body: JSON.stringify(ruleData)
    });
  }

  static updateDocumentRule(id: string, updates: any) {
    return this.request(`/api/v1/admin/document-rules/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
  }

  static deleteDocumentRule(id: string) {
    return this.request(`/api/v1/admin/document-rules/${id}`, {
      method: 'DELETE'
    });
  }

  // Admin - Response Templates Editáveis
  static getTemplates() {
    return this.request('/api/v1/admin/templates');
  }

  static updateTemplate(id: string, textoCustomizado: string) {
    return this.request(`/api/v1/admin/templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ texto_customizado: textoCustomizado })
    });
  }

  // MOCK Generator
  static generateMock(payload: {
    tenant_id: string;
    tipo_doc?: string;
    policy_id?: string;
    incluir_variaveis_apolice?: boolean;
    omitir_obrigatorias?: string[];
  }) {
    return this.request('/api/v1/admin/mock/generate', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  // Importação em lote de XMLs para validar averbação/recusa
  static async importarLote(tenantId: string, ramo: string, arquivos: FileList | File[]) {
    const formData = new FormData();
    formData.append('tenant_id', tenantId);
    formData.append('ramo', ramo);
    Array.from(arquivos).forEach((f) => formData.append('arquivos', f));

    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/admin/importar-lote`, {
        method: 'POST',
        body: formData
      });
      return await response.json();
    } catch (err: any) {
      return { status: 'erro', mensagem: 'Falha de conexão ao importar o lote.' };
    }
  }

  // Relatório por cliente ou conjunto de clientes
  static getRelatorio(tenantIds: string[] = []) {
    const qs = tenantIds.length > 0 ? `?tenant_ids=${tenantIds.join(',')}` : '';
    return this.request(`/api/v1/admin/relatorio${qs}`);
  }

  // Documentação da API
  static getApiDocs() {
    return this.request('/api/v1/admin/docs');
  }

  // Batch Simulator Multi-Cliente
  static executeBatchSimulation(simData: any) {
    return this.request('/api/v1/admin/simulador/executar', {
      method: 'POST',
      body: JSON.stringify(simData)
    });
  }

  static getBatchHistory() {
    return this.request('/api/v1/admin/simulador/historico');
  }

  // Expurgo
  static purgeTestData(dias: number = 30) {
    return this.request('/api/v1/admin/expurgo', {
      method: 'POST',
      body: JSON.stringify({ dias })
    });
  }
}
