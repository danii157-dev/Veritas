const IBAN_LENGTHS = {
  AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BY: 28,
  CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20,
  ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18,
  GR: 27, HR: 21, HU: 28, IE: 22, IL: 23, IS: 26, IT: 27, KW: 30,
  KZ: 20, LB: 28, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24,
  ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24,
  PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31,
  SE: 24, SI: 19, SK: 24, SM: 27, TN: 24, TR: 26, UA: 29, VA: 22,
  XK: 20,
};

const COUNTRY_ACCOUNT_REQUIREMENTS = {
  CH: { identifierType: 'IBAN', routingType: 'BIC/SWIFT', accountPattern: /^[A-Z]{2}\d{2}[A-Z0-9]+$/ },
  US: { identifierType: 'Account number', routingType: 'ABA routing number', accountPattern: /^\d{4,17}$/, routingPattern: /^\d{9}$/ },
  GB: { identifierType: 'Account number', routingType: 'Sort code', accountPattern: /^\d{8}$/, routingPattern: /^\d{6}$/ },
  CA: { identifierType: 'Account number', routingType: 'Institution and transit number', accountPattern: /^\d{5,17}$/, routingPattern: /^\d{8}$/ },
  AU: { identifierType: 'Account number', routingType: 'BSB', accountPattern: /^\d{5,10}$/, routingPattern: /^\d{6}$/ },
};

export function getCountryAccountRequirements(country) {
  return COUNTRY_ACCOUNT_REQUIREMENTS[String(country ?? '').trim().toUpperCase()] ?? {
    identifierType: 'IBAN or account number',
    routingType: 'BIC/SWIFT or local bank identifier',
    accountPattern: /^[A-Z0-9 -]{5,34}$/i,
  };
}

export function validateCountryAccountDetails({ country, accountIdentifierType, accountIdentifier, routingIdentifier = '' }) {
  const code = String(country ?? '').trim().toUpperCase();
  if (!['IBAN', 'account_number'].includes(accountIdentifierType)) return false;
  const requirements = getCountryAccountRequirements(code);
  const identifier = String(accountIdentifier ?? '').replace(/\s/g, '').toUpperCase();
  const routing = String(routingIdentifier ?? '').replace(/[\s-]/g, '');
  if (!/^[A-Z]{2}$/.test(code) || !identifier) return false;
  if (accountIdentifierType === 'IBAN') return validateIban(identifier) && identifier.slice(0, 2) === code;
  if (!requirements.accountPattern.test(identifier)) return false;
  return !requirements.routingPattern || requirements.routingPattern.test(routing);
}

export function parseAmountMinor(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d{1,10}(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

export function formatMinor(minor) {
  if (!Number.isSafeInteger(minor)) throw new TypeError('Amount must be safe integer minor units.');
  return `${Math.trunc(minor / 100)}.${String(Math.abs(minor % 100)).padStart(2, '0')}`;
}

export function normalizeIban(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : '';
}

export function validateIban(value) {
  const iban = normalizeIban(value);
  const country = iban.slice(0, 2);
  if (!IBAN_LENGTHS[country] || iban.length !== IBAN_LENGTHS[country] || !/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits = character >= 'A' && character <= 'Z' ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function selectPaymentRail({ currency, recipientCountry, iban }) {
  const country = String(recipientCountry ?? '').trim().toUpperCase();
  const normalizedIban = normalizeIban(iban);
  if (country === 'CH' && normalizedIban.startsWith('CH') && currency === 'CHF') return 'SIC_PROVIDER_ROUTE';
  if (country === 'CH' && normalizedIban.startsWith('CH') && currency === 'EUR') return 'EUROSIC_PROVIDER_ROUTE';
  if (currency === 'EUR' && ['AT', 'BE', 'CY', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'].includes(country)) return 'SEPA_PROVIDER_ROUTE';
  return 'INTERNATIONAL_PROVIDER_ROUTE';
}

export function calculateFeeMinor(amountMinor, feeBps = 0, fixedFeeMinor = 0) {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !Number.isInteger(feeBps) || feeBps < 0 || !Number.isSafeInteger(fixedFeeMinor) || fixedFeeMinor < 0) {
    throw new TypeError('Fee inputs are invalid.');
  }
  return Math.round((amountMinor * feeBps) / 10_000) + fixedFeeMinor;
}