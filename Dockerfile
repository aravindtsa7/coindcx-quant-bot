# Stage 1: Build & Compile
FROM node:24-alpine AS builder

WORKDIR /app

# Copy dependency specifications
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies including devDependencies
RUN npm ci

# Copy source code and configuration
COPY tsconfig*.json ./
COPY src ./src/

# Generate Prisma Client & compile TypeScript
RUN npx prisma generate
RUN npm run build

# Prune dev dependencies for production runtime
RUN npm prune --production

# Stage 2: Production Runtime
FROM node:24-alpine AS runner

WORKDIR /app

# Run as non-root user
USER node

# Copy production artifacts from builder
COPY --chown=node:node --from=builder /app/package*.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node --from=builder /app/prisma ./prisma

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]

