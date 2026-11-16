/*
# Tighten Veritas Data API grants

1. Security changes
- Remove anonymous Data API privileges from every banking table.
- Remove customer-facing write privileges from immutable ledger, account, and audit tables.
- Keep customer-owned workflow writes available only where matching authenticated RLS policies exist.
- Prevent customers from changing relationship status, ownership, balances, pending funds, account status, journal status, and audit metadata through direct table writes.

2. Important notes
- This migration changes privileges only; it does not delete or alter data.
- Authorised server-side posting and operations commands must be added before staff workflows can mutate protected records.
*/

REVOKE ALL ON customer_profiles, onboarding_applications, bank_accounts, ledger_journals, ledger_entries, beneficiaries, payment_instructions, funding_requests, notifications, audit_events FROM anon;

REVOKE INSERT, UPDATE, DELETE ON bank_accounts, ledger_journals, ledger_entries, audit_events FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON ledger_journals FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON ledger_entries FROM authenticated;

REVOKE UPDATE ON customer_profiles FROM authenticated;
GRANT UPDATE (full_name, phone, residency_country) ON customer_profiles TO authenticated;

REVOKE UPDATE ON bank_accounts FROM authenticated;
REVOKE INSERT ON bank_accounts FROM authenticated;
REVOKE UPDATE ON payment_instructions FROM authenticated;
REVOKE UPDATE ON funding_requests FROM authenticated;
REVOKE UPDATE ON notifications FROM authenticated;
GRANT UPDATE (read_at) ON notifications TO authenticated;
