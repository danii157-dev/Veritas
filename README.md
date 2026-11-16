# Veritas Private Bank

Veritas Private Bank is a private banking application prototype for customer and operations workflows. It is not a licensed bank, regulated institution, or live payment provider. Internal ledger balances are application records and do not represent independently verified funds.

## Included

- Customer portal with EUR and CHF accounts kept separate.
- Account overview, transaction history, statements, beneficiaries, funding, transfers, notifications, secure messages, profile, security, and support surfaces.
- MongoDB-backed internal transfers, account ledger entries, balance snapshots, and stored receipts when configured.
- EUR/CHF exchange quote flow with timestamped illustrative rate disclosure.
- Operations workspace for authorized operations sessions.
- MongoDB-backed customer registration, secure sessions, profiles, accounts, transfers and receipts.

## Ledger boundary

Internal Veritas-to-Veritas transfers debit the sender and credit the recipient in the same MongoDB transaction. Outgoing external-beneficiary instructions debit the sender and credit an internal outgoing-payments clearing account; they do not contact or credit an external bank. Administrative credits are restricted to Mongo customer sessions with server-managed `role: admin` and `accounts:credit` permission, and are paired with a funding-adjustment ledger debit. There is no customer preview login.

The legacy Supabase migrations are retained under `supabase/` for reference only and are not used by the current app. The account balance fields are cached snapshots in integer minor units, updated in the same transaction as the ledger records. This prototype is not a licensed bank and must not be used to hold or transfer real customer funds.

## Local development

1. Install the project dependencies.
2. Run the Vite development workflow from the project root.
3. Build with `npm run build`.
4. Type-check with `npm run typecheck`.

The public site is available without signing in. Customer and financial data require a MongoDB connection. Accounts, transaction history, ledger entries, transfers and receipts are sourced from MongoDB; account balances are never loaded from browser storage.

## MongoDB Auth and API

The app's registration, login, profiles, accounts, beneficiaries, transfers, ledger postings, receipts and transaction history use MongoDB. Passwords are hashed with Node.js scrypt; sessions are opaque random tokens stored only as HMAC hashes in MongoDB and sent to the browser in HTTP-only, SameSite cookies. `SESSION_SECRET` must be at least 32 characters. Financial writes fail closed unless MongoDB reports a replica set or sharded-cluster topology. External beneficiary transfers are internal postings only; no external payment is sent. Accounts start at zero, use explicitly internal `VPB-INT` identifiers, and require authorized funding before they can send money.

1. Copy `.env.example` to `.env`; set `VITE_API_URL` to the backend URL (default `http://localhost:4000`). No frontend database or authentication secrets are required.
2. Copy `server/.env.example` to `server/.env`; set `MONGODB_URI` to your own MongoDB Atlas replica-set URI or local replica-set URI. Generate `SESSION_SECRET` locally as a cryptographically random secret of at least 32 characters. Do not share it or place it in frontend `.env`.
3. Configure MongoDB Atlas Network Access and a database user, or follow the local replica-set instructions below. Standalone MongoDB is detected, but registration and financial operations requiring atomic setup will not work until transaction topology is available.
4. For an existing database, back it up first. Run `node migrations/20261104_transfer_lifecycle.js`, `node migrations/20261106_mongo_customer_auth.js`, and then `node migrations/20261106_credit_receipts.js` from the `server` directory. The customer-auth migration only maps legacy ownership when a Mongo customer with the same profile email already exists; unmatched old records remain unchanged and require manual review.
5. From the project root, run `npm run dev:api` and `npm run dev` in separate terminals. Open the Vite URL (usually `http://localhost:5173`). Set `CLIENT_ORIGIN` in `server/.env` to the selected frontend origin.

The API resolves every customer request from the opaque Mongo session cookie; customer records are never selected by a browser-provided owner UID. Registration creates the Mongo customer, profile and two zero-balance accounts atomically. The separate `POST /api/admin/credits` endpoint requires the Mongo customer record to have `role: admin` and `permissions: ['accounts:credit']`; these fields must only be granted by a trusted server-side provisioning process, never by a customer API. The endpoint requires customer UID, currency, amount, reason, administrative reference and idempotency key. Credit changes, ledger entries, receipt and audit record commit together. Do not build customer-facing admin controls.

For a single-node local development replica set, use a separate development-only `mongod` data directory and run `mongod --dbpath <dev-data-directory> --replSet rs0 --bind_ip 127.0.0.1`. Then run `mongosh "mongodb://127.0.0.1:27017/?directConnection=true" --eval "rs.initiate()"`. Confirm `rs.status()` reports PRIMARY. Set `MONGODB_URI=mongodb://127.0.0.1:27017/veritas?replicaSet=rs0` in `server/.env`, then restart the API. Do not repurpose, reinitialize, or overwrite the existing standalone database directory; use a new directory and back up any data first. MongoDB Community Server and MongoDB Shell must be installed separately on Windows if `mongod` and `mongosh` are not available.

The unauthenticated health route reports `databaseStatus`, `transactionTopology`, `mongoTransactionSupport`, `customerAuthentication`, `customerAuthConfigured`, `missingServerConfiguration`, and `financialProcessingAvailable`. It never returns connection strings or credential contents. Financial processing is enabled only with a valid Mongo session secret and reachable replica-set or sharded-cluster MongoDB.

## Deploying to Vercel

Import the repository into Vercel with the repository root as the Root Directory. Do not set it to `server`; the root contains the Vite app, `vercel.json`, and the `server/` API. The included configuration builds the Vite site and routes `/api/*` to the Express function. Keep `VITE_API_URL` unset in Vercel so browser requests use the same origin. Vercel installs the frontend and server dependencies separately.

Set these server environment variables in Vercel for Preview and Production: `MONGODB_URI` (a MongoDB Atlas replica-set URI) and `SESSION_SECRET` (at least 32 random characters). Set `CLIENT_ORIGIN` to your production custom domain if you use one; Vercel preview URLs are allowed from the deployment's `VERCEL_URL`. Set `TRANSFER_QUOTE_SECRET` to a separate stable random secret if quote signatures should be independent of `SESSION_SECRET`. Add provider secrets only when an authorized provider integration is configured. Allow Vercel's deployment IP access in MongoDB Atlas, or configure Atlas network access accordingly.

After deploying, check `/api/health`. Production account authentication and financial processing require the configured MongoDB replica set and secrets; they remain unavailable in preview mode without them. Never put server secrets in `VITE_*` variables.

Transfer fees and total debit are quoted server-side in integer minor units. The signed quote is customer-bound and expires after five minutes; the transfer POST rejects expired or changed terms. FX transfers are blocked until a trusted provider supplies an expiring rate quote.

Run the transfer-domain and ledger behavior checks with `npm --prefix server test`. These validate amount precision, IBAN checksum, fee math, reservation/release/settlement, double-entry outgoing/internal postings, and admin-credit balancing. MongoDB route-level integration, concurrent registration/transfer, rollback, and session-cookie tests require a configured replica set; they cannot be executed against a standalone or unconfigured database.

## Provider integration boundary

Add an authorised provider adapter on the server for account opening, issued account details, inbound payment events, external payments, status updates, and reconciliation. Keep credentials server-side, verify webhook signatures and replay protection, and only mark payments settled from trusted provider events.

## Production checklist

- Configure email/password authentication and customer onboarding activation rules.
- Add server-side permission checks for staff roles and dual approval for sensitive actions.
- Add MongoDB replica-set integration tests for concurrent transfers, idempotent retries, rollback, admin-credit authorization, and stored receipt retrieval.
- Use private storage for identity and onboarding documents.
- Connect a real regulated provider only after legal, compliance, and operational approval.
- Generate statements only from authorised persistent records.
- Add integration tests for isolation, concurrency, idempotency, provider webhooks, and statement generation.
