require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const healthRoutes = require('./routes/health');

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

app.use('/health', healthRoutes);

app.get('/', (_req, res) => {
  res.json({ service: 'arckatech-api', status: 'online' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[arckatech-api] rodando na porta ${PORT} (${process.env.NODE_ENV || 'development'})`);
});
