FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
COPY package*.json ./
# Instala TODAS as dependências (não só as de produção): node-pg-migrate e ts-node são
# devDependencies, necessárias para rodar `npm run migrate:up` e `npm run validate:mirror`
# (Fases 0 e 2 da migração para Postgres, ver claude/Plano_Migracao_Postgres.md no Project)
# direto pelo Shell do próprio serviço no Easypanel, sem precisar de outro ambiente. A imagem
# fica um pouco maior; aceito como troca por não precisar de infraestrutura extra só para rodar
# esses comandos ocasionais.
#
# Node 22: mantém o runtime de produção alinhado ao CI e às dependências atuais de migrations,
# parsing de PDF/Excel e demais bibliotecas do backend.
RUN npm install
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/tsconfig.json ./tsconfig.json
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/server.js"]
