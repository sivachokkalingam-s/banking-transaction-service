const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Transaction Service API',
      version: '1.0.0',
      description: `
## Banking Transaction Microservice

Handles all financial transactions including:
- **Deposits** – Credit funds to an account
- **Withdrawals** – Debit funds from an account  
- **Transfers** – Move funds between accounts (with idempotency)
- **Account Statements** – Retrieve transaction history

### Business Rules
- Daily transfer limit: ₹2,00,000 per account
- Overdraft prevention for SAVINGS accounts
- Frozen accounts are blocked from all transactions
- All transfers are atomic (debit + credit or full rollback)
- Idempotency keys prevent duplicate transfers

### Inter-Service Communication
- Calls **Account Service** to validate balance and update funds
- Calls **Notification Service** for high-value transaction alerts
      `,
      contact: {
        name: 'Group 5 - Scalable Services',
      },
    },
    servers: [
      { url: 'http://localhost:3003', description: 'Local Development' },
      { url: 'http://transaction-service:3003', description: 'Docker Network' },
    ],
    components: {
      schemas: {
        Transaction: {
          type: 'object',
          properties: {
            transaction_id: { type: 'string', example: 'txn_abc123' },
            account_id: { type: 'string', example: 'ACC001' },
            transaction_type: {
              type: 'string',
              enum: ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER_DEBIT', 'TRANSFER_CREDIT'],
            },
            amount: { type: 'number', example: 5000.00 },
            currency: { type: 'string', example: 'INR' },
            counterparty_account_id: { type: 'string', example: 'ACC002' },
            reference: { type: 'string', example: 'REF20240101' },
            merchant: { type: 'string', example: 'Amazon India' },
            channel: { type: 'string', enum: ['ATM', 'ONLINE', 'BRANCH', 'MOBILE'] },
            status: { type: 'string', enum: ['PENDING', 'SUCCESS', 'FAILED', 'REVERSED'] },
            balance_after: { type: 'number', example: 15000.00 },
            description: { type: 'string' },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        DepositRequest: {
          type: 'object',
          required: ['account_id', 'amount'],
          properties: {
            account_id: { type: 'string', example: 'ACC001' },
            amount: { type: 'number', minimum: 1, example: 5000 },
            channel: { type: 'string', enum: ['ATM', 'ONLINE', 'BRANCH', 'MOBILE'], default: 'ONLINE' },
            description: { type: 'string', example: 'Salary credit' },
            reference: { type: 'string', example: 'SAL-JAN-2024' },
          },
        },
        WithdrawalRequest: {
          type: 'object',
          required: ['account_id', 'amount'],
          properties: {
            account_id: { type: 'string', example: 'ACC001' },
            amount: { type: 'number', minimum: 1, example: 2000 },
            channel: { type: 'string', enum: ['ATM', 'ONLINE', 'BRANCH', 'MOBILE'], default: 'ATM' },
            description: { type: 'string' },
          },
        },
        TransferRequest: {
          type: 'object',
          required: ['from_account_id', 'to_account_id', 'amount', 'idempotency_key'],
          properties: {
            from_account_id: { type: 'string', example: 'ACC001' },
            to_account_id: { type: 'string', example: 'ACC002' },
            amount: { type: 'number', minimum: 1, example: 10000 },
            idempotency_key: { type: 'string', example: 'transfer-2024-01-01-unique-key' },
            description: { type: 'string', example: 'Rent payment' },
            channel: { type: 'string', enum: ['ATM', 'ONLINE', 'BRANCH', 'MOBILE'], default: 'ONLINE' },
          },
        },
        TransferResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            replay: { type: 'boolean', description: 'true if this is a cached idempotent response' },
            debit_transaction: { $ref: '#/components/schemas/Transaction' },
            credit_transaction: { $ref: '#/components/schemas/Transaction' },
            message: { type: 'string' },
          },
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string' },
            code: { type: 'string' },
            correlationId: { type: 'string' },
          },
        },
        HealthResponse: {
          type: 'object',
          properties: {
            service: { type: 'string' },
            status: { type: 'string', enum: ['ok', 'degraded', 'error'] },
            timestamp: { type: 'string', format: 'date-time' },
            version: { type: 'string' },
            database: {
              type: 'object',
              properties: {
                transactions: { type: 'integer' },
                idempotency_keys: { type: 'integer' },
              },
            },
            dependencies: {
              type: 'object',
              properties: {
                account_service: { type: 'string' },
                notification_service: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
  apis: ['./src/routes/*.js'],
};

module.exports = swaggerJsdoc(options);
