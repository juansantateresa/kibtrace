FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY shared/ ./shared/
COPY migrations/ ./migrations/
COPY services/ ./services/

# Default: no-op, overridden by docker-compose command
CMD ["node", "--version"]
