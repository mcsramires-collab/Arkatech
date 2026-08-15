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

  // Admin - Fase 2 (Seguradora): cadastro de cliente com resolução de conflito
  static lookupTenantByCnpj(cnpj: string) {
    return this.request(`/api/v1/admin/tenants/lookup?cnpj=${encodeURIComponent(cnpj)}`);
  }

  static createInsurerClient(payload: any) {
    return this.request('/api/v1/admin/insurer-clients', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  static assumePolicy(tenantId: string, payload: any) {
    return this.request(`/api/v1/admin/insurer-clients/${tenantId}/assume-policy`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  // Admin - Fase 2: Coberturas Adicionais da Seguradora
  static getInsurerCoverages(insurerId?: string) {
    const qs = insurerId ? `?insurer_id=${insurerId}` : '';
    return this.request(`/api/v1/admin/insurer-coverages${qs}`);
  }

  static createInsurerCoverage(payload: any) {
    return this.request('/api/v1/admin/insurer-coverages', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  static updateInsurerCoverage(id: string, updates: any) {
    return this.request(`/api/v1/admin/insurer-coverages/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
  }

  static deleteInsurerCoverage(id: string) {
    return this.request(`/api/v1/admin/insurer-coverages/${id}`, {
      method: 'DELETE'
    });
  }

  // Admin - Fase 2: Aprovações e Delegação
  static getApprovalRequests(insurerId?: string, status?: string) {
    const params = new URLSearchParams();
    if (insurerId) params.set('insurer_id', insurerId);
    if (status) params.set('status', status);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request(`/api/v1/admin/approval-requests${qs}`);
  }

  static resolveApprovalRequest(id: string, status: 'APROVADO' | 'REJEITADO', resolvedBy: string) {
    return this.request(`/api/v1/admin/approval-requests/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ status, resolved_by: resolvedBy })
    });
  }

  static getDelegationPermissions(insurerId?: string, brokerId?: string) {
    const params = new URLSearchParams();
    if (insurerId) params.set('insurer_id', insurerId);
    if (brokerId) params.set('broker_id', brokerId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request(`/api/v1/admin/delegation-permissions${qs}`);
  }

  static setDelegationPermissions(insurerId: string, brokerId: string, actions: { action: string; requires_approval: boolean }[]) {
    return this.request('/api/v1/admin/delegation-permissions', {
      method: 'PUT',
      body: JSON.stringify({ insurer_id: insurerId, broker_id: brokerId, actions })
    });
  }

  // Fase 4 - Visão Corretora
  static getBrokerClients(brokerId: string, insurerId?: string) {
    const qs = insurerId ? `&insurer_id=${insurerId}` : '';
    return this.request(`/api/v1/broker/clients?broker_id=${brokerId}${qs}`);
  }

  static getBrokerAverbacoes(brokerId: string, apenasRecusadas = false) {
    return this.request(`/api/v1/broker/averbacoes?broker_id=${brokerId}${apenasRecusadas ? '&apenas_recusadas=true' : ''}`);
  }

  static createBrokerClient(payload: any) {
    return this.request('/api/v1/broker/clients', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  static getBrokerRelatorio(brokerId: string) {
    return this.request(`/api/v1/broker/relatorio?broker_id=${brokerId}`);
  }

  // Fase 5 - Portal do Transportador
  static getActivationStatus(tenantId: string) {
    return this.request(`/api/v1/tenant/activation-status?tenant_id=${tenantId}`);
  }

  static acceptActivation(token: string) {
    return this.request(`/api/v1/tenant/activation/${token}/aceitar`, { method: 'POST' });
  }

  static getTenantPolicies(tenantId: string) {
    return this.request(`/api/v1/tenant/policies?tenant_id=${tenantId}`);
  }

  static getTenantAverbacoes(tenantId: string) {
    return this.request(`/api/v1/tenant/averbacoes?tenant_id=${tenantId}`);
  }

  static getRecoveryPendentes(tenantId: string) {
    return this.request(`/api/v1/tenant/recovery-pendentes?tenant_id=${tenantId}`);
  }

  static corrigirRecoveryNoPortal(token: string, supplementedVars: Record<string, string>) {
    return this.request(`/api/v1/tenant/recovery/${token}/corrigir`, {
      method: 'POST',
      body: JSON.stringify({ supplemented_vars: supplementedVars })
    });
  }

  static getTenantNotificationPreferences(tenantUserId: string) {
    return this.request(`/api/v1/tenant/notification-preferences?tenant_user_id=${tenantUserId}`);
  }

  static setTenantNotificationPreference(tenantUserId: string, canal: string, ativo: boolean) {
    return this.request('/api/v1/tenant/notification-preferences', {
      method: 'PUT',
      body: JSON.stringify({ tenant_user_id: tenantUserId, canal, ativo })
    });
  }

  // Fase 6 - Visão Empresa (ADM/Agente)
  static getInternalTenants() {
    return this.request('/api/v1/internal/tenants');
  }

  static provisionInsurer(payload: { cnpj: string; razao_social: string; nome_fantasia?: string }) {
    return this.request('/api/v1/internal/insurers', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  static getInternalUsers() {
    return this.request('/api/v1/internal/users');
  }

  static createInternalUser(payload: { nome: string; email: string; role: 'ADM' | 'AGENTE'; rbac_profile_id?: string }) {
    return this.request('/api/v1/internal/users', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  static getGlobalRelatorio() {
    return this.request('/api/v1/internal/relatorio');
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
