/*
# Add saved beneficiaries and recurring transfer templates

1. New table
- `recurring_transfer_templates`: customer-owned reusable wire instructions.
- `id`: unique template identifier.
- `user_id`: authenticated owner, filled from the session.
- `source_account_id`: owned account used for the instruction.
- `beneficiary_id`: owned saved beneficiary.
- `template_name`: customer-facing name.
- `amount` and `currency`: fixed instruction amount and currency.
- `frequency`: monthly, quarterly, or yearly schedule.
- `next_execution_on`: date for the next reviewable instruction.
- `reference`: payment reference text.
- `status`: active or paused; this never means settled.

2. Modified access
- Beneficiaries remain customer-owned and writable only by their owner.
- Recurring templates use authenticated owner policies and no anonymous grants.
- Template writes are limited to editable instruction fields.

3. Important notes
- Creating a template never creates a payment instruction or moves funds.
- A future execution must pass fresh balance, duplicate, risk, and provider checks server-side.
- Scheduled execution is intentionally not enabled by this migration.
*/

CREATE TABLE IF NOT EXISTS recurring_transfer_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  source_account_id uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE RESTRICT,
  beneficiary_id uuid NOT NULL REFERENCES beneficiaries(id) ON DELETE RESTRICT,
  template_name text NOT NULL CHECK (char_length(template_name) BETWEEN 2 AND 80),
  amount numeric(20,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL CHECK (currency IN ('EUR','CHF')),
  frequency text NOT NULL CHECK (frequency IN ('monthly','quarterly','yearly')),
  next_execution_on date NOT NULL,
  reference text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, template_name)
);

CREATE INDEX IF NOT EXISTS recurring_transfer_templates_user_idx ON recurring_transfer_templates(user_id, status, next_execution_on);

ALTER TABLE recurring_transfer_templates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON recurring_transfer_templates FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON recurring_transfer_templates TO authenticated;

DROP POLICY IF EXISTS "customers read own recurring templates" ON recurring_transfer_templates;
CREATE POLICY "customers read own recurring templates" ON recurring_transfer_templates FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers insert own recurring templates" ON recurring_transfer_templates;
CREATE POLICY "customers insert own recurring templates" ON recurring_transfer_templates FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers update own recurring templates" ON recurring_transfer_templates;
CREATE POLICY "customers update own recurring templates" ON recurring_transfer_templates FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "customers delete own recurring templates" ON recurring_transfer_templates;
CREATE POLICY "customers delete own recurring templates" ON recurring_transfer_templates FOR DELETE TO authenticated USING (auth.uid() = user_id);

REVOKE INSERT ON recurring_transfer_templates FROM authenticated;
GRANT INSERT (source_account_id, beneficiary_id, template_name, amount, currency, frequency, next_execution_on, reference) ON recurring_transfer_templates TO authenticated;
REVOKE UPDATE ON recurring_transfer_templates FROM authenticated;
GRANT UPDATE (template_name, amount, frequency, next_execution_on, reference, status) ON recurring_transfer_templates TO authenticated;
