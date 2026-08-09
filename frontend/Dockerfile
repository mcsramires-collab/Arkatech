# ---- Stage 1: build dos estáticos ----
FROM node:20-alpine AS builder
WORKDIR /app

# VITE_API_URL precisa ser injetada AQUI (build-time), pois o Vite
# grava as variáveis VITE_* dentro do bundle no momento do build.
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# ---- Stage 2: imagem final servida pelo Nginx ----
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
