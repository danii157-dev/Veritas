import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateFeeMinor, formatMinor, getCountryAccountRequirements, parseAmountMinor, selectPaymentRail, validateCountryAccountDetails, validateIban } from './transfer-domain.js';
import { createPaymentProvider } from './payment-provider.js';
import { applyProviderStatus, postAdministrativeCredit, postInternalTransfer, postOutgoingTransfer, releaseExternal, reserveExternal, settleExternal } from './transfer-engine.js';
import { resolveMongoTransactionTopology, resolveServerRuntimeConfig } from './runtime-config.js';

test('parses exact minor-unit amounts and rejects excess precision', () => {
  assert.equal(parseAmountMinor('1200.05'), 120005);
  assert.equal(parseAmountMinor('5'), 500);
  assert.equal(parseAmountMinor('1.001'), null);
  assert.equal(parseAmountMinor('1,000.00'), null);
  assert.equal(formatMinor(120005), '1200.05');
});

test('runtime config requires MongoDB and a strong session secret', () => {
  const config = resolveServerRuntimeConfig({});
  assert.equal(config.isPreviewMode, true);
  assert.equal(config.hasDatabase, false);
  assert.equal(config.hasCustomerAuth, false);
  assert.deepEqual(config.missingEnvironment, ['MONGODB_URI', 'SESSION_SECRET']);
});

test('validates Swiss and German IBAN checksums and structure', () => {
  assert.equal(validateIban('CH93 0076 2011 6238 5295 7'), true);
  assert.equal(validateIban('DE89 3704 0044 0532 0130 00'), true);
  assert.equal(validateIban('CH93 0076 2011 6238 5295 8'), false);
  assert.equal(validateIban('CH93 123'), false);
  assert.equal(validateIban('GB82 WEST 1234 5698 7654 32'), true);
});

test('selects only candidate rails from currency and destination, never claiming provider availability', () => {
  assert.equal(selectPaymentRail({ currency: 'CHF', recipientCountry: 'CH', iban: 'CH...' }), 'SIC_PROVIDER_ROUTE');
  assert.equal(selectPaymentRail({ currency: 'EUR', recipientCountry: 'CH', iban: 'CH...' }), 'EUROSIC_PROVIDER_ROUTE');
  assert.equal(selectPaymentRail({ currency: 'EUR', recipientCountry: 'DE', iban: 'DE...' }), 'SEPA_PROVIDER_ROUTE');
  assert.equal(selectPaymentRail({ currency: 'EUR', recipientCountry: 'US', iban: 'US...' }), 'INTERNATIONAL_PROVIDER_ROUTE');
});

test('calculates fees in integer minor units', () => {
  assert.equal(calculateFeeMinor(10001, 125, 35), 160);
});

test('sandbox adapter explicitly does not claim settlement', async () => {
  const provider = createPaymentProvider({ mode: 'sandbox' });
    assert.equal(provider.canSubmit, false);
    assert.equal(provider.testOnly, true);
  const result = await provider.submitPayment({ rail: 'SEPA_PROVIDER_ROUTE' });
  assert.equal(result.status, 'accepted');
  assert.match(result.message, /no payment was sent to a bank/i);
});

test('unconfigured live provider cannot accept payments', async () => {
  const provider = createPaymentProvider({ mode: 'live' });
  assert.equal(provider.canSubmit, false);
  await assert.rejects(() => provider.submitPayment({}), /No authorized live payment provider is configured/);
});

test('payment processing defaults to unavailable and production cannot select sandbox', async () => {
  const defaultProvider = createPaymentProvider();
  const productionSandbox = createPaymentProvider({ mode: 'sandbox', environment: 'production' });
  assert.equal(defaultProvider.canSubmit, false);
  assert.equal(productionSandbox.canSubmit, false);
  await assert.rejects(() => defaultProvider.submitPayment({}), /No authorized live payment provider is configured/);
});

test('external transfer reserves available funds, settles ledger only after confirmation, and releases on rejection', () => {
  const account = { currency: 'CHF', ledgerMinor: 100000, availableMinor: 100000, pendingMinor: 0 };
  const reserved = reserveExternal(account, 1250);
  assert.deepEqual([reserved.ledgerMinor, reserved.availableMinor, reserved.pendingMinor], [100000, 98750, 1250]);
  const settled = settleExternal(reserved, 1250);
  assert.deepEqual([settled.ledgerMinor, settled.availableMinor, settled.pendingMinor], [98750, 98750, 0]);
  const released = releaseExternal(reserved, 1250);
  assert.deepEqual([released.ledgerMinor, released.availableMinor, released.pendingMinor], [100000, 100000, 0]);
  assert.throws(() => reserveExternal(account, 100001), /INSUFFICIENT_AVAILABLE_BALANCE/);
});

test('returned and reversed transfers create a compensating credit without changing the original debit', () => {
  const starting = { currency: 'EUR', ledgerMinor: 10000, availableMinor: 10000, pendingMinor: 0 };
  const settled = settleExternal(reserveExternal(starting, 2500), 2500);
  const compensated = { ...settled, ledgerMinor: settled.ledgerMinor + 2500, availableMinor: settled.availableMinor + 2500 };
  assert.deepEqual([settled.ledgerMinor, settled.availableMinor, settled.pendingMinor], [7500, 7500, 0]);
  assert.deepEqual([compensated.ledgerMinor, compensated.availableMinor, compensated.pendingMinor], [10000, 10000, 0]);
  assert.equal(settled.ledgerMinor + 2500, compensated.ledgerMinor);
});

test('internal transfer produces equal debit and credit entries atomically', () => {
  const source = { _id: 'source', currency: 'EUR', ledgerMinor: 10000, availableMinor: 10000 };
  const destination = { _id: 'destination', currency: 'EUR', ledgerMinor: 4000, availableMinor: 4000 };
  const result = postInternalTransfer(source, destination, 1250);
  assert.deepEqual([result.source.ledgerMinor, result.source.availableMinor], [8750, 8750]);
  assert.deepEqual([result.destination.ledgerMinor, result.destination.availableMinor], [5250, 5250]);
  assert.equal(result.entries[0].amountMinor, result.entries[1].amountMinor);
  assert.equal(result.entries.reduce((sum, entry) => sum + (entry.entryType === 'credit' ? entry.amountMinor : -entry.amountMinor), 0), 0);
  assert.throws(() => postInternalTransfer(source, { ...destination, currency: 'CHF' }, 100), /CURRENCY_MISMATCH/);
});

test('provider event lifecycle records accepted/processing, settles once, and ignores duplicate event IDs', () => {
  const account = { currency: 'CHF', ledgerMinor: 50000, availableMinor: 47500, pendingMinor: 2500 };
  const transfer = { totalDebitMinor: 2500, settlementStatus: 'pending_review', providerEventIds: [] };
  const accepted = applyProviderStatus(transfer, account, { eventId: 'ev-accepted', status: 'accepted' });
  assert.equal(accepted.transfer.settlementStatus, 'accepted');
  const settled = applyProviderStatus(accepted.transfer, accepted.account, { eventId: 'ev-settled', status: 'settled', providerReference: 'provider-ref' });
  assert.equal(settled.transfer.settlementStatus, 'settled');
  assert.deepEqual([settled.account.ledgerMinor, settled.account.availableMinor, settled.account.pendingMinor], [47500, 47500, 0]);
  assert.equal(settled.entries[0].entryType, 'debit');
  const duplicate = applyProviderStatus(settled.transfer, settled.account, { eventId: 'ev-settled', status: 'settled' });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.entries.length, 0);
});

test('provider rejection releases reserved funds and rejects invalid transitions', () => {
  const account = { currency: 'EUR', ledgerMinor: 50000, availableMinor: 47500, pendingMinor: 2500 };
  const transfer = { totalDebitMinor: 2500, settlementStatus: 'processing', providerEventIds: [] };
  const rejected = applyProviderStatus(transfer, account, { eventId: 'ev-rejected', status: 'rejected' });
  assert.equal(rejected.transfer.settlementStatus, 'rejected');
  assert.deepEqual([rejected.account.ledgerMinor, rejected.account.availableMinor, rejected.account.pendingMinor], [50000, 50000, 0]);
  assert.throws(() => applyProviderStatus(rejected.transfer, rejected.account, { eventId: 'ev-late-settle', status: 'settled' }), /INVALID_TRANSFER_TRANSITION/);
});

test('idempotency key guard returns the existing result without reserving twice', () => {
  const records = new Map();
  const submitOnce = (key, amountMinor) => {
    if (records.has(key)) return { ...records.get(key), duplicate: true };
    const result = { key, amountMinor, duplicate: false };
    records.set(key, result);
    return result;
  };
  assert.deepEqual(submitOnce('same-request-key', 1000), { key: 'same-request-key', amountMinor: 1000, duplicate: false });
  assert.deepEqual(submitOnce('same-request-key', 1000), { key: 'same-request-key', amountMinor: 1000, duplicate: true });
  assert.deepEqual(submitOnce('another-request-key', 2500), { key: 'another-request-key', amountMinor: 2500, duplicate: false });
});

test('provider events cannot settle a transfer while operations has it on hold', () => {
  const heldTransfer = { totalDebitMinor: 500, settlementStatus: 'on_hold', providerEventIds: [] };
  const account = { currency: 'CHF', ledgerMinor: 10000, availableMinor: 9500, pendingMinor: 500 };
  assert.throws(() => applyProviderStatus(heldTransfer, account, { eventId: 'event-held-settle', status: 'settled' }), /TRANSFER_ON_HOLD/);
});

test('validates country-specific domestic identifiers without forcing IBANs', () => {
  assert.equal(getCountryAccountRequirements('US').identifierType, 'Account number');
  assert.equal(validateCountryAccountDetails({ country: 'US', accountIdentifierType: 'account_number', accountIdentifier: '123456789', routingIdentifier: '021000021' }), true);
  assert.equal(validateCountryAccountDetails({ country: 'GB', accountIdentifierType: 'account_number', accountIdentifier: '12345678', routingIdentifier: '123456' }), true);
  assert.equal(validateCountryAccountDetails({ country: 'CA', accountIdentifierType: 'account_number', accountIdentifier: '123456789', routingIdentifier: '001-12345' }), true);
  assert.equal(validateCountryAccountDetails({ country: 'AU', accountIdentifierType: 'account_number', accountIdentifier: '123456789', routingIdentifier: '123456' }), true);
  assert.equal(validateCountryAccountDetails({ country: 'US', accountIdentifierType: 'account_number', accountIdentifier: '123', routingIdentifier: '021000021' }), false);
  assert.equal(validateCountryAccountDetails({ country: 'CH', accountIdentifierType: 'IBAN', accountIdentifier: 'DE89370400440532013000' }), false);
});

test('reconciliation-required transfers keep reservations until a trusted provider outcome arrives', () => {
  const starting = { currency: 'EUR', ledgerMinor: 50000, availableMinor: 47500, pendingMinor: 2500 };
  const uncertain = { totalDebitMinor: 2500, settlementStatus: 'reconciliation_required', providerEventIds: [] };
  const settled = applyProviderStatus(uncertain, starting, { eventId: 'reconcile-settled', status: 'settled' });
  assert.equal(settled.transfer.settlementStatus, 'settled');
  assert.deepEqual([settled.account.ledgerMinor, settled.account.availableMinor, settled.account.pendingMinor], [47500, 47500, 0]);

  const rejected = applyProviderStatus(uncertain, starting, { eventId: 'reconcile-rejected', status: 'rejected' });
  assert.equal(rejected.transfer.settlementStatus, 'rejected');
  assert.deepEqual([rejected.account.ledgerMinor, rejected.account.availableMinor, rejected.account.pendingMinor], [50000, 50000, 0]);
});

test('local outgoing transfer debits sender and credits clearing without crediting a beneficiary', () => {
  const source = { _id: 'customer-account', currency: 'CHF', ledgerMinor: 100000, availableMinor: 90000 };
  const clearingAccount = { _id: 'clearing-chf', currency: 'CHF', balanceMinor: 25000 };
  const posted = postOutgoingTransfer(source, clearingAccount, 1250);
  assert.deepEqual([posted.source.ledgerMinor, posted.source.availableMinor], [98750, 88750]);
  assert.equal(posted.clearingAccount.balanceMinor, 26250);
  assert.deepEqual(posted.entries.map((entry) => [entry.ledgerAccountType, entry.entryType, entry.amountMinor]), [
    ['customer', 'debit', 1250],
    ['clearing', 'credit', 1250],
  ]);
  assert.equal(posted.entries.reduce((sum, entry) => sum + (entry.entryType === 'credit' ? entry.amountMinor : -entry.amountMinor), 0), 0);
  assert.equal(posted.entries.some((entry) => entry.accountId === 'beneficiary-account'), false);
  assert.throws(() => postOutgoingTransfer(source, clearingAccount, 100001), /INSUFFICIENT_AVAILABLE_BALANCE/);
});

test('local outgoing posting rejects mismatched clearing currency and unsafe amounts', () => {
  const source = { _id: 'customer-account', currency: 'EUR', ledgerMinor: 10000, availableMinor: 9000 };
  const clearingAccount = { _id: 'clearing-chf', currency: 'CHF', balanceMinor: 25000 };
  assert.throws(() => postOutgoingTransfer(source, clearingAccount, 100), /CURRENCY_MISMATCH/);
  assert.throws(() => postOutgoingTransfer(source, { ...clearingAccount, currency: 'EUR' }, 0), /positive minor units/);
});

test('administrative credit increases customer balance and balances against funding adjustment', () => {
  const customer = { _id: 'customer-account', currency: 'EUR', ledgerMinor: 1499500, availableMinor: 1499500 };
  const funding = { _id: 'funding-eur', currency: 'EUR', balanceMinor: 0 };
  const posted = postAdministrativeCredit(customer, funding, 200000);

  assert.deepEqual([posted.customer.ledgerMinor, posted.customer.availableMinor], [1699500, 1699500]);
  assert.equal(posted.fundingAccount.balanceMinor, 200000);
  assert.deepEqual(posted.entries.map((entry) => [entry.ledgerAccountType, entry.entryType, entry.amountMinor]), [
    ['customer', 'credit', 200000],
    ['funding_adjustment', 'debit', 200000],
  ]);
  assert.equal(posted.entries.reduce((sum, entry) => sum + (entry.entryType === 'credit' ? entry.amountMinor : -entry.amountMinor), 0), 0);
  assert.throws(() => postAdministrativeCredit(customer, { ...funding, currency: 'CHF' }, 100), /CURRENCY_MISMATCH/);
  assert.throws(() => postAdministrativeCredit(customer, funding, 0), /positive minor units/);
});

test('only replica sets and sharded MongoDB topologies support financial transaction processing', () => {
  assert.equal(resolveMongoTransactionTopology({ setName: 'rs0' }), 'replica_set');
  assert.equal(resolveMongoTransactionTopology({ msg: 'isdbgrid' }), 'sharded');
  assert.equal(resolveMongoTransactionTopology({ isWritablePrimary: true }), 'standalone');
});

test('server runtime config rejects example placeholders and accepts Mongo session settings', () => {
  const placeholderConfig = resolveServerRuntimeConfig({
    MONGODB_URI: 'mongodb+srv://<db-user>:<db-password>@<cluster-host>/<database>',
    SESSION_SECRET: 'replace-with-a-random-secret',
  });
  assert.equal(placeholderConfig.hasDatabase, false);
  assert.equal(placeholderConfig.hasCustomerAuth, false);
  assert.deepEqual(placeholderConfig.missingEnvironment, ['MONGODB_URI', 'SESSION_SECRET']);

  const exampleSessionSecret = resolveServerRuntimeConfig({
    MONGODB_URI: 'mongodb://127.0.0.1:27017/veritas?replicaSet=rs0',
    SESSION_SECRET: 'generate-a-random-secret-at-least-32-characters',
  });
  assert.equal(exampleSessionSecret.hasCustomerAuth, false);
  assert.deepEqual(exampleSessionSecret.missingEnvironment, ['SESSION_SECRET']);

  const configured = resolveServerRuntimeConfig({
    MONGODB_URI: 'mongodb+srv://user:pass@cluster.example/db?retryWrites=true&w=majority',
    SESSION_SECRET: 'a-strong-session-secret-with-more-than-32-characters',
  });
  assert.equal(configured.hasDatabase, true);
  assert.equal(configured.hasCustomerAuth, true);
  assert.deepEqual(configured.missingEnvironment, []);
});