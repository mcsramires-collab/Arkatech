import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import averbacaoRoutes from './routes/averbacao';
import adminRoutes from './routes/admin';

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
app.use('/api/v1/admin', adminRoutes);

// Servidor HTTP
app.listen(PORT, () => {
  console.log(`🚀 ARCKATECH API de Averbação rodando na porta ${PORT}`);
  console.log(`⚡ Ambientes isolados (teste vs producao) habilitados.`);
});

export default app;
