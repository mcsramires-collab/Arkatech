import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import averbacaoRoutes from './routes/averbacao';
import adminRoutes from './routes/admin';
import adminIntegrityRoutes from './routes/adminIntegrity';
import onboardingMigrationRoutes from './routes/onboardingMigration';
import brokerRoutes from './routes/broker';
import tenantRoutes from './routes/tenant';
import tenantIntegrityRoutes from './routes/tenantIntegrity';
import internalRoutes from './routes/internal';
import connectorRoutes from './routes/connector';
import tmsRoutes from './routes/tms';
import whatsappIntegrationRoutes from './routes/whatsappIntegration';
import { internalApiKeyMiddleware } from './middleware/internalApiKeyMiddleware';
import { backofficeOrInternalKeyMiddleware } from './middleware/backofficeOrInternalKeyMiddleware';
import { onboardingMigrationReconcileMiddleware } from './middleware/onboardingMigrationReconcileMiddleware';
import { onboardingMigrationDueMiddleware } from './middleware/onboardingMigrationDueMiddleware';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares Globais
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Healthcheck
app.get('/health', (req, res) => {
  return res.json({
    status: 'ONLINE',
    sistema: 'ARCKATECH - API de Averbação de Seguros',
    timestamp: new Date().toISOString()
  });
});

// Rotas da Aplicação
app.use('/api/v1/auth', authRoutes);
// Antes de qualquer averbação, materializa migrações cujo início programado já chegou e cujo
// onboarding possui apólices ativas de destino para todos os ramos selecionados.
app.use('/api/v1/averbar', onboardingMigrationDueMiddleware, averbacaoRoutes);
app.use('/api/v1/averbacoes', onboardingMigrationDueMiddleware, averbacaoRoutes);
// Painéis internos (Seguradora, Corretora, ARCKATECH).
// /admin e /broker — Fase 3 do item "Login real + RBAC" (Backlog, seção 4): agora aceitam login
// real (Authorization: Bearer <token> de POST /auth/backoffice-login) OU a chave interna antiga
// (x-internal-api-key), nessa ordem — ver middleware/backofficeOrInternalKeyMiddleware.ts para o
// racional completo de por que a chave interna ainda é aceita (ponte até a Fase 4 terminar de
// migrar admin.ts para nunca mais aceitar insurer_id/broker_id livres).
app.use('/api/v1/admin/onboarding', backofficeOrInternalKeyMiddleware, onboardingMigrationRoutes);
// Integridade entra antes do router legado para evoluir contratos específicos nos mesmos paths
// sem duplicar chamadas. As demais mutações seguem pelo reconciliador de onboarding do main.
app.use('/api/v1/admin', backofficeOrInternalKeyMiddleware, adminIntegrityRoutes);
app.use(
  '/api/v1/admin',
  backofficeOrInternalKeyMiddleware,
  onboardingMigrationReconcileMiddleware,
  adminRoutes
);
app.use('/api/v1/broker', backofficeOrInternalKeyMiddleware, brokerRoutes);
// /internal (CRUD de InternalUser/RbacProfile etc.) segue só com a chave interna por enquanto —
// fora do escopo desta fase (ver Backlog).
app.use('/api/v1/internal', internalApiKeyMiddleware, internalRoutes);
// Regra de solicitação multi-seguradora do pacote de integridade intercepta apenas o POST
// específico; o restante segue normalmente para o router completo do Portal do Segurado.
app.use('/api/v1/tenant', tenantIntegrityRoutes);
app.use('/api/v1/tenant', tenantRoutes);
// Agente local: autenticação própria por device token, independente do login do portal.
app.use('/api/v1/connector', connectorRoutes);
// Integração máquina-a-máquina para TMS: mesmo motor e regras do Portal/SEFAZ.
app.use('/api/v1/tms', tmsRoutes);
// Contrato interno, agnóstico de fornecedor, consumido pelo futuro adapter de WhatsApp.
app.use('/api/v1/integrations/whatsapp', whatsappIntegrationRoutes);

// Servidor HTTP
// Em produção/dev executado diretamente, sobe normalmente. Em testes de integração o módulo é
// apenas importado e o próprio teste abre uma porta efêmera, evitando conflito de porta e
// permitindo exercitar os contratos HTTP reais com Node fetch.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 ARCKATECH API de Averbação rodando na porta ${PORT}`);
    console.log(`⚡ Ambientes isolados (teste vs producao) habilitados.`);
  });
}

export default app;
