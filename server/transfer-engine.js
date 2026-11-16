export function reserveExternal(account, totalDebitMinor) {
  if (!Number.isSafeInteger(totalDebitMinor) || totalDebitMinor <= 0) throw new TypeError('Transfer debit must be positive minor units.');
  const availableMinor = account.availableMinor;
  const pendingMinor = account.pendingMinor;
  if (!Number.isSafeInteger(availableMinor) || !Number.isSafeInteger(pendingMinor)) throw new TypeError('Account balances must use integer minor units.');
  if (availableMinor < totalDebitMinor) throw new Error('INSUFFICIENT_AVAILABLE_BALANCE');
  return { ...account, availableMinor: availableMinor - totalDebitMinor, pendingMinor: pendingMinor + totalDebitMinor };
}

export function settleExternal(account, totalDebitMinor) {
  if (!Number.isSafeInteger(totalDebitMinor) || totalDebitMinor <= 0 || account.pendingMinor < totalDebitMinor || account.ledgerMinor < totalDebitMinor) {
    throw new Error('TRANSFER_RESERVATION_MISSING');
  }
  return { ...account, pendingMinor: account.pendingMinor - totalDebitMinor, ledgerMinor: account.ledgerMinor - totalDebitMinor };
}

export function releaseExternal(account, totalDebitMinor) {
  if (!Number.isSafeInteger(totalDebitMinor) || totalDebitMinor <= 0 || account.pendingMinor < totalDebitMinor) {
    throw new Error('TRANSFER_RESERVATION_MISSING');
  }
  return { ...account, availableMinor: account.availableMinor + totalDebitMinor, pendingMinor: account.pendingMinor - totalDebitMinor };
}

export function postInternalTransfer(source, destination, amountMinor) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new TypeError('Transfer amount must be positive minor units.');
  if (source.currency !== destination.currency) throw new Error('CURRENCY_MISMATCH');
  if (source._id?.toString() === destination._id?.toString()) throw new Error('SAME_ACCOUNT');
  if (source.availableMinor < amountMinor || source.ledgerMinor < amountMinor) throw new Error('INSUFFICIENT_AVAILABLE_BALANCE');
  return {
    source: { ...source, availableMinor: source.availableMinor - amountMinor, ledgerMinor: source.ledgerMinor - amountMinor },
    destination: { ...destination, availableMinor: destination.availableMinor + amountMinor, ledgerMinor: destination.ledgerMinor + amountMinor },
    entries: [
      { entryType: 'debit', amountMinor, accountId: source._id },
      { entryType: 'credit', amountMinor, accountId: destination._id },
    ],
  };
}

export function applyProviderStatus(transfer, account, event) {
  if (transfer.providerEventIds?.includes(event.eventId)) return { transfer, account, entries: [], duplicate: true };
  if (!event.eventId || !['accepted', 'processing', 'settled', 'rejected', 'returned', 'reversed'].includes(event.status)) throw new Error('INVALID_PROVIDER_EVENT');

  const priorStatus = transfer.settlementStatus;
  if (priorStatus === 'on_hold') throw new Error('TRANSFER_ON_HOLD');
  const hasReservation = ['pending_authorization', 'pending_review', 'processing', 'accepted', 'reconciliation_required'].includes(priorStatus);
  const nextTransfer = {
    ...transfer,
    providerEventIds: [...(transfer.providerEventIds ?? []), event.eventId],
    settlementStatus: event.status,
    providerReference: event.providerReference ?? transfer.providerReference ?? '',
    providerStatus: event.message || `Provider status: ${event.status}`,
  };
  let nextAccount = { ...account };
  const entries = [];

  if (event.status === 'settled' && hasReservation) {
    nextAccount = settleExternal(nextAccount, transfer.totalDebitMinor);
    nextTransfer.settledAt = event.settledAt ?? new Date().toISOString();
    entries.push({ entryType: 'debit', amountMinor: transfer.totalDebitMinor, description: 'Provider-settled outbound transfer' });
  } else if (['rejected', 'returned'].includes(event.status) && hasReservation) {
    nextAccount = releaseExternal(nextAccount, transfer.totalDebitMinor);
  } else if (['returned', 'reversed'].includes(event.status) && priorStatus === 'settled') {
    nextAccount.ledgerMinor += transfer.totalDebitMinor;
    nextAccount.availableMinor += transfer.totalDebitMinor;
    entries.push({ entryType: 'credit', amountMinor: transfer.totalDebitMinor, description: `Provider ${event.status} reversal` });
  } else if (!['accepted', 'processing'].includes(event.status) || !hasReservation) {
    throw new Error('INVALID_TRANSFER_TRANSITION');
  }

  return { transfer: nextTransfer, account: nextAccount, entries, duplicate: false, priorStatus };
}

export function postOutgoingTransfer(source, clearingAccount, totalDebitMinor) {
  if (!Number.isSafeInteger(totalDebitMinor) || totalDebitMinor <= 0) throw new TypeError('Transfer debit must be positive minor units.');
  if (source.currency !== clearingAccount.currency) throw new Error('CURRENCY_MISMATCH');
  if (!Number.isSafeInteger(source.availableMinor) || !Number.isSafeInteger(source.ledgerMinor) || !Number.isSafeInteger(clearingAccount.balanceMinor)) {
    throw new TypeError('Ledger balances must use integer minor units.');
  }
  if (source.availableMinor < totalDebitMinor || source.ledgerMinor < totalDebitMinor) throw new Error('INSUFFICIENT_AVAILABLE_BALANCE');
  const updatedSource = {
    ...source,
    availableMinor: source.availableMinor - totalDebitMinor,
    ledgerMinor: source.ledgerMinor - totalDebitMinor,
  };
  const updatedClearing = { ...clearingAccount, balanceMinor: clearingAccount.balanceMinor + totalDebitMinor };
  return {
    source: updatedSource,
    clearingAccount: updatedClearing,
    entries: [
      { ledgerAccountType: 'customer', entryType: 'debit', amountMinor: totalDebitMinor, accountId: source._id, balanceAfterMinor: updatedSource.ledgerMinor },
      { ledgerAccountType: 'clearing', entryType: 'credit', amountMinor: totalDebitMinor, clearingAccountId: clearingAccount._id, balanceAfterMinor: updatedClearing.balanceMinor },
    ],
  };
}

export function postAdministrativeCredit(customerAccount, fundingAccount, amountMinor) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new TypeError('Credit must be positive minor units.');
  if (customerAccount.currency !== fundingAccount.currency) throw new Error('CURRENCY_MISMATCH');
  if (!Number.isSafeInteger(customerAccount.availableMinor) || !Number.isSafeInteger(customerAccount.ledgerMinor) || !Number.isSafeInteger(fundingAccount.balanceMinor)) {
    throw new TypeError('Ledger balances must use integer minor units.');
  }
  if (customerAccount.availableMinor + amountMinor > Number.MAX_SAFE_INTEGER || customerAccount.ledgerMinor + amountMinor > Number.MAX_SAFE_INTEGER || fundingAccount.balanceMinor + amountMinor > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('Credit exceeds safe integer balance limits.');
  }

  const updatedCustomer = {
    ...customerAccount,
    availableMinor: customerAccount.availableMinor + amountMinor,
    ledgerMinor: customerAccount.ledgerMinor + amountMinor,
  };
  const updatedFunding = { ...fundingAccount, balanceMinor: fundingAccount.balanceMinor + amountMinor };
  return {
    customer: updatedCustomer,
    fundingAccount: updatedFunding,
    entries: [
      { ledgerAccountType: 'customer', entryType: 'credit', amountMinor, accountId: customerAccount._id, balanceAfterMinor: updatedCustomer.ledgerMinor },
      { ledgerAccountType: 'funding_adjustment', entryType: 'debit', amountMinor, fundingAccountId: fundingAccount._id, balanceAfterMinor: updatedFunding.balanceMinor },
    ],
  };
}