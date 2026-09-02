# CoinDCX Quant Futures Bot

An institutional-grade, automated quantitative trading engine designed exclusively for **CoinDCX INR-Margined Crypto Perpetual Futures**.

---

## 1. Project Purpose & Scope

The **CoinDCX Quant Futures Bot** is built from first principles to operate reliably 24/7 in crypto futures markets. It enforces strict mathematical determinism, rigorous risk controls, continuous reconciliation, and a multi-stage promotion pipeline for algorithmic trading strategies.

### Frozen Scope Boundaries
- **Exchange:** CoinDCX ONLY. Multi-exchange adapters, CCXT, and cross-venue routing are strictly excluded.
- **Product:** CoinDCX INR-Margined Perpetual Futures ONLY. Spot trading, options, and non-INR margins are out of scope.
- **Account Model:** Single user, single CoinDCX account.
- **Coin Universe:** BTC and ETH initial focus; generic onboarding framework allows adding pairs (e.g. SOL) via configuration and data backfill without core code changes.
- **Market Data Foundation:** Canonical 1-minute OHLCV candles persisted in MySQL 8 form the definitive source of truth; all higher timeframes derive from 1m data.
- **Financial Arithmetic:** Decimal-safe arithmetic (`decimal.js`) across all price, quantity, margin, fee, funding, and PnL calculations. IEEE-754 floating-point numbers are prohibited in financial computations.

---

## 2. Current Implementation Status

> [!IMPORTANT]
> **Implemented Phases:**
> - **Phase 0:** Frozen Documentation (`docs/PRODUCT_SCOPE.md`, `docs/ARCHITECTURE.md`, `docs/INVARIANTS.md`, `docs/ROADMAP.md`, `docs/COIN_ONBOARDING.md`, `docs/STRATEGY_LIFECYCLE.md`).
> - **Phase 1:** Foundation Architecture (TypeScript strict mode, Express, MySQL 8 + Prisma, Zod config validation, decimal safety, structured logging with secret redaction, health check API, graceful lifecycle manager, Vitest test suite, Dockerfile, docker-compose, and GitHub Actions CI).
>
> **Explicit Notice:**
> - **Live trading is NOT implemented or enabled.**
> - **Order placement, WebSockets, market-data ingestion, and Phase 2 (CoinDCX Read Layer) are NOT yet implemented.**

---

## 3. Prerequisites

- **Node.js:** v22.x or v24.x LTS
- **npm:** v10.x or higher
- **MySQL:** v8.0 or higher (required for database connectivity)
- **Docker & Docker Compose:** (optional, for containerized MySQL or app runs)

---

## 4. Local Setup

### 4.1 Clone Repository & Install Dependencies
```bash
git clone https://github.com/aravindtsa7/coindcx-quant-bot.git
cd coindcx-quant-bot

npm install
```

### 4.2 Environment Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Configure your MySQL credentials in `.env`:
```env
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
DATABASE_URL="mysql://quant_user:quant_password@localhost:3306/coindcx_quant"
COINDCX_API_KEY=
COINDCX_API_SECRET=
```
*(Note: CoinDCX credentials are not required for Phase 1).*

### 4.3 Database Initialization
```bash
# Generate Prisma Client
npm run prisma:generate

# Apply migrations for local development (requires running MySQL)
npm run prisma:migrate
```

---

## 5. Development Commands

| Command | Description |
| :--- | :--- |
| `npm run dev` | Run development server with file-watching via `tsx` |
| `npm run build` | Clean and compile TypeScript to `dist/` |
| `npm run start` | Run compiled production build from `dist/` |
| `npm run typecheck` | Strict TypeScript validation without emitting code |
| `npm run lint` | Run ESLint across `src/` and `tests/` |
| `npm test` | Run complete unit and integration test suite via Vitest |
| `npm run test:coverage` | Run Vitest with V8 code coverage report |
| `npm run prisma:generate` | Generate Prisma client bindings from `prisma/schema.prisma` |
| `npm run prisma:migrate` | Run Prisma database migrations in development mode |
| `npm run prisma:deploy` | Apply pending database migrations in production mode |

---

## 6. Docker Deployment

Local development does **not** require Docker. However, Docker and Compose are provided for containerized workflows.

### Run MySQL 8 & Bot with Docker Compose
```bash
# Start MySQL 8 and application
docker compose up -d

# Check service logs
docker compose logs -f

# Check health endpoint
curl http://localhost:3000/health
```

---

## 7. Health API Smoke Test

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "service": "coindcx-quant-bot",
  "timestamp": "2026-09-02T18:25:00.000Z",
  "uptimeSeconds": 14
}
```

---

## 8. Security Invariants

- Real secrets, keys, and tokens are strictly banned from source control.
- Sensitive parameters (`apiKey`, `secret`, `password`, `token`, `authorization`, etc.) are automatically redacted in logs and error responses.
- Application error responses do not leak stack traces in production (`NODE_ENV=production`).

