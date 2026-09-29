FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine AS runner

# O painel interno usa o Nginx como BFF. O backend pode ser sobrescrito no Easypanel;
# a chave interna deve ser configurada como variável de ambiente do serviço frontend
# com o mesmo valor usado no backend. O filtro impede que envsubst tente substituir
# variáveis nativas do Nginx, como $host e $proxy_add_x_forwarded_for.
ENV BACKEND_API_URL=https://arckatech-apiarcka.ck5f84.easypanel.host
ENV NGINX_ENVSUBST_FILTER="BACKEND_API_URL|INTERNAL_API_KEY"

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
