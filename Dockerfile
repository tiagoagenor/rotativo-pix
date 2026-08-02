# Serviço PIX (Node) — imagem só com o código; a config entra por volume.
FROM node:20-alpine

WORKDIR /app

# Instala dependências primeiro (cache de build).
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Código da aplicação (a CONFIG — empresas/, bancos/, sistema.json,
# api-usuarios.json — entra por volume no docker-compose, não na imagem).
# A MESMA imagem serve o app (index.js) e o worker (worker.js) — o comando
# muda no docker-compose por serviço.
COPY index.js worker.js reprocessar.js ./
COPY src ./src

EXPOSE 3000

CMD ["node", "index.js"]
