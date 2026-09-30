import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import averbacaoRoutes from './routes/averbacao';
import adminRoutes from './routes/admin';
import adminIntegrityRoutes from './routes/adminIntegrity';
import brokerRoutes from './routes/broker';
import tenantRoutes from './routes/tenant';
import tenantIntegrityRoutes from './routes/tenantIntegrity';
import internalRoutes from './routes/internal';
import connectorRoutes from './routes/connector';
import tmsRoutes from './routes/tms';
import whatsappIntegrationRoutes from './routes/whatsappIntegration';
import { internalApiKeyMiddleware } from './middleware/internalApiKeyMiddleware';
import { backofficeOrInternalKeyMiddleware } from './middleware/backofficeOrInternalKeyMiddleware';

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
app.use('/api/v1/averbar', averbacaoRoutes);
app.use('/api/v1/averbacoes', averbacaoRoutes);
// Rotas novas de integridade entram antes do router legado para que os contratos evoluídos
// substituam os handlers antigos nos mesmos paths sem duplicar chamadas nem quebrar URLs.
app.use('/api/v1/admin', backofficeOrInternalKeyMiddleware, adminIntegrityRoutes);
app.use('/api/v1/admin', backofficeOrInternalKeyMiddleware, adminRoutes);
app.use('/api/v1/broker', backofficeOrInternalKeyMiddleware, brokerRoutes);
app.use('/api/v1/internal', internalApiKeyMiddleware, internalRoutes);
app.use('/api/v1/tenant', tenantIntegrityRoutes);
app.use('/api/v1/tenant', tenantRoutes);
app.use('/api/v1/connector', connectorRoutes);
app.use('/api/v1/tms', tmsRoutes);
app.use('/api/v1/integrations/whatsapp', whatsappIntegrationRoutes);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 ARCKATECH API de Averbação rodando na porta ${PORT}`);
    console.log(`⚡ Ambientes isolados (teste vs producao) habilitados.`);
  });
}

export default app;
