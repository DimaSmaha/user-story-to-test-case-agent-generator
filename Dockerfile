# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
# Copy static HTML files (not emitted by tsc)
RUN cp -r server/public dist/server/public

# Stage 2: Production runtime
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Ensure artifact and auth dirs exist so volume mounts work cleanly
RUN mkdir -p .workflow-artifacts .playwright-auth

EXPOSE 4000
CMD ["node", "dist/server/production.js"]
