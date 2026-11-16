/*
# Lock protected workflow fields

1. Security changes
- Customers may create applications, funding requests, and payment instructions only with user-entered request fields.
- Review state, approval timestamps, settlement state, and update timestamps are no longer client-writable.
- Customers cannot delete onboarding, funding, payment, notification, or profile records.
- Notifications are server-created and customer-readable; customers may only mark them read.

2. Important notes
- No data is removed by this migration.
- Authorised staff and provider handlers need server-side service-role or controlled RPC paths for state transitions.
*/

REVOKE DELETE ON customer_profiles, onboarding_applications, payment_instructions, funding_requests, notifications FROM authenticated;
REVOKE INSERT ON notifications FROM authenticated;

REVOKE INSERT ON customer_profiles FROM authenticated;
GRANT INSERT (full_name, email, phone, residency_country) ON customer_profiles TO authenticated;

REVOKE INSERT ON onboarding_applications FROM authenticated;
GRANT INSERT (requested_currencies, branch_preference, appointment_at) ON onboarding_applications TO authenticated;

REVOKE INSERT ON payment_instructions FROM authenticated;
GRANT INSERT (source_account_id, beneficiary_id, amount, currency) ON payment_instructions TO authenticated;

REVOKE INSERT ON funding_requests FROM authenticated;
GRANT INSERT (target_account_id, amount, currency) ON funding_requests TO authenticated;
