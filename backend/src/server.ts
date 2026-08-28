import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import averbacaoRoutes from './routes/averbacao';
import adminRoutes from './routes/admin';
import brokerRoutes from './routes/broker';
import tenantRoutes from './routes/tenant';
import internalRoutes from './routes/internal';
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
// Painéis internos (Seguradora, Corretora, ARCKATECH).
// /admin e /broker — Fase 3 do item "Login real + RBAC" (Backlog, seção 4): agora aceitam login
// real (Authorization: Bearer <token> de POST /auth/backoffice-login) OU a chave interna antiga
// (x-internal-api-key), nessa ordem — ver middleware/backofficeOrInternalKeyMiddleware.ts para o
// racional completo de por que a chave interna ainda é aceita (ponte até a Fase 4 terminar de
// migrar admin.ts para nunca mais aceitar insurer_id/broker_id livres).
app.use('/api/v1/admin', backofficeOrInternalKeyMiddleware, adminRoutes);
app.use('/api/v1/broker', backofficeOrInternalKeyMiddleware, brokerRoutes);
// /internal (CRUD de InternalUser/RbacProfile etc.) segue só com a chave interna por enquanto —
// fora do escopo desta fase (ver Backlog).
app.use('/api/v1/internal', internalApiKeyMiddleware, internalRoutes);
// Portal do Transportador — segue sem a chave interna (é o público final), mas ainda
// sem autenticação por usuário real; ver seção de gaps no doc de estado técnico.
app.use('/api/v1/tenant', tenantRoutes);

// Servidor HTTP
app.listen(PORT, () => {
  console.log(`🚀 ARCKATECH API de Averbação rodando na porta ${PORT}`);
  console.log(`⚡ Ambientes isolados (teste vs producao) habilitados.`);
});

export default app;
