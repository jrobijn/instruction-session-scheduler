# Stage 1: Build frontend
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
ENV VITE_API_BASE=/api
RUN npm run build

# Stage 2: Install backend dependencies
FROM node:22-alpine AS backend-deps
WORKDIR /app/backend
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

# Stage 3: Production image
FROM node:22-alpine
WORKDIR /app

# Install tsx for running TypeScript directly
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
RUN npm install -g tsx

COPY backend/ ./
COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY --from=frontend-build /app/frontend/dist ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/data.db

VOLUME /data
EXPOSE 3000

CMD ["tsx", "src/index.ts"]
