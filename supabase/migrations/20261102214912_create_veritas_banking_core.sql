/*
# Create Veritas Private Bank banking core

1. New Tables
- `customer_profiles`: person and customer relationship data owned by an authenticated user.
- `onboarding_applications`: branch-led account opening applications, never automatic approval.
- `bank_accounts`: separate currency accounts with status and provider identifiers.
- `ledger_journals`: immutable financial journal headers with idempotency keys.
- `ledger_entries`: balanced debit and credit lines for each journal.
- `beneficiaries`: customer-owned payment recipients.
- `payment_instructions`: payment requests and their externally confirmed lifecycle state.
- `funding_requests`: funding notices that never credit money by themselves.
- `notifications`: durable customer alerts.
- `audit_events`: append-only operational and security history.

2. Security
- All tables use row level security.
- Customer rows are scoped to auth.uid().
- Posted financial history cannot be updated or deleted by browser roles.
- Only authenticated users can access their own banking records.
- No real bank licence, provider, IBAN, or settlement claim is stored by default.

3. Important notes
- Balances are projections maintained by authorised server-side posting flows; customer clients cannot edit them.
- External payment and funding states remain pending until a verified provider event or authorised review.
- The first release is sandbox-labelled until a regulated provider adapter is configured.
*/

CREATE TABLE IF NOT EXISTS customer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  email text NOT NULL,
  phone text,
  residency_country text,
  relationship_status text NOT NULL DEFAULT 'pending' CHECK (relationship_status IN ('pending','active','restricted','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS onboarding_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  reference text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','under_review','additional_information','approved','rejected')),
  requested_currencies text[] NOT NULL DEFAULT ARRAY['EUR','CHF'],
  branch_preference text,
  appointment_at timestamptz,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customer_profiles(id) ON DELETE RESTRICT,
  account_name text NOT NULL,
  account_type text NOT NULL DEFAULT 'Private account',
  currency char(3) NOT NULL CHECK (currency IN ('EUR','CHF')),
  internal_number text NOT NULL UNIQUE,
  iban text,
  bic text,
  status text NOT NULL DEFAULT 'sandbox' CHECK (status IN ('sandbox','pending','active','restricted','closed')),
  ledger_balance numeric(20,2) NOT NULL DEFAULT 0,
  available_balance numeric(20,2) NOT NULL DEFAULT 0,
  pending_amount numeric(20,2) NOT NULL DEFAULT 0,
  opened_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, currency)
);

CREATE TABLE IF NOT EXISTS ledger_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  idempotency_key text NOT NULL UNIQUE,
  currency char(3) NOT NULL CHECK (currency IN ('EUR','CHF')),
  status text NOT NULL DEFAULT 'posted' CHECK (status IN ('pending','posted','reversed')),
  description text NOT NULL,
  posted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id uuid NOT NULL REFERENCES ledger_journals(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  direction text NOT NULL CHECK (direction IN ('debit','credit')),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS beneficiaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  iban text NOT NULL,
  currency char(3) NOT NULL CHECK (currency IN ('EUR','CHF')),
  status text NOT NULL DEFAULT 'pending_verification' CHECK (status IN ('pending_verification','verified','blocked')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  source_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  beneficiary_id uuid NOT NULL REFERENCES beneficiaries(id) ON DELETE RESTRICT,
  reference text NOT NULL UNIQUE,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL CHECK (currency IN ('EUR','CHF')),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','accepted','processing','settled','rejected','cancelled')),
  payment_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS funding_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  target_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  reference text NOT NULL UNIQUE,
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL CHECK (currency IN ('EUR','CHF')),
  status text NOT NULL DEFAULT 'initiated' CHECK (status IN ('initiated','awaiting_confirmation','under_review','confirmed','credited','rejected','cancelled')),
  is_sandbox boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','attention','success')),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bank_accounts_customer_idx ON bank_accounts(customer_id);
CREATE INDEX IF NOT EXISTS ledger_entries_account_idx ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS payment_instructions_user_idx ON payment_instructions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS funding_requests_user_idx ON funding_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC);

ALTER TABLE customer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE beneficiaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE funding_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON customer_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON onboarding_applications TO authenticated;
GRANT SELECT ON bank_accounts, ledger_journals, ledger_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON beneficiaries TO authenticated;
GRANT SELECT, INSERT, UPDATE ON payment_instructions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON funding_requests TO authenticated;
GRANT SELECT, UPDATE ON notifications TO authenticated;
GRANT SELECT ON audit_events TO authenticated;

DROP POLICY IF EXISTS "customers read own profile" ON customer_profiles;
CREATE POLICY "customers read own profile" ON customer_profiles FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers insert own profile" ON customer_profiles;
CREATE POLICY "customers insert own profile" ON customer_profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers update own profile" ON customer_profiles;
CREATE POLICY "customers update own profile" ON customer_profiles FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "customers read own applications" ON onboarding_applications;
CREATE POLICY "customers read own applications" ON onboarding_applications FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers insert own applications" ON onboarding_applications;
CREATE POLICY "customers insert own applications" ON onboarding_applications FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "customers read own accounts" ON bank_accounts;
CREATE POLICY "customers read own accounts" ON bank_accounts FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM customer_profiles p WHERE p.id = bank_accounts.customer_id AND p.user_id = auth.uid()));
DROP POLICY IF EXISTS "customers read own journals" ON ledger_journals;
CREATE POLICY "customers read own journals" ON ledger_journals FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM ledger_entries e JOIN bank_accounts a ON a.id = e.account_id JOIN customer_profiles p ON p.id = a.customer_id WHERE e.journal_id = ledger_journals.id AND p.user_id = auth.uid()));
DROP POLICY IF EXISTS "customers read own entries" ON ledger_entries;
CREATE POLICY "customers read own entries" ON ledger_entries FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM bank_accounts a JOIN customer_profiles p ON p.id = a.customer_id WHERE a.id = ledger_entries.account_id AND p.user_id = auth.uid()));

DROP POLICY IF EXISTS "customers read own beneficiaries" ON beneficiaries;
CREATE POLICY "customers read own beneficiaries" ON beneficiaries FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers insert own beneficiaries" ON beneficiaries;
CREATE POLICY "customers insert own beneficiaries" ON beneficiaries FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers update own beneficiaries" ON beneficiaries;
CREATE POLICY "customers update own beneficiaries" ON beneficiaries FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers delete own beneficiaries" ON beneficiaries;
CREATE POLICY "customers delete own beneficiaries" ON beneficiaries FOR DELETE TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "customers read own payments" ON payment_instructions;
CREATE POLICY "customers read own payments" ON payment_instructions FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers insert own payments" ON payment_instructions;
CREATE POLICY "customers insert own payments" ON payment_instructions FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers update own payments" ON payment_instructions;
CREATE POLICY "customers update own payments" ON payment_instructions FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "customers read own funding" ON funding_requests;
CREATE POLICY "customers read own funding" ON funding_requests FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers insert own funding" ON funding_requests;
CREATE POLICY "customers insert own funding" ON funding_requests FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers update own funding" ON funding_requests;
CREATE POLICY "customers update own funding" ON funding_requests FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "customers read own notifications" ON notifications;
CREATE POLICY "customers read own notifications" ON notifications FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers update own notifications" ON notifications;
CREATE POLICY "customers update own notifications" ON notifications FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "customers read own audit" ON audit_events;
CREATE POLICY "customers read own audit" ON audit_events FOR SELECT TO authenticated USING (actor_user_id = auth.uid());
