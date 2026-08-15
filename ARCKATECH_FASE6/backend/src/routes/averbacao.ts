import { Router, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/authMiddleware';
import { AverbacaoService } from '../services/averbacao';
import { dbStore } from '../services/dbStore';

const router = Router();

/**
 * POST /api/v1/averbar
 * Submissão de averbação de CTe, NFe ou NFSe via API REST.
 */
router.post('/', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const { ramo, xml_content, recovery_token, supplemented_vars } = req.body;

  if (!ramo || !xml_content) {
    return res.status(400).json({
      status: 'erro',
      codigo: 'ERR-4005',
      mensagem: 'Os campos "ramo" (RCTRC, RCDC, RCV) e "xml_content" são obrigatórios.'
    });
  }

  const appBaseUrl = `${req.protocol}://${req.get('host')}`;

  const result = AverbacaoService.process(
    {
      tenant_id: tenantId,
      ramo,
      xml_content,
      recovery_token,
      supplemented_vars
    },
    appBaseUrl
  );

  const statusCode = result.status === 'erro' ? 400 : 200;
  return res.status(statusCode).json(result);
});

/**
 * GET /api/v1/recuperar/:token
 * Consulta os dados de uma sessão de recuperação de variável faltante para exibir no formulário web.
 */
router.get('/recuperar/:token', (req, res) => {
  const { token } = req.params;
  const session = dbStore.recoverySessions.find((r) => r.token === token);

  if (!session || session.utilizada) {
    return res.status(404).json({
      status: 'erro',
      codigo: 'ERR-4006',
      mensagem: 'Sessão de recuperação inválida, já utilizada ou expirada.'
    });
  }

  const tenant = dbStore.tenants.find((t) => t.id === session.tenant_id);
  const policy = dbStore.policies.find((p) => p.id === session.policy_id);

  return res.json({
    status: 'sucesso',
    token: session.token,
    tipo_documento: session.tipo_documento,
    variaveis_faltantes: session.variaveis_faltantes,
    cliente: tenant?.razao_social,
    cnpj: tenant?.cnpj,
    apolice: policy?.numero_apolice,
    ramo: policy?.ramo,
    expira_em: session.expira_em
  });
});

/**
 * POST /api/v1/recuperar
 * Reenvio suplementar de variáveis faltantes via Token de Recuperação.
 */
router.post('/recuperar', (req, res) => {
  const { recovery_token, supplemented_vars } = req.body;

  if (!recovery_token || !supplemented_vars) {
    return res.status(400).json({
      status: 'erro',
      codigo: 'ERR-4006',
      mensagem: 'recovery_token e supplemented_vars são obrigatórios.'
    });
  }

  const session = dbStore.recoverySessions.find((r) => r.token === recovery_token && !r.utilizada);
  if (!session) {
    return res.status(400).json({
      status: 'erro',
      codigo: 'ERR-4006',
      mensagem: 'Token de recuperação inválido ou expirado.'
    });
  }

  const policy = dbStore.policies.find((p) => p.id === session.policy_id)!;

  const appBaseUrl = `${req.protocol}://${req.get('host')}`;

  const result = AverbacaoService.process(
    {
      tenant_id: session.tenant_id,
      ramo: policy.ramo,
      xml_content: session.raw_xml_content,
      recovery_token,
      supplemented_vars
    },
    appBaseUrl
  );

  const statusCode = result.status === 'erro' ? 400 : 200;
  return res.status(statusCode).json(result);
});

/**
 * GET /api/v1/averbacoes
 * Lista as averbações do cliente com isolamento rigoroso por ambiente (teste vs produção).
 */
router.get('/', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const tenantId = req.tenant!.tenant_id;
  const ambiente = req.tenant!.ambiente;

  const items = dbStore.averbacoes.filter(
    (a) => a.tenant_id === tenantId && a.ambiente === ambiente
  );

  return res.json({
    status: 'sucesso',
    ambiente,
    total: items.length,
    averbacoes: items
  });
});

export default router;
