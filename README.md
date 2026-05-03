# Transaction Service
**Group 5 — Scalable Banking Platform (M.Tech S2-25)**  
Member: Siva Chokkalingam S `2024TM93515`

---

## Architecture

This service is the **Transaction Service** — one of four independent microservices in the banking platform. It owns the full transaction lifecycle and its own SQLite database (database-per-service pattern).

```
Client
  └── API Gateway
        ├── Customer Service  (port 3001)  → Naseeruddin
        ├── Account Service   (port 3002)  → Manasa
        ├── Transaction Service (port 3003) → Siva  ← THIS SERVICE
        └── Notification Service (port 4104) → Rashi
```

### Database Schema
See [`docs/erd.mermaid`](docs/erd.mermaid) — four tables:
- **transactions** — ledger of all operations
- **account_cache** — replicated read-model from Account + Customer Service
- **idempotency_keys** — deduplication for `/transfer`
- **daily_transfer_totals** — rolling daily cap enforcement

---

## Business Rules

| Rule | Detail |
|------|--------|
| Account statuses | ACTIVE → allowed. FROZEN / CLOSED → 422 |
| KYC guard | kyc_status must be VERIFIED → else 403 |
| Overdraft | SAVINGS & NRE → no overdraft. CURRENT & SALARY → allowed |
| Daily transfer cap | ₹2,00,000 per account per UTC day (TRANSFER_OUT only) |
| High-value notification | amount ≥ ₹50,000 → POST /notifications/high-value |
| Idempotency | /transfer requires `idempotency_key`; 24h TTL, replay returns 200 |
| Same-account guard | from_account == to_account → 400 |
| Rollback | if credit fails after debit succeeds → debit is automatically reversed |

---

## Quick Start

### Prerequisites
- Node.js 20+
- Docker + Docker Compose
- (Optional) Minikube + kubectl

### Local Development

```bash
# 1. Clone and install
npm install

# 2. Copy env
cp .env.example .env

# 3. Place CSV seed files (from bank_Dataset.zip)
mkdir -p data/csv
cp bank_accounts.csv bank_customers.csv bank_transactions.csv data/csv/

# 4. Start (auto-seeds on first boot)
npm start

# Service: http://localhost:3003
# Swagger: http://localhost:3003/api-docs
# Metrics: http://localhost:3003/metrics
```

---

## Docker

```bash
# Build and start (standalone)
docker compose up --build

# Verify
docker ps
curl http://localhost:3003/health
```

### Multi-Service Mode (all teammates on one machine)

```bash
# Step 1: Create shared network once (run once, any machine)
docker network create banking-network

# Step 2: In docker-compose.yml, change the networks block to:
#   networks:
#     banking-network:
#       external: true

# Step 3: Each teammate starts their service with their own compose
# All services join banking-network and resolve each other by name
docker compose up --build
```

---

## Kubernetes (Minikube)

### Same Cluster (all services in one Minikube)

```bash
# 1. Start Minikube
minikube start --cpus=4 --memory=8192

# 2. Point Docker to Minikube's daemon
eval $(minikube docker-env)         # Linux/Mac
# minikube -p minikube docker-env | Invoke-Expression   # Windows PowerShell

# 3. Build image inside Minikube
docker build -t transaction-service:latest .

# 4. Deploy all manifests
kubectl apply -f k8s/

# 5. Verify
kubectl get pods
kubectl get svc
kubectl logs deployment/transaction-service-deployment -f

# 6. Get access URL
minikube service transaction-service --url
# OR access via: http://$(minikube ip):30003
```

### Separate Minikube Instances (each teammate on their own machine)

When each person runs their own Minikube, Kubernetes DNS (`account-service:3002`) does **not** resolve cross-cluster. Override the service URLs with NodePort IPs:

```bash
# 1. Get your teammate's Minikube IP
#    (run on their machine)
minikube ip   # e.g. 192.168.49.2

# 2. Get their service NodePort
#    kubectl get svc account-service     → NodePort e.g. 30002
#    kubectl get svc notification-service → NodePort e.g. 30104

# 3. Edit k8s/configmap.yaml on THIS machine:
#    ACCOUNT_SERVICE_URL:      "http://192.168.49.2:30002"
#    NOTIFICATION_SERVICE_URL: "http://192.168.49.3:30104"

# 4. Re-apply
kubectl apply -f k8s/configmap.yaml
kubectl rollout restart deployment/transaction-service-deployment
```

### Useful Commands

```bash
# Port-forward for local testing without NodePort
kubectl port-forward service/transaction-service 3003:3003

# Shell into pod
kubectl exec -it deployment/transaction-service-deployment -- sh

# View logs
kubectl logs deployment/transaction-service-deployment --tail=50 -f

# Describe pod (check probes, events)
kubectl describe pod -l app=transaction-service
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Liveness + DB stats |
| GET | /ready | Kubernetes readiness probe |
| GET | /metrics | Prometheus metrics |
| GET | /api-docs | Swagger UI |
| GET | /v1/transactions | List (paginated + filtered) |
| GET | /v1/transactions/:id | Get by ID |
| GET | /v1/transactions/account/:id/statement | Account statement |
| POST | /v1/transactions/deposit | Deposit |
| POST | /v1/transactions/withdraw | Withdraw |
| POST | /v1/transactions/transfer | Transfer (idempotent) |

---

## Inter-Service Flow (Transfer)

```
Client → POST /v1/transactions/transfer
  │
  ├─ 1. Idempotency check (local SQLite)
  ├─ 2. GET account-service/v1/accounts/{from}  ← balance + KYC + status
  ├─ 3. GET account-service/v1/accounts/{to}    ← validate receiver
  ├─ 4. Overdraft check (SAVINGS/NRE)
  ├─ 5. Daily limit check (local SQLite)
  ├─ 6. PATCH account-service/{from}/debit
  ├─ 7. PATCH account-service/{to}/credit
  │       └─ if FAIL → rollback debit (credit back to sender)
  ├─ 8. Insert TRANSFER_OUT + TRANSFER_IN in local SQLite (atomic)
  ├─ 9. Increment daily_transfer_totals
  ├─ 10. Store idempotency response
  └─ 11. Fire-and-forget → notification-service (high-value if ≥ ₹50,000)
```

---

## Seed Data

On first boot the service seeds:
- All records from `data/csv/bank_transactions.csv` (300 transactions)
- Account cache from `data/csv/bank_accounts.csv` + `bank_customers.csv`
- **2 synthetic high-value records** (`TXN-HV-DEMO-001`, `TXN-HV-DEMO-002`) with amounts ≥ ₹50,000 — required because the dataset max is ₹46,806, which is below the notification threshold.

Re-seed: bump `SEED_VERSION` in `src/seed/seed.js` and restart.
