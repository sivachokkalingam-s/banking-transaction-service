# Transaction Service

**Group 5 – Scalable Banking Platform | M.Tech 2nd Semester**

Handles all financial transactions: deposits, withdrawals, and fund transfers with full idempotency, overdraft protection, daily limits, and structured observability.

---

## Quick Start

### Run with Docker (single command)

```bash
docker-compose up --build
```

Service will be available at:
- **API**: http://localhost:3003/v1/transactions
- **Swagger UI**: http://localhost:3003/api-docs
- **Health**: http://localhost:3003/health
- **Metrics**: http://localhost:3003/metrics

### Run locally (without Docker)

```bash
npm install
npm start
```

On first boot, the service auto-seeds 300 transactions from `src/seed/seed.js`.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check with DB stats and dependency status |
| GET | /ready | Kubernetes readiness probe |
| GET | /metrics | Prometheus metrics (OpenMetrics format) |
| GET | /api-docs | Swagger UI |
| GET | /v1/transactions | List all transactions (paginated) |
| GET | /v1/transactions/:id | Get single transaction |
| GET | /v1/transactions/account/:accountId/statement | Account statement / mini-statement |
| POST | /v1/transactions/deposit | Deposit funds |
| POST | /v1/transactions/withdraw | Withdraw funds |
| POST | /v1/transactions/transfer | Transfer between accounts (idempotent) |

---

## Business Rules

| Rule | Detail |
|------|--------|
| Daily transfer limit | ₹2,00,000 per source account per calendar day |
| Overdraft prevention | SAVINGS accounts blocked if balance < transfer/withdrawal amount |
| Frozen accounts | All operations blocked on frozen/inactive accounts |
| Idempotency | `/transfer` requires `idempotency_key`; repeat calls return cached response |
| Atomicity | Transfer creates both DEBIT + CREDIT records; credit failure triggers debit rollback |
| High-value alerts | Transactions ≥ ₹50,000 trigger notification to Notification Service |

---

## Inter-Service Communication

```
Client → Transaction Service
                ↓
         Account Service  ──── GET /v1/accounts/:id (validate + get balance)
                          ──── PATCH /v1/accounts/:id/debit
                          ──── PATCH /v1/accounts/:id/credit
                ↓
     Notification Service ──── POST /notifications/high-value  (fire-and-forget)
                          ──── POST /notifications
```

- Retries: exponential backoff (200ms → 400ms → 800ms), max 3 attempts
- Timeouts: 5 seconds per call
- Notifications are fire-and-forget (never block transaction flow)

---

## Kubernetes Deployment

```bash
# Start Minikube
minikube start --cpus=4 --memory=8192

# Point docker to Minikube's registry
minikube -p minikube docker-env | Invoke-Expression   # Windows PowerShell
eval $(minikube docker-env)                           # Linux/macOS

# Build image
docker build -t transaction-service:latest .

# Apply manifests
kubectl apply -f k8s/

# Verify
kubectl get pods
kubectl get svc

# Port-forward
kubectl port-forward service/transaction-service-service 3003:3003

# View logs
kubectl logs deployment/transaction-service-deployment -f
```

---

## Testing with Postman

1. Import `Transaction Service.postman_collection.json`
2. Set `base_url` variable to `http://localhost:3003`
3. Run the collection (in order for idempotency tests to work correctly)

---

## Architecture Notes

- **Database**: SQLite with WAL mode, foreign keys enabled
- **Database-per-service**: owns `transactions`, `idempotency_keys`, `daily_transfer_totals`, `account_cache`
- **Account cache**: replicated read model for loose coupling (no cross-DB joins)
- **Metrics**: Prometheus RED metrics + business metrics (transactions_total, failed_transfers_total, etc.)
- **Logging**: Structured JSON via Winston, sensitive fields masked
- **Correlation ID**: propagated via `X-Correlation-ID` header through all service calls

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| PORT | 3003 | HTTP server port |
| DB_PATH | ./data/transactions.db | SQLite file path |
| ACCOUNT_SERVICE_URL | http://account-service:3002 | Account Service URL |
| NOTIFICATION_SERVICE_URL | http://notification-service:4104 | Notification Service URL |
| DAILY_TRANSFER_LIMIT | 200000 | Max daily transfer per account (INR) |
| HIGH_VALUE_THRESHOLD | 50000 | Threshold for high-value notifications (INR) |
| REQUEST_TIMEOUT_MS | 5000 | Timeout for inter-service calls |
| MAX_RETRY_ATTEMPTS | 3 | Retry count for failed calls |
| MASK_SENSITIVE | true | Mask email/phone in logs |
