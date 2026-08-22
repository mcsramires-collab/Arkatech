# ARCKATECH

API de Averbação de Seguros de Carga (RCTRC, RCDC, RCV) + Portal de Gestão.

## ⚠️ Estado deste repositório

Este projeto contém a **camada de infraestrutura** (Docker, Nginx, CI, estrutura de
pastas) já revisada e corrigida, mais um **esqueleto funcional mínimo** de backend
(Express + healthcheck) e frontend (Vite + React) — o suficiente para subir os
containers, validar a rede entre eles e fazer o primeiro deploy de ponta a ponta.

A regra de negócio completa (motor de averbação, engine de regras dinâmicas,
parser de CT-e/NF-e/NFS-e, response_templates, multi-tenant, simulador de lote
multi-cliente etc.) descrita no plano de arquitetura ainda precisa ser
implementada dentro de `backend/src/` e `frontend/src/`, seguindo a estrutura de
pastas já definida em `backend/src/services/` (a criar) e `backend/src/routes/`.

## Rodando localmente

```bash
cp .env.example .env
# edite o .env e gere os segredos indicados nos comentários
docker compose up --build
```

- API: http://localhost:3000/health
- Portal: http://localhost:5173

## Estrutura

```
ARCKATECH/
├── .github/workflows/ci.yml
├── backend/            # API (Node.js/Express) + worker (BullMQ)
├── frontend/           # Portal de Gestão (Vite + React)
├── nginx/               # Reverse proxy + TLS (produção)
├── docker-compose.yml       # ambiente de desenvolvimento
├── docker-compose.prod.yml  # ambiente de produção (VPS)
├── .env.example              # template de variáveis (dev)
└── .env.production.example   # template de variáveis (prod)
```

## Deploy em produção

Ver instruções passo a passo no chat/orientação fornecida junto com este
projeto (GitHub → Easypanel/Hostinger → primeiros testes).
