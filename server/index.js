import dotenv from 'dotenv';
dotenv.config({ path: new URL('./.env', import.meta.url) });
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { generatePaymentReceiptPdf } from './receipt-pdf.js';
import { createPaymentProvider } from './payment-provider.js';
import { resolveMongoTransactionTopology, resolveServerRuntimeConfig } from './runtime-config.js';
import { calculateFeeMinor, formatMinor, getCountryAccountRequirements, parseAmountMinor, selectPaymentRail, validateCountryAccountDetails, validateIban } from './transfer-domain.js';
import { applyProviderStatus, postInternalTransfer, postOutgoingTransfer } from './transfer-engine.js';

const { missingEnvironment } = resolveServerRuntimeConfig(process.env);
const previewMode = missingEnvironment.length > 0;
if (missingEnvironment.length) console.warn(`Database-backed customer access and financial processing are disabled; missing server configuration: ${missingEnvironment.join(', ')}. Set these in server/.env.`);

const app = express();
const port = Number(process.env.PORT ?? 4000);
const vercelOrigin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
const allowedOrigins = [process.env.CLIENT_ORIGIN, vercelOrigin];
if (process.env.NODE_ENV !== 'production') allowedOrigins.push('http://localhost:5173');
const paymentProvider = createPaymentProvider({ mode: process.env.PAYMENT_PROVIDER_MODE ?? 'unconfigured' });
const transferQuoteSecret = process.env.TRANSFER_QUOTE_SECRET || process.env.SESSION_SECRET || randomUUID();

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    const localDevelopmentOrigin = process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin ?? '');
    if (!origin || allowedOrigins.includes(origin) || localDevelopmentOrigin) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS.'));
  },
}));
app.use(express.json({
  limit: '16kb',
  verify(request, _response, buffer) {
    request.rawBody = buffer;
  },
}));
app.use((request, _response, next) => {
  const cookieHeader = request.headers.cookie ?? '';
  request.cookies = Object.fromEntries(cookieHeader.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    const name = separator < 0 ? part : part.slice(0, separator);
    const value = separator < 0 ? '' : part.slice(separator + 1);
    try { return [name, decodeURIComponent(value)]; } catch { return [name, '']; }
  }));
  next();
});
app.use((request, response, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
  if (request.path === '/api/provider/webhook') return next();
  const origin = request.get('origin') ?? '';
  const localDevelopmentOrigin = process.env.NODE_ENV !== 'production' && /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
  if (!origin || (!allowedOrigins.includes(origin) && !localDevelopmentOrigin)) return response.status(403).json({ error: 'Request origin is not allowed.' });
  return next();
});
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));

const scrypt = promisify(scryptCallback);
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const isProduction = process.env.NODE_ENV === 'production';
const cookieName = isProduction ? '__Host-veritas_session' : 'veritas_session';

const customerSchema = new mongoose.Schema({
  customerReference: { type: String, required: true, unique: true, index: true },
  firstName: { type: String, required: true, trim: true, maxlength: 80 },
  middleName: { type: String, default: '', trim: true, maxlength: 80 },
  lastName: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  phone: { type: String, required: true, trim: true, maxlength: 40 },
  dateOfBirth: { type: Date, required: true },
  countryOfResidence: { type: String, required: true, trim: true, maxlength: 80 },
  residentialAddress: { type: String, required: true, trim: true, maxlength: 300 },
  passwordHash: { type: String, required: true, select: false },
  status: { type: String, required: true, enum: ['active', 'locked', 'closed'], default: 'active' },
  role: { type: String, required: true, enum: ['customer', 'admin'], default: 'customer' },
  permissions: { type: [String], default: [] },
}, { timestamps: true, strict: true });
const Customer = mongoose.model('Customer', customerSchema);

const customerSessionSchema = new mongoose.Schema({
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
  tokenHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true, index: { expires: 0 } },
  authenticatedAt: { type: Date, required: true, default: Date.now },
  lastSeenAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true, strict: true });
customerSessionSchema.index({ tokenHash: 1 }, { unique: true, name: 'uniq_customer_session_token' });
const CustomerSession = mongoose.model('CustomerSession', customerSessionSchema);

const registrationLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });

function hashSessionToken(token) {
  return createHmac('sha256', process.env.SESSION_SECRET).update(token).digest('hex');
}

function setSessionCookie(response, token, expiresAt) {
  const maxAge = Math.max(0, expiresAt.getTime() - Date.now());
  response.cookie(cookieName, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
    maxAge,
  });
}

function clearSessionCookie(response) {
  response.clearCookie(cookieName, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
}

function customerResponse(customer) {
  return {
    id: customer._id.toString(),
    customerReference: customer.customerReference,
    firstName: customer.firstName,
    middleName: customer.middleName,
    lastName: customer.lastName,
    fullName: [customer.firstName, customer.middleName, customer.lastName].filter(Boolean).join(' '),
    email: customer.email,
    phone: customer.phone,
    dateOfBirth: customer.dateOfBirth,
    countryOfResidence: customer.countryOfResidence,
    residentialAddress: customer.residentialAddress,
    status: customer.status,
    createdAt: customer.createdAt,
  };
}

app.post('/api/auth/register', registrationLimiter, async (request, response, next) => {
  if (!requireCustomerAuthConfiguration(response)) return;
  try {
    const {
      firstName, middleName = '', lastName, email, phone, dateOfBirth,
      countryOfResidence, residentialAddress, password, confirmPassword, acceptTerms,
    } = request.body ?? {};
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const parsedDateOfBirth = typeof dateOfBirth === 'string' ? new Date(`${dateOfBirth}T00:00:00.000Z`) : null;
    const minimumBirthDate = new Date();
    minimumBirthDate.setUTCFullYear(minimumBirthDate.getUTCFullYear() - 18);
    const strongPassword = typeof password === 'string' && password.length >= 12 && password.length <= 128
      && /[a-z]/.test(password) && /[A-Z]/.test(password) && /\d/.test(password) && /[^A-Za-z0-9]/.test(password);
    if (typeof firstName !== 'string' || firstName.trim().length < 1 || firstName.length > 80
      || typeof middleName !== 'string' || middleName.length > 80
      || typeof lastName !== 'string' || lastName.trim().length < 1 || lastName.length > 80
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254
      || typeof phone !== 'string' || phone.trim().length < 5 || phone.length > 40
      || !parsedDateOfBirth || !Number.isFinite(parsedDateOfBirth.getTime()) || parsedDateOfBirth > minimumBirthDate
      || typeof countryOfResidence !== 'string' || !countryOfResidence.trim() || countryOfResidence.length > 80
      || typeof residentialAddress !== 'string' || residentialAddress.trim().length < 8 || residentialAddress.length > 300
      || !strongPassword || password !== confirmPassword || acceptTerms !== true) {
      return response.status(400).json({ error: 'Registration details are invalid. Complete every required field, confirm the terms, use a password with 12+ characters including uppercase, lowercase, number and symbol, and be at least 18.' });
    }
    const passwordSalt = randomBytes(16).toString('hex');
    const passwordKey = await scrypt(password, passwordSalt, 64);
    const passwordHash = `scrypt$${passwordSalt}$${Buffer.from(passwordKey).toString('hex')}`;

    const customer = await Customer.create({
      customerReference: `VPB-C-${randomBytes(8).toString('hex').toUpperCase()}`,
      firstName: firstName.trim(), middleName: middleName.trim(), lastName: lastName.trim(),
      email: normalizedEmail, phone: phone.trim(), dateOfBirth: parsedDateOfBirth,
      countryOfResidence: countryOfResidence.trim(), residentialAddress: residentialAddress.trim(), passwordHash,
    });

    const customerId = customer._id.toString();
    await Profile.create({
      customerId, fullName: [customer.firstName, customer.middleName, customer.lastName].filter(Boolean).join(' '),
      email: customer.email, phone: customer.phone, residencyCountry: customer.countryOfResidence,
    });
    await Account.create(['EUR', 'CHF'].map((currency) => ({
      customerId, currency, accountNumber: `VPB-INT-${currency}-${randomBytes(10).toString('hex').toUpperCase()}`,
      ledgerBalance: 0, availableBalance: 0, pendingBalance: 0,
      ledgerMinor: 0, availableMinor: 0, pendingMinor: 0,
      internalTransferEnabled: true,
    })));

    return response.status(201).json({ customer: customerResponse(customer), message: 'Customer profile created. Accounts are created with zero balances; no funds have been deposited.' });
  } catch (error) {
    if (error?.code === 11000) return response.status(409).json({ error: 'An account with this email address already exists.' });
    return next(error);
  }
});

app.post('/api/auth/login', loginLimiter, async (request, response, next) => {
  if (!requireCustomerAuthConfiguration(response)) return;
  try {
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!email || !password) return response.status(400).json({ error: 'Email and password are required.' });
    const customer = await Customer.findOne({ email }).select('+passwordHash');
    if (!customer || customer.status !== 'active') return response.status(401).json({ error: 'Email or password is incorrect.' });
    const [algorithm, salt, hash] = customer.passwordHash.split('$');
    if (algorithm !== 'scrypt' || !salt || !hash) return response.status(401).json({ error: 'Email or password is incorrect.' });
    const suppliedKey = Buffer.from(await scrypt(password, salt, 64));
    const storedKey = Buffer.from(hash, 'hex');
    if (suppliedKey.length !== storedKey.length || !timingSafeEqual(suppliedKey, storedKey)) return response.status(401).json({ error: 'Email or password is incorrect.' });
    const rawToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + sessionLifetimeMs);
    await CustomerSession.create({ customerId: customer._id, tokenHash: hashSessionToken(rawToken), expiresAt, authenticatedAt: new Date(), lastSeenAt: new Date() });
    setSessionCookie(response, rawToken, expiresAt);
    return response.json({ customer: customerResponse(customer) });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/auth/session', async (request, response, next) => {
  if (!requireCustomerAuthConfiguration(response)) return;
  try {
    const token = request.cookies?.[cookieName];
    if (!token) return response.status(401).json({ error: 'Sign in to continue.' });
    const session = await CustomerSession.findOne({ tokenHash: hashSessionToken(token), expiresAt: { $gt: new Date() } });
    if (!session) {
      clearSessionCookie(response);
      return response.status(401).json({ error: 'Your session expired. Sign in again.' });
    }
    const customer = await Customer.findOne({ _id: session.customerId, status: 'active' });
    if (!customer) {
      await CustomerSession.deleteOne({ _id: session._id });
      clearSessionCookie(response);
      return response.status(401).json({ error: 'Customer account is unavailable.' });
    }
    session.lastSeenAt = new Date();
    await session.save();
    return response.json({ customer: customerResponse(customer) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/auth/logout', async (request, response, next) => {
  try {
    const token = request.cookies?.[cookieName];
    if (token && mongoose.connection.readyState === 1) await CustomerSession.deleteOne({ tokenHash: hashSessionToken(token) });
    clearSessionCookie(response);
    return response.status(204).end();
  } catch (error) {
    return next(error);
  }
});

const profileSchema = new mongoose.Schema({
  customerId: { type: String, required: true, index: true },
  fullName: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, trim: true, lowercase: true },
  phone: { type: String, default: '', maxlength: 40 },
  residencyCountry: { type: String, default: '', maxlength: 80 },
}, { timestamps: true });
profileSchema.index({ customerId: 1 }, { unique: true, name: 'uniq_customer_profile' });

const beneficiarySchema = new mongoose.Schema({
  customerId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
  iban: { type: String, default: '', trim: true, maxlength: 34 },
  accountIdentifierType: { type: String, default: 'IBAN', trim: true, maxlength: 40 },
  accountIdentifier: { type: String, default: '', trim: true, maxlength: 80 },
  routingIdentifier: { type: String, default: '', trim: true, maxlength: 80 },
  bankName: { type: String, default: '', trim: true, maxlength: 120 },
  bic: { type: String, default: '', trim: true, uppercase: true, maxlength: 11 },
  country: { type: String, default: '', trim: true, uppercase: true, maxlength: 2 },
  address: { type: String, default: '', trim: true, maxlength: 300 },
  currency: { type: String, required: true, enum: ['EUR', 'CHF'] },
  status: { type: String, required: true, enum: ['pending_verification', 'verified'], default: 'pending_verification' },
}, { timestamps: true });

const accountSchema = new mongoose.Schema({
  customerId: { type: String, required: true, index: true },
  currency: { type: String, required: true, enum: ['EUR', 'CHF'] },
  accountNumber: { type: String, required: true, trim: true, maxlength: 40 },
  ledgerBalance: { type: Number, required: true, min: 0, default: 0 },
  availableBalance: { type: Number, required: true, min: 0, default: 0 },
  pendingBalance: { type: Number, required: true, min: 0, default: 0 },
  ledgerMinor: { type: Number, required: true, min: 0, default: 0 },
  availableMinor: { type: Number, required: true, min: 0, default: 0 },
  pendingMinor: { type: Number, required: true, min: 0, default: 0 },
  status: { type: String, required: true, enum: ['active'], default: 'active' },
  internalTransferAlias: { type: String, default: '', trim: true, maxlength: 80 },
  internalTransferEnabled: { type: Boolean, default: false },
}, { timestamps: true });
accountSchema.index({ customerId: 1, currency: 1 }, { unique: true, name: 'uniq_customer_currency' });
accountSchema.index({ accountNumber: 1 }, { unique: true, partialFilterExpression: { accountNumber: { $type: 'string', $gt: '' } }, name: 'uniq_internal_account_number' });

const ledgerEntrySchema = new mongoose.Schema({
  customerId: { type: String, required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', index: true },
  accountCurrency: { type: String, required: true, enum: ['EUR', 'CHF'] },
  transferId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transfer', index: true },
  adminCreditId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminCredit', index: true },
  entryType: { type: String, required: true, enum: ['debit', 'credit'] },
  amount: { type: Number, required: true, min: 0 },
  amountMinor: { type: Number, required: true, min: 0 },
  balanceAfter: { type: Number, required: true },
  description: { type: String, required: true, trim: true, maxlength: 160 },
  reference: { type: String, default: '', trim: true, maxlength: 140 },
  status: { type: String, required: true, enum: ['posted', 'pending'], default: 'posted' },
}, { timestamps: true });

const transferSchema = new mongoose.Schema({
  customerId: { type: String, required: true, index: true },
  senderName: { type: String, default: '', trim: true, maxlength: 120 },
  recipientCustomerId: { type: String, default: '', index: true },
  transactionReference: { type: String, required: true, unique: true, index: true },
  category: { type: String, required: true, enum: ['internal', 'domestic', 'international'] },
  paymentRail: { type: String, required: true, enum: ['internal_ledger', 'SIC_PROVIDER_ROUTE', 'EUROSIC_PROVIDER_ROUTE', 'SEPA_PROVIDER_ROUTE', 'INTERNATIONAL_PROVIDER_ROUTE'] },
  sourceAccountCurrency: { type: String, required: true, enum: ['EUR', 'CHF'] },
  senderAccountNumber: { type: String, default: '', maxlength: 40 },
  balanceAfterMinor: { type: Number, default: null, min: 0 },
  amountMinor: { type: Number, required: true, min: 1 },
  feeMinor: { type: Number, default: 0, min: 0 },
  totalDebitMinor: { type: Number, required: true, min: 1 },
  amount: { type: Number, required: true, min: 0.01 },
  fee: { type: Number, default: 0, min: 0 },
  totalDebit: { type: Number, required: true, min: 0.01 },
  currency: { type: String, required: true, enum: ['EUR', 'CHF'] },
  reference: { type: String, default: '', trim: true, maxlength: 140 },
  beneficiaryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Beneficiary', default: null },
  beneficiaryName: { type: String, required: true, trim: true, maxlength: 120 },
  beneficiaryIban: { type: String, default: '', trim: true, maxlength: 34 },
  beneficiaryAccountIdentifierType: { type: String, default: 'IBAN', trim: true, maxlength: 40 },
  beneficiaryAccountIdentifier: { type: String, default: '', trim: true, maxlength: 80 },
  beneficiaryRoutingIdentifier: { type: String, default: '', trim: true, maxlength: 80 },
  beneficiaryBankName: { type: String, default: '', maxlength: 120 },
  beneficiaryBic: { type: String, default: '', maxlength: 11 },
  beneficiaryCountry: { type: String, required: true, maxlength: 2 },
  beneficiaryAddress: { type: String, default: '', maxlength: 300 },
  intermediaryBank: { type: String, default: '', maxlength: 200 },
  purpose: { type: String, default: '', maxlength: 140 },
  description: { type: String, default: '', maxlength: 280 },
  executionDate: { type: Date, required: true },
  chargeBearer: { type: String, enum: ['SHA', 'OUR', 'BEN'], default: 'SHA' },
  settlementStatus: { type: String, required: true, enum: ['pending_authorization', 'pending_review', 'processing', 'accepted', 'reconciliation_required', 'successful', 'settled', 'rejected', 'returned', 'reversed', 'on_hold'], default: 'pending_authorization' },
  heldFromStatus: { type: String, default: '' },
  providerStatus: { type: String, default: 'Awaiting provider confirmation', maxlength: 120 },
  providerName: { type: String, default: '', maxlength: 120 },
  providerReference: { type: String, default: '', maxlength: 120 },
  executionDate: { type: Date, required: true },
  settledAt: { type: Date, default: null },
  reversalOf: { type: mongoose.Schema.Types.ObjectId, ref: 'Transfer', default: null },
  providerEventIds: [{ type: String }],
  idempotencyKey: { type: String, default: '' },
  idempotencyFingerprint: { type: String, default: '' },
  ledgerEntries: [{ type: mongoose.Schema.Types.ObjectId, ref: 'LedgerEntry' }],
  receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'TransferReceipt', default: null },
  receiptNumber: { type: String, default: '', maxlength: 40 },
  clearingLedgerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClearingLedgerEntry', default: null },
}, { timestamps: true });

transferSchema.index(
  { customerId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string', $gt: '' } }, name: 'uniq_customer_idempotency' },
);

const Profile = mongoose.model('Profile', profileSchema);
const Beneficiary = mongoose.model('Beneficiary', beneficiarySchema);
const Account = mongoose.model('Account', accountSchema);
const LedgerEntry = mongoose.model('LedgerEntry', ledgerEntrySchema);
const Transfer = mongoose.model('Transfer', transferSchema);

const clearingAccountSchema = new mongoose.Schema({
  currency: { type: String, required: true, enum: ['EUR', 'CHF'], unique: true },
  accountName: { type: String, required: true, default: 'Outgoing payments clearing' },
  balanceMinor: { type: Number, required: true, default: 0 },
}, { timestamps: true });
const ClearingAccount = mongoose.model('ClearingAccount', clearingAccountSchema);

const transferReceiptSchema = new mongoose.Schema({
  transferId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transfer', default: null },
  adminCreditId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminCredit', default: null },
  customerId: { type: String, required: true, index: true },
  receiptNumber: { type: String, required: true, unique: true, index: true },
  documentType: { type: String, required: true },
  status: { type: String, required: true },
  generatedAt: { type: Date, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  pdf: { type: Buffer, required: true },
}, { timestamps: true, strict: true });
transferReceiptSchema.index({ transferId: 1 }, { unique: true, partialFilterExpression: { transferId: { $type: 'objectId' } }, name: 'uniq_receipt_transfer' });
transferReceiptSchema.index({ adminCreditId: 1 }, { unique: true, partialFilterExpression: { adminCreditId: { $type: 'objectId' } }, name: 'uniq_receipt_admin_credit' });
const TransferReceipt = mongoose.model('TransferReceipt', transferReceiptSchema);

const clearingLedgerEntrySchema = new mongoose.Schema({
  clearingAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'ClearingAccount', required: true, index: true },
  transferId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transfer', required: true, index: true },
  currency: { type: String, required: true, enum: ['EUR', 'CHF'] },
  entryType: { type: String, required: true, enum: ['debit', 'credit'] },
  amountMinor: { type: Number, required: true, min: 1 },
  balanceAfterMinor: { type: Number, required: true, min: 0 },
  reference: { type: String, required: true, unique: true },
  description: { type: String, required: true, maxlength: 160 },
}, { timestamps: true, strict: true });
const ClearingLedgerEntry = mongoose.model('ClearingLedgerEntry', clearingLedgerEntrySchema);

const adminCreditSchema = new mongoose.Schema({
  customerId: { type: String, required: true, index: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true, index: true },
  actorUid: { type: String, required: true, index: true },
  transactionReference: { type: String, required: true, unique: true, index: true },
  administrativeReference: { type: String, required: true, trim: true, maxlength: 140 },
  idempotencyKey: { type: String, required: true, maxlength: 128 },
  requestFingerprint: { type: String, required: true, maxlength: 64 },
  currency: { type: String, required: true, enum: ['EUR', 'CHF'] },
  amountMinor: { type: Number, required: true, min: 1 },
  reason: { type: String, required: true, trim: true, maxlength: 280 },
  previousBalanceMinor: { type: Number, required: true, min: 0 },
  newBalanceMinor: { type: Number, required: true, min: 0 },
  ledgerEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'LedgerEntry', default: null },
  fundingEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'FundingAdjustmentEntry', default: null },
  receiptId: { type: mongoose.Schema.Types.ObjectId, ref: 'TransferReceipt', default: null },
  status: { type: String, required: true, enum: ['posted'], default: 'posted' },
}, { timestamps: true, strict: true });
adminCreditSchema.index({ actorUid: 1, idempotencyKey: 1 }, { unique: true });
adminCreditSchema.index({ customerId: 1, createdAt: -1 });
const AdminCredit = mongoose.model('AdminCredit', adminCreditSchema);

const fundingAdjustmentAccountSchema = new mongoose.Schema({
  currency: { type: String, required: true, enum: ['EUR', 'CHF'] },
  accountName: { type: String, required: true, default: 'Administrative funding adjustments' },
  balanceMinor: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true, strict: true });
fundingAdjustmentAccountSchema.index({ currency: 1 }, { unique: true, name: 'uniq_funding_adjustment_currency' });
const FundingAdjustmentAccount = mongoose.model('FundingAdjustmentAccount', fundingAdjustmentAccountSchema);

const fundingAdjustmentEntrySchema = new mongoose.Schema({
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'FundingAdjustmentAccount', required: true, index: true },
  adminCreditId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminCredit', required: true, index: true },
  currency: { type: String, required: true, enum: ['EUR', 'CHF'] },
  entryType: { type: String, required: true, enum: ['debit'] },
  amountMinor: { type: Number, required: true, min: 1 },
  balanceAfterMinor: { type: Number, required: true, min: 0 },
  reference: { type: String, required: true, unique: true },
  description: { type: String, required: true, trim: true, maxlength: 280 },
}, { timestamps: true, strict: true });
const FundingAdjustmentEntry = mongoose.model('FundingAdjustmentEntry', fundingAdjustmentEntrySchema);

const administrativeAuditSchema = new mongoose.Schema({
  actorUid: { type: String, required: true, index: true },
  action: { type: String, required: true, enum: ['account_credit_posted'] },
  targetUid: { type: String, required: true, index: true },
  entityId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  reference: { type: String, required: true },
  details: { type: mongoose.Schema.Types.Mixed, required: true },
}, { timestamps: true, strict: true });
const AdministrativeAudit = mongoose.model('AdministrativeAudit', administrativeAuditSchema);

const transferEventSchema = new mongoose.Schema({
  transferId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transfer', required: true, index: true },
  customerId: { type: String, required: true, index: true },
  eventType: { type: String, required: true, maxlength: 80 },
  fromStatus: { type: String, default: '' },
  toStatus: { type: String, default: '' },
  actor: { type: String, required: true, maxlength: 160 },
  source: { type: String, required: true, enum: ['customer', 'provider', 'operations', 'system'] },
  details: { type: mongoose.Schema.Types.Mixed, default: {} },
  providerEventId: { type: String, default: '', maxlength: 160 },
}, { timestamps: true, strict: true });
transferEventSchema.index({ providerEventId: 1 }, { unique: true, partialFilterExpression: { providerEventId: { $type: 'string', $gt: '' } } });
const TransferEvent = mongoose.model('TransferEvent', transferEventSchema);

let mongoTransactionTopology = 'not_configured';
let mongoConnectionStatus = process.env.MONGODB_URI ? 'disconnected' : 'missing_uri';
let mongoConnectionError = '';

function requireFinancialMongo(response) {
  if (mongoose.connection.readyState !== 1) {
    response.status(503).json({ error: mongoConnectionStatus === 'missing_uri'
      ? 'Financial processing is unavailable: MONGODB_URI is missing from project/server/.env.'
      : 'Financial processing is unavailable: the configured MongoDB server is not connected.' });
    return false;
  }
  if (!['replica_set', 'sharded'].includes(mongoTransactionTopology)) {
    response.status(503).json({ error: `Financial processing is unavailable: MongoDB topology is ${mongoTransactionTopology}; configure a replica set or sharded cluster.` });
    return false;
  }
  return true;
}

function requireMongoDatabase(response) {
  if (mongoose.connection.readyState !== 1) {
    response.status(503).json({ error: missingEnvironment.includes('MONGODB_URI')
      ? 'MongoDB is not configured. Set MONGODB_URI in server/.env.'
      : 'MongoDB is not connected. Check MONGODB_URI and network access.' });
    return false;
  }
  return true;
}

function requireCustomerAuthConfiguration(response) {
  if (missingEnvironment.includes('SESSION_SECRET')) {
    response.status(503).json({ error: 'Customer sessions are unavailable. Set SESSION_SECRET to a random value of at least 32 characters in server/.env.' });
    return false;
  }
  return requireMongoDatabase(response);
}

function formatMoney(value) {
  return Number(value).toFixed(2);
}

function moneyFromMinor(minor) {
  return formatMinor(minor);
}

function signTransferQuote(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', transferQuoteSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyTransferQuote(token, uid, expected) {
  if (typeof token !== 'string') return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expectedSignature = createHmac('sha256', transferQuoteSecret).update(encoded).digest();
  let suppliedSignature;
  try { suppliedSignature = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return null; }
  if (payload.uid !== uid || payload.expiresAt <= Date.now()) return null;
  if (payload.category !== expected.category || payload.sourceCurrency !== expected.sourceCurrency || payload.currency !== expected.currency || payload.amountMinor !== expected.amountMinor || payload.chargeBearer !== expected.chargeBearer) return null;
  return payload;
}

function serializeAccount(account) {
  return {
    currency: account.currency,
    balance: moneyFromMinor(account.ledgerMinor),
    available: moneyFromMinor(account.availableMinor),
    pending: moneyFromMinor(account.pendingMinor),
    number: account.accountNumber,
  };
}

function serializeTransfer(transfer) {
  return {
    id: transfer._id.toString(),
    transactionReference: transfer.transactionReference,
    category: transfer.category,
    paymentRail: transfer.paymentRail,
    beneficiaryName: transfer.beneficiaryName,
    beneficiaryIban: transfer.beneficiaryIban,
    beneficiaryAccountIdentifierType: transfer.beneficiaryAccountIdentifierType,
    beneficiaryAccountIdentifier: transfer.beneficiaryAccountIdentifier,
    beneficiaryRoutingIdentifier: transfer.beneficiaryRoutingIdentifier,
    amount: moneyFromMinor(transfer.amountMinor),
    amountMinor: transfer.amountMinor,
      currency: transfer.currency,
      transferId: transfer._id.toString(),
    reference: transfer.reference,
    status: transfer.settlementStatus,
    providerStatus: transfer.providerStatus,
    providerReference: transfer.providerReference,
    sourceAccountCurrency: transfer.sourceAccountCurrency,
    senderAccountNumber: transfer.senderAccountNumber,
    balanceAfter: Number.isSafeInteger(transfer.balanceAfterMinor) ? moneyFromMinor(transfer.balanceAfterMinor) : '',
    createdAt: transfer.createdAt,
    fee: moneyFromMinor(transfer.feeMinor || 0),
    totalDebit: moneyFromMinor(transfer.totalDebitMinor),
    beneficiaryBankName: transfer.beneficiaryBankName,
    beneficiaryBic: transfer.beneficiaryBic,
    beneficiaryCountry: transfer.beneficiaryCountry,
    purpose: transfer.purpose,
    description: transfer.description,
    executionDate: transfer.executionDate,
    settledAt: transfer.settledAt,
    providerStatus: transfer.providerStatus,
    providerReference: transfer.providerReference,
    providerName: transfer.providerName,
    receiptNumber: transfer.receiptNumber,
  };
}

async function ensureTransferReceipt(transferId) {
  let transfer = await Transfer.findById(transferId).lean();
  if (!transfer) throw new Error('TRANSFER_NOT_FOUND');
  const existingReceipt = await TransferReceipt.findOne({ transferId: transfer._id }).lean();
  if (existingReceipt) return existingReceipt;

  if (!transfer.receiptNumber) {
    transfer = await Transfer.findOneAndUpdate(
      { _id: transfer._id, $or: [{ receiptNumber: '' }, { receiptNumber: { $exists: false } }, { receiptNumber: null }] },
      { $set: { receiptNumber: `RCP-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}` } },
      { new: true },
    ).lean() ?? await Transfer.findById(transfer._id).lean();
  }
  const [profile, account] = await Promise.all([
    Profile.findOne({ customerId: transfer.customerId }).lean(),
    Account.findOne({ customerId: transfer.customerId, currency: transfer.sourceAccountCurrency }).lean(),
  ]);
  const receiptPayload = {
    receiptNumber: transfer.receiptNumber,
    brand: 'VERITAS PRIVATE BANK',
    documentType: 'PAYMENT CONFIRMATION',
    transactionReference: transfer.transactionReference,
    status: 'SUCCESSFUL - PROCESSED BY VERITAS',
    senderName: transfer.senderName || profile?.fullName || 'Private client',
    senderAccount: transfer.senderAccountNumber || account?.accountNumber || `${transfer.sourceAccountCurrency} Private Account`,
    recipientName: transfer.beneficiaryName,
    recipientBankName: transfer.beneficiaryBankName,
    recipientCountry: transfer.beneficiaryCountry,
    recipientAccountIdentifierType: transfer.beneficiaryAccountIdentifierType,
    recipientAccountIdentifier: transfer.beneficiaryAccountIdentifier || transfer.beneficiaryIban,
    recipientRoutingIdentifier: transfer.beneficiaryRoutingIdentifier,
    recipientBic: transfer.beneficiaryBic,
    currency: transfer.currency,
    amount: moneyFromMinor(transfer.amountMinor),
    fee: moneyFromMinor(transfer.feeMinor || 0),
    totalDebit: moneyFromMinor(transfer.totalDebitMinor),
    paymentReference: transfer.reference,
    description: transfer.description,
    processedAt: transfer.createdAt,
    balanceAfter: Number.isSafeInteger(transfer.balanceAfterMinor) ? moneyFromMinor(transfer.balanceAfterMinor) : '',
    disclaimer: transfer.category === 'internal'
      ? 'Confirms the debit and recipient credit posted to Veritas customer ledgers.'
      : 'Confirms processing in the Veritas application and posting to its outgoing-payments clearing ledger. It does not confirm delivery to the beneficiary bank.',
  };
  const pdf = await generatePaymentReceiptPdf(receiptPayload);
  let receipt;
  try {
    [receipt] = await TransferReceipt.create([{
      transferId: transfer._id, customerId: transfer.customerId, receiptNumber: transfer.receiptNumber,
      documentType: receiptPayload.documentType, status: receiptPayload.status,
      generatedAt: new Date(), payload: receiptPayload, pdf,
    }]);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    receipt = await TransferReceipt.findOne({ transferId: transfer._id }).lean();
    if (!receipt) throw error;
  }
  await Transfer.updateOne({ _id: transfer._id }, { $set: { receiptId: receipt._id, receiptNumber: receipt.receiptNumber } });
  return receipt;
}

async function authenticate(request, response, next) {
  try {
    if (!requireCustomerAuthConfiguration(response)) return;
    const token = request.cookies?.[cookieName];
    if (!token) return response.status(401).json({ error: 'Sign in to continue.' });
    const session = await CustomerSession.findOne({ tokenHash: hashSessionToken(token), expiresAt: { $gt: new Date() } });
    if (!session) {
      clearSessionCookie(response);
      return response.status(401).json({ error: 'Your session expired. Sign in again.' });
    }
    const customer = await Customer.findOne({ _id: session.customerId, status: 'active' });
    if (!customer) {
      await CustomerSession.deleteOne({ _id: session._id });
      clearSessionCookie(response);
      return response.status(401).json({ error: 'Customer account is unavailable.' });
    }
    request.customer = customer;
    request.user = {
      uid: customer._id.toString(),
      email: customer.email,
      role: customer.role,
      permissions: customer.permissions,
      customerId: customer._id,
      auth_time: Math.floor(session.authenticatedAt.getTime() / 1000),
      customerReference: customer.customerReference,
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

app.get('/api/health', async (_request, response) => {
  if (mongoose.connection.readyState === 1) {
    try {
      await mongoose.connection.db.admin().command({ ping: 1 }, { maxTimeMS: 2000 });
      mongoConnectionStatus = 'connected';
      mongoConnectionError = '';
    } catch (error) {
      mongoConnectionStatus = 'unreachable';
      mongoConnectionError = error.name || 'MongoDBError';
    }
  } else if (mongoConnectionStatus !== 'missing_uri') {
    mongoConnectionStatus = 'disconnected';
  }
  const databaseConnected = mongoConnectionStatus === 'connected';
  const mongoTransactionSupport = ['replica_set', 'sharded'].includes(mongoTransactionTopology);
  return response.json({
    status: 'ok',
    databaseConnected,
    databaseStatus: mongoConnectionStatus,
    databaseError: mongoConnectionError,
    transactionTopology: mongoTransactionTopology,
    financialProcessingAvailable: databaseConnected && mongoTransactionSupport && !missingEnvironment.includes('SESSION_SECRET'),
    missingServerConfiguration: missingEnvironment,
    customerAuthentication: 'mongodb_sessions',
    customerAuthConfigured: !missingEnvironment.includes('SESSION_SECRET'),
    mongoTransactionSupport,
  });
});

app.get('/api/profile', authenticate, async (request, response, next) => {
  try {
    const customer = await Customer.findById(request.user.uid).lean();
    if (!customer) return response.status(404).json({ error: 'Customer profile was not found.' });
    return response.json({
      customerReference: customer.customerReference,
      firstName: customer.firstName,
      middleName: customer.middleName,
      lastName: customer.lastName,
      fullName: [customer.firstName, customer.middleName, customer.lastName].filter(Boolean).join(' '),
      email: customer.email,
      phone: customer.phone,
      dateOfBirth: customer.dateOfBirth,
      countryOfResidence: customer.countryOfResidence,
      residentialAddress: customer.residentialAddress,
      status: customer.status,
      createdAt: customer.createdAt,
    });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/accounts', authenticate, async (request, response, next) => {
  try {
    const accounts = await Account.find({ customerId: request.user.uid }).sort({ currency: 1 }).lean();
    return response.json(accounts.map(serializeAccount));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/internal-recipients', authenticate, async (request, response, next) => {
  try {
    const accounts = await Account.find({ customerId: { $ne: request.user.uid }, status: 'active', internalTransferEnabled: true, accountNumber: { $ne: '' } }).select('_id customerId currency accountNumber internalTransferAlias').lean();
    const profiles = await Profile.find({ customerId: { $in: accounts.map((account) => account.customerId) } }).select('customerId fullName email').lean();
    const profileByUid = new Map(profiles.map((profile) => [profile.customerId, profile]));
    const excludedTestCustomerIds = new Set(profiles
      .filter((profile) => /^test\s+user$/i.test(profile.fullName.trim()) || profile.email?.toLowerCase() === 'demo20261115105325@example.com')
      .map((profile) => profile.customerId));
    return response.json(accounts.filter((account) => account.accountNumber
      && !excludedTestCustomerIds.has(account.customerId)
      && !/^test\s+user$/i.test(String(account.internalTransferAlias ?? '').trim())).map((account) => ({
      id: account._id.toString(),
      accountNumber: account.accountNumber,
      currency: account.currency,
      recipientName: account.internalTransferAlias || profileByUid.get(account.customerId)?.fullName || 'Veritas account holder',
    })));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/transfers/quote', authenticate, async (request, response, next) => {
  try {
    const { category, sourceAccountCurrency, currency, amount, chargeBearer = 'SHA' } = request.body ?? {};
    const amountMinor = parseAmountMinor(amount);
    if (!['internal', 'domestic', 'international'].includes(category) || !['EUR', 'CHF'].includes(sourceAccountCurrency) || !['EUR', 'CHF'].includes(currency) || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || !['SHA', 'OUR', 'BEN'].includes(chargeBearer)) {
      return response.status(400).json({ error: 'Transfer quote request is invalid.' });
    }
    if (sourceAccountCurrency !== currency) return response.status(422).json({ error: 'Currency conversion requires an authorized FX quote and is not configured.' });
    const feeMinor = category === 'internal' ? 0 : calculateFeeMinor(amountMinor, Number(process.env.TRANSFER_FEE_BPS ?? 0), Number(process.env.TRANSFER_FIXED_FEE_MINOR ?? 0));
    const totalDebitMinor = amountMinor + feeMinor;
    const maxLimitMinor = Number(process.env.MAX_TRANSFER_LIMIT_MINOR ?? 100_000_000);
    if (!Number.isSafeInteger(totalDebitMinor) || totalDebitMinor > maxLimitMinor) return response.status(422).json({ error: 'Transfer exceeds the configured transaction limit.' });
    const expiresAt = Date.now() + 5 * 60_000;
    const quote = { uid: request.user.uid, category, sourceCurrency: sourceAccountCurrency, currency, amountMinor, feeMinor, totalDebitMinor, chargeBearer, expiresAt };
    return response.json({ quoteToken: signTransferQuote(quote), amount: moneyFromMinor(amountMinor), fee: moneyFromMinor(feeMinor), totalDebit: moneyFromMinor(totalDebitMinor), currency, expiresAt: new Date(expiresAt).toISOString(), rate: null, rateSource: null });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/transfers', authenticate, async (request, response, next) => {
  try {
    const transfers = await Transfer.find({ $or: [{ customerId: request.user.uid }, { recipientCustomerId: request.user.uid }] }).sort({ createdAt: -1 }).lean();
    return response.json(transfers.map(serializeTransfer));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/transfers/:transferId', authenticate, async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.transferId)) return response.status(400).json({ error: 'Transfer identifier is invalid.' });
    const transfer = await Transfer.findOne({
      _id: request.params.transferId,
        $or: [{ customerId: request.user.uid }, { recipientCustomerId: request.user.uid }],
        settlementStatus: { $in: ['pending_authorization', 'pending_review', 'processing', 'accepted', 'reconciliation_required', 'successful', 'settled', 'rejected', 'returned', 'reversed', 'on_hold'] },
    }).lean();
    if (!transfer) return response.status(404).json({ error: 'Transfer was not found.' });
    const events = await TransferEvent.find({ transferId: transfer._id }).sort({ createdAt: 1 }).lean();
    return response.json({ ...serializeTransfer(transfer), events: events.map(({ eventType, fromStatus, toStatus, source, details, createdAt }) => ({ eventType, fromStatus, toStatus, source, details, createdAt })) });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/transfers/:transferId/receipt', authenticate, async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.transferId)) return response.status(400).json({ error: 'Transfer identifier is invalid.' });
    let receipt = await TransferReceipt.findOne({ transferId: request.params.transferId, customerId: request.user.uid }).lean();
    if (!receipt) {
      const transfer = await Transfer.findOne({ _id: request.params.transferId, customerId: request.user.uid, settlementStatus: 'successful' }).select('_id').lean();
      if (transfer) receipt = await ensureTransferReceipt(transfer._id);
    }
    if (!receipt) return response.status(404).json({ error: 'Stored payment receipt was not found.' });
    return response.json(receipt.payload);
  } catch (error) {
    return next(error);
  }
});

app.get('/api/transfers/:transferId/receipt.pdf', authenticate, async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.transferId)) return response.status(400).json({ error: 'Transfer identifier is invalid.' });
    let receipt = await TransferReceipt.findOne({ transferId: request.params.transferId, customerId: request.user.uid }).lean();
    if (!receipt) {
      const transfer = await Transfer.findOne({ _id: request.params.transferId, customerId: request.user.uid, settlementStatus: 'successful' }).select('_id').lean();
      if (transfer) receipt = await ensureTransferReceipt(transfer._id);
    }
    if (!receipt) return response.status(404).json({ error: 'Stored payment receipt was not found.' });
    response.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="veritas-payment-confirmation-${receipt.receiptNumber}.pdf"`,
      'Cache-Control': 'private, no-store',
    });
    return response.send(await generatePaymentReceiptPdf(receipt.payload));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/credits/:creditId/receipt.pdf', authenticate, async (request, response, next) => {
  try {
    if (!mongoose.isValidObjectId(request.params.creditId)) return response.status(400).json({ error: 'Credit identifier is invalid.' });
    const receipt = await TransferReceipt.findOne({ adminCreditId: request.params.creditId, customerId: request.user.uid }).lean();
    if (!receipt) return response.status(404).json({ error: 'Stored account-credit receipt was not found.' });
    response.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="veritas-account-credit-${receipt.receiptNumber}.pdf"`,
      'Cache-Control': 'private, no-store',
    });
    return response.send(await generatePaymentReceiptPdf(receipt.payload));
  } catch (error) {
    return next(error);
  }
});

function requireOperations(request, response) {
  if (!['operations', 'admin'].includes(request.user.role)) {
    response.status(403).json({ error: 'Operations permission is required.' });
    return false;
  }
  return true;
}

function requireAccountCreditPermission(request, response) {
  if (request.user.role !== 'admin' || !Array.isArray(request.user.permissions) || !request.user.permissions.includes('accounts:credit')) {
    response.status(403).json({ error: 'The accounts:credit administrator permission is required.' });
    return false;
  }
  return true;
}

app.get('/api/operations/transfers', authenticate, async (request, response, next) => {
  if (!requireOperations(request, response)) return;
  try {
    const filter = {};
    const { query = '', status = '' } = request.query;
    if (status && ['pending_authorization', 'pending_review', 'processing', 'accepted', 'reconciliation_required', 'successful', 'settled', 'rejected', 'returned', 'reversed', 'on_hold'].includes(status)) filter.settlementStatus = status;
    if (query) {
      const safeQuery = String(query).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const matchingProfiles = await Profile.find({ fullName: { $regex: safeQuery, $options: 'i' } }).select('customerId').limit(100).lean();
      filter.$or = [
        { transactionReference: { $regex: safeQuery, $options: 'i' } },
        { beneficiaryName: { $regex: safeQuery, $options: 'i' } },
        { beneficiaryIban: { $regex: safeQuery, $options: 'i' } },
        { customerId: { $in: matchingProfiles.map((profile) => profile.customerId) } },
      ];
    }
    const transfers = await Transfer.find(filter).sort({ createdAt: -1 }).limit(200).lean();
    return response.json(transfers.map(serializeTransfer));
  } catch (error) {
    return next(error);
  }
});

app.get('/api/operations/transfers/:transferId/events', authenticate, async (request, response, next) => {
  if (!requireOperations(request, response)) return;
  try {
    if (!mongoose.isValidObjectId(request.params.transferId)) return response.status(400).json({ error: 'Transfer identifier is invalid.' });
    const events = await TransferEvent.find({ transferId: request.params.transferId }).sort({ createdAt: 1 }).lean();
    return response.json(events.map(({ eventType, fromStatus, toStatus, actor, source, details, providerEventId, createdAt }) => ({ eventType, fromStatus, toStatus, actor, source, details, providerEventId, createdAt })));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/operations/transfers/:transferId/hold', authenticate, async (request, response, next) => {
  if (!requireOperations(request, response)) return;
  if (!requireFinancialMongo(response)) return;
  try {
    const { hold, reason = '' } = request.body ?? {};
    if (typeof hold !== 'boolean' || typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 300) return response.status(400).json({ error: 'A hold action and audit reason are required.' });
    const session = await mongoose.startSession();
    let updated;
    try {
      await session.withTransaction(async () => {
        const transfer = await Transfer.findById(request.params.transferId).session(session);
        if (!transfer) throw new Error('TRANSFER_NOT_FOUND');
        const priorStatus = transfer.settlementStatus;
        if (hold) {
          if (!['pending_authorization', 'pending_review', 'processing', 'accepted', 'reconciliation_required'].includes(priorStatus)) throw new Error('INVALID_HOLD_TRANSITION');
          transfer.heldFromStatus = priorStatus;
          transfer.settlementStatus = 'on_hold';
        } else {
          if (priorStatus !== 'on_hold' || !transfer.heldFromStatus) throw new Error('INVALID_HOLD_TRANSITION');
          transfer.settlementStatus = transfer.heldFromStatus;
          transfer.heldFromStatus = '';
        }
        await transfer.save({ session });
        await TransferEvent.create([{ transferId: transfer._id, customerId: transfer.customerId, eventType: hold ? 'operations_hold_applied' : 'operations_hold_released', fromStatus: priorStatus, toStatus: transfer.settlementStatus, actor: request.user.uid, source: 'operations', details: { reason: reason.trim() } }], { session });
        updated = transfer;
      });
    } finally {
      await session.endSession();
    }
    return response.json(serializeTransfer(updated));
  } catch (error) {
    if (error?.message === 'TRANSFER_NOT_FOUND') return response.status(404).json({ error: 'Transfer was not found.' });
    if (error?.message === 'INVALID_HOLD_TRANSITION') return response.status(409).json({ error: 'Transfer cannot be held or released from its current status.' });
    return next(error);
  }
});

app.get('/api/transactions', authenticate, async (request, response, next) => {
  try {
    const uid = request.user.uid;
    const entries = await LedgerEntry.find({ customerId: uid, status: 'posted' }).sort({ createdAt: -1 }).limit(200).lean();
    const pendingTransfers = await Transfer.find({
      $or: [{ customerId: uid }, { recipientCustomerId: uid }],
      settlementStatus: { $in: ['pending_authorization', 'pending_review', 'processing', 'accepted', 'reconciliation_required', 'rejected', 'on_hold'] },
      _id: { $nin: entries.map((entry) => entry.transferId).filter(Boolean) },
    }).sort({ createdAt: -1 }).limit(200).lean();
    const [referencedTransfers, adminCredits] = await Promise.all([
      Transfer.find({ _id: { $in: entries.map((entry) => entry.transferId).filter(Boolean) } }).lean(),
      AdminCredit.find({ _id: { $in: entries.map((entry) => entry.adminCreditId).filter(Boolean) }, customerId: uid }).lean(),
    ]);
    const transferById = new Map(referencedTransfers.map((transfer) => [transfer._id.toString(), transfer]));
    const creditById = new Map(adminCredits.map((credit) => [credit._id.toString(), credit]));
    const accounts = await Account.find({ _id: { $in: entries.map((entry) => entry.accountId).filter(Boolean) } }).select('_id accountNumber').lean();
    const accountById = new Map(accounts.map((account) => [account._id.toString(), account]));

    const transactions = [
      ...entries.map((entry) => {
        const transfer = entry.transferId ? transferById.get(entry.transferId.toString()) : undefined;
        const credit = entry.adminCreditId ? creditById.get(entry.adminCreditId.toString()) : undefined;
        const isSender = transfer?.customerId === uid;
        return {
          id: entry._id.toString(),
          creditId: credit?._id.toString() ?? '',
          transferId: transfer?._id.toString() ?? '',
          transactionReference: transfer?.transactionReference || credit?.transactionReference || entry.reference,
          date: entry.createdAt,
          title: credit ? 'Administrative account credit' : transfer ? (isSender ? `Transfer to ${transfer.beneficiaryName}` : `Internal transfer from ${transfer.senderName}`) : entry.description,
          beneficiaryName: credit ? 'Veritas Private Bank' : isSender ? transfer?.beneficiaryName ?? '' : transfer?.senderName ?? '',
          beneficiaryIban: transfer?.beneficiaryIban ?? '',
          beneficiaryAccountIdentifierType: transfer?.beneficiaryAccountIdentifierType ?? '',
          beneficiaryAccountIdentifier: transfer?.beneficiaryAccountIdentifier || transfer?.beneficiaryIban || '',
          beneficiaryRoutingIdentifier: transfer?.beneficiaryRoutingIdentifier ?? '',
          beneficiaryBankName: transfer?.beneficiaryBankName ?? '',
          beneficiaryBic: transfer?.beneficiaryBic ?? '',
          beneficiaryCountry: transfer?.beneficiaryCountry ?? '',
          senderAccount: credit
            ? accountById.get(entry.accountId?.toString())?.accountNumber ?? ''
            : isSender ? accountById.get(entry.accountId?.toString())?.accountNumber ?? '' : '',
          category: credit ? 'administrative_credit' : transfer?.category ?? 'account_entry',
          paymentRail: transfer?.paymentRail ?? '',
          reference: credit?.administrativeReference || transfer?.reference || entry.reference,
          amount: moneyFromMinor(transfer && isSender ? transfer.amountMinor : entry.amountMinor),
          fee: transfer ? moneyFromMinor(transfer.feeMinor) : '0.00',
          totalDebit: transfer && isSender ? moneyFromMinor(transfer.totalDebitMinor) : moneyFromMinor(entry.amountMinor),
          currency: entry.accountCurrency,
          direction: entry.entryType,
          status: transfer?.settlementStatus ?? credit?.status ?? 'settled',
          providerStatus: transfer?.providerStatus ?? '',
          settledAt: transfer?.settledAt ?? null,
          description: credit?.reason || transfer?.description || entry.description,
          previousBalance: credit ? moneyFromMinor(credit.previousBalanceMinor) : '',
          newBalance: credit ? moneyFromMinor(credit.newBalanceMinor) : '',
        };
      }),
      ...pendingTransfers.map((transfer) => ({
        id: transfer._id.toString(),
        transactionReference: transfer.transactionReference,
        date: transfer.settledAt || transfer.createdAt,
        title: `${transfer.customerId === uid ? 'Transfer to' : 'Internal transfer from'} ${transfer.beneficiaryName}`,
        beneficiaryName: transfer.beneficiaryName,
        beneficiaryIban: transfer.beneficiaryIban,
        beneficiaryAccountIdentifierType: transfer.beneficiaryAccountIdentifierType,
        beneficiaryAccountIdentifier: transfer.beneficiaryAccountIdentifier || transfer.beneficiaryIban,
        beneficiaryRoutingIdentifier: transfer.beneficiaryRoutingIdentifier,
        beneficiaryBankName: transfer.beneficiaryBankName,
        beneficiaryBic: transfer.beneficiaryBic,
        beneficiaryCountry: transfer.beneficiaryCountry,
        senderAccount: '',
        category: transfer.category,
        paymentRail: transfer.paymentRail,
        reference: transfer.reference,
        amount: moneyFromMinor(transfer.amountMinor),
        fee: moneyFromMinor(transfer.feeMinor),
        totalDebit: moneyFromMinor(transfer.totalDebitMinor),
        currency: transfer.currency,
        direction: transfer.customerId === uid ? 'debit' : 'credit',
        status: transfer.settlementStatus,
        providerStatus: transfer.providerStatus,
        providerReference: transfer.providerReference,
        settledAt: transfer.settledAt,
        description: transfer.description,
      })),
    ].sort((first, second) => new Date(second.date).getTime() - new Date(first.date).getTime());

    return response.json(transactions);
  } catch (error) {
    return next(error);
  }
});

app.post('/api/transfers', authenticate, async (request, response, next) => {
  if (!requireFinancialMongo(response)) return;
  let session;
  try {
    const {
      category = 'domestic', sourceAccountCurrency, currency, amount, reference = '', description = '', purpose = '',
      executionDate, beneficiaryId, beneficiary = {}, destinationAccountId, chargeBearer = 'SHA',
      idempotencyKey = '', authorizationCode, quoteToken,
    } = request.body ?? {};
    if (!['internal', 'domestic', 'international'].includes(category)) {
      return response.status(400).json({ error: 'Select a supported transfer type.' });
    }
    const amountMinor = parseAmountMinor(amount);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 1_000_000_000) {
      return response.status(400).json({ error: 'Transfer amount is invalid.' });
    }
    const transferCurrency = currency;
    const sourceCurrency = sourceAccountCurrency || currency;
    if (!['EUR', 'CHF'].includes(transferCurrency) || !['EUR', 'CHF'].includes(sourceCurrency)) {
      return response.status(400).json({ error: 'Select a valid transfer currency.' });
    }
    if (typeof reference !== 'string' || reference.length > 140 || typeof description !== 'string' || description.length > 280 || typeof purpose !== 'string' || purpose.length > 140) {
      return response.status(400).json({ error: 'Payment description or reference is invalid.' });
    }
    if (!['SHA', 'OUR', 'BEN'].includes(chargeBearer)) return response.status(400).json({ error: 'Select a valid fee arrangement.' });
    const executeOn = executionDate ? new Date(`${executionDate}T00:00:00.000Z`) : new Date();
    if (!Number.isFinite(executeOn.getTime()) || executeOn.toISOString().slice(0, 10) !== executionDate && executionDate) {
      return response.status(400).json({ error: 'Execution date is invalid.' });
    }

    const normalizedIdempotencyKey = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
    if (normalizedIdempotencyKey.length < 8 || normalizedIdempotencyKey.length > 128) {
      return response.status(400).json({ error: 'A valid idempotency key is required.' });
    }
    const requestFingerprint = createHash('sha256').update(JSON.stringify({
      category, sourceCurrency, currency: transferCurrency, amountMinor, reference, description, purpose,
      executionDate: executionDate || '', beneficiaryId: beneficiaryId || '', destinationAccountId: destinationAccountId || '',
      chargeBearer, beneficiaryName: beneficiary.name || beneficiary.recipientName || '',
      beneficiaryIban: beneficiary.iban || '', beneficiaryAccountIdentifierType: beneficiary.accountIdentifierType || '',
      beneficiaryAccountIdentifier: beneficiary.accountIdentifier || '', beneficiaryRoutingIdentifier: beneficiary.routingIdentifier || '',
      beneficiaryBankName: beneficiary.bankName || '', beneficiaryBic: beneficiary.bic || '', beneficiaryCountry: beneficiary.country || '',
    })).digest('hex');
    const existingTransfer = await Transfer.findOne({ customerId: request.user.uid, idempotencyKey: normalizedIdempotencyKey }).lean();
    if (existingTransfer) {
      if (existingTransfer.idempotencyFingerprint && existingTransfer.idempotencyFingerprint !== requestFingerprint) {
        return response.status(409).json({ error: 'This idempotency key was already used with different transfer details.' });
      }
      await ensureTransferReceipt(existingTransfer._id);
      return response.json({ ...serializeTransfer(await Transfer.findById(existingTransfer._id).lean()), duplicate: true });
    }

    const profile = await Profile.findOne({ customerId: request.user.uid }).lean();
    const highValueLimitMinor = Number(process.env.HIGH_VALUE_TRANSFER_LIMIT_MINOR ?? 5_000_000);
    const authAgeSeconds = Math.floor(Date.now() / 1000) - Number(request.user.auth_time ?? 0);
    if (amountMinor >= highValueLimitMinor && authAgeSeconds > 300) {
      return response.status(403).json({ error: 'Sign in again before confirming a transfer at or above the configured high-value threshold.' });
    }

    const transactionReference = `VPB-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    const receiptNumber = `RCP-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    let paymentRail = 'internal_ledger';
    let recipient = {};
    if (category === 'internal') {
      if (!mongoose.isValidObjectId(destinationAccountId)) return response.status(400).json({ error: 'Select a valid Veritas destination account.' });
      const destination = await Account.findOne({ _id: destinationAccountId, status: 'active', internalTransferEnabled: true, accountNumber: { $ne: '' } }).lean();
      if (!destination || destination.currency !== transferCurrency) {
        return response.status(422).json({ error: 'Internal destination account is unavailable or invalid.' });
      }
      const destinationProfile = await Profile.findOne({ customerId: destination.customerId }).lean();
      if (!destinationProfile) return response.status(422).json({ error: 'Internal recipient could not be verified.' });
      recipient = { destination, name: destinationProfile.fullName, accountNumber: destination.accountNumber, accountIdentifierType: 'Veritas account', accountIdentifier: destination.accountNumber, routingIdentifier: '', iban: '', country: 'CH', bankName: 'Veritas Private Bank' };
    } else {
      const savedBeneficiary = typeof beneficiaryId === 'string' && mongoose.isValidObjectId(beneficiaryId)
        ? await Beneficiary.findOne({ _id: beneficiaryId, customerId: request.user.uid }).lean()
        : null;
      if (savedBeneficiary && savedBeneficiary.currency !== transferCurrency) return response.status(422).json({ error: 'Beneficiary currency must match the transfer currency.' });
      const identifierType = String(beneficiary.accountIdentifierType || savedBeneficiary?.accountIdentifierType || 'IBAN');
      const suppliedIdentifier = String(beneficiary.accountIdentifier || beneficiary.iban || savedBeneficiary?.accountIdentifier || savedBeneficiary?.iban || '').trim();
      const suppliedRoutingIdentifier = String(beneficiary.routingIdentifier || savedBeneficiary?.routingIdentifier || '').trim();
      const recipientCountry = String(beneficiary.country || savedBeneficiary?.country || (identifierType === 'IBAN' ? suppliedIdentifier.slice(0, 2) : '')).toUpperCase();
      const recipientName = String(beneficiary.name || beneficiary.recipientName || savedBeneficiary?.name || '').trim();
      if (recipientName.length < 2 || recipientName.length > 120) return response.status(400).json({ error: 'Recipient legal name is required.' });
      if (!validateCountryAccountDetails({ country: recipientCountry, accountIdentifierType: identifierType, accountIdentifier: suppliedIdentifier, routingIdentifier: suppliedRoutingIdentifier })) {
        return response.status(400).json({ error: 'Recipient account or routing details do not match the selected country.' });
      }
      const suppliedIban = identifierType === 'IBAN' ? suppliedIdentifier.replace(/\s/g, '').toUpperCase() : '';
      if (category === 'domestic' && recipientCountry !== 'CH') return response.status(400).json({ error: 'Choose Switzerland for a domestic transfer, or select International transfer for another country.' });
      const recipientBic = String(beneficiary.bic || savedBeneficiary?.bic || '').toUpperCase();
      if (recipientBic && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(recipientBic)) return response.status(400).json({ error: 'Recipient BIC/SWIFT format is invalid.' });
      paymentRail = selectPaymentRail({ currency: transferCurrency, recipientCountry, iban: suppliedIban });
      recipient = {
        beneficiary: savedBeneficiary,
        name: recipientName,
        iban: suppliedIban,
        accountIdentifierType: identifierType,
        accountIdentifier: suppliedIdentifier,
        routingIdentifier: suppliedRoutingIdentifier,
        country: recipientCountry,
        bankName: beneficiary.bankName || savedBeneficiary?.bankName || '',
        bic: recipientBic,
        address: beneficiary.address || savedBeneficiary?.address || '',
        intermediaryBank: beneficiary.intermediaryBank || '',
      };
    }

    const signedQuote = verifyTransferQuote(quoteToken, request.user.uid, { category, sourceCurrency, currency: transferCurrency, amountMinor, chargeBearer });
    if (!signedQuote && category === 'internal') return response.status(409).json({ error: 'Transfer quote is invalid or expired. Review the amount and request a new quote.' });
    const feeMinor = signedQuote?.feeMinor ?? calculateFeeMinor(amountMinor, Number(process.env.TRANSFER_FEE_BPS ?? 0), Number(process.env.TRANSFER_FIXED_FEE_MINOR ?? 0));
    const totalDebitMinor = signedQuote?.totalDebitMinor ?? amountMinor + feeMinor;
    const maxLimitMinor = Number(process.env.MAX_TRANSFER_LIMIT_MINOR ?? 100_000_000);
    if (!Number.isSafeInteger(totalDebitMinor) || totalDebitMinor > maxLimitMinor) return response.status(422).json({ error: 'Transfer exceeds the configured transaction limit.' });

    if (sourceCurrency !== transferCurrency) return response.status(422).json({ error: 'Currency conversion requires an authorized, expiring FX quote and is not configured.' });
    let transfer;
    session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
      const source = await Account.findOne({ customerId: request.user.uid, currency: sourceCurrency, status: 'active' }).session(session);
      if (!source) throw new Error('ACCOUNT_NOT_FOUND');
      const sourceAvailableMinor = Number.isSafeInteger(source.availableMinor) ? source.availableMinor : Math.round(source.availableBalance * 100);
      const sourceLedgerMinor = Number.isSafeInteger(source.ledgerMinor) ? source.ledgerMinor : Math.round(source.ledgerBalance * 100);
      let destinationAccount = null;
      let clearing = null;
      let posting;
      if (category === 'internal') {
        destinationAccount = await Account.findOne({
          _id: recipient.destination._id,
          customerId: recipient.destination.customerId,
          currency: transferCurrency,
          status: 'active',
          internalTransferEnabled: true,
        }).session(session);
        if (!destinationAccount) throw new Error('ACCOUNT_NOT_FOUND');
        posting = postInternalTransfer(
          { _id: source._id, currency: source.currency, ledgerMinor: sourceLedgerMinor, availableMinor: sourceAvailableMinor },
          { _id: destinationAccount._id, currency: destinationAccount.currency, ledgerMinor: destinationAccount.ledgerMinor, availableMinor: destinationAccount.availableMinor },
          amountMinor,
        );
        const sourceUpdate = await Account.updateOne(
          { _id: source._id, customerId: request.user.uid, currency: sourceCurrency, ledgerMinor: sourceLedgerMinor, availableMinor: sourceAvailableMinor },
          { $set: { ledgerMinor: posting.source.ledgerMinor, availableMinor: posting.source.availableMinor, ledgerBalance: posting.source.ledgerMinor / 100, availableBalance: posting.source.availableMinor / 100 } },
          { session },
        );
        const destinationUpdate = await Account.updateOne(
          { _id: destinationAccount._id, customerId: recipient.destination.customerId, currency: transferCurrency, ledgerMinor: destinationAccount.ledgerMinor, availableMinor: destinationAccount.availableMinor },
          { $set: { ledgerMinor: posting.destination.ledgerMinor, availableMinor: posting.destination.availableMinor, ledgerBalance: posting.destination.ledgerMinor / 100, availableBalance: posting.destination.availableMinor / 100 } },
          { session },
        );
        if (sourceUpdate.matchedCount !== 1) throw new Error('INSUFFICIENT_AVAILABLE_BALANCE');
        if (destinationUpdate.matchedCount !== 1) throw new Error('ACCOUNT_BALANCE_CONFLICT');
        destinationAccount.ledgerMinor = posting.destination.ledgerMinor;
        destinationAccount.availableMinor = posting.destination.availableMinor;
        destinationAccount.ledgerBalance = posting.destination.ledgerMinor / 100;
        destinationAccount.availableBalance = posting.destination.availableMinor / 100;
      } else {
        clearing = await ClearingAccount.findOneAndUpdate(
          { currency: sourceCurrency },
          { $setOnInsert: { accountName: `${sourceCurrency} outgoing payments clearing`, balanceMinor: 0 } },
          { upsert: true, new: true, setDefaultsOnInsert: true, session },
        );
        posting = postOutgoingTransfer(
          { _id: source._id, currency: source.currency, ledgerMinor: sourceLedgerMinor, availableMinor: sourceAvailableMinor },
          { _id: clearing._id, currency: clearing.currency, balanceMinor: clearing.balanceMinor },
          totalDebitMinor,
        );
      }
      if (!destinationAccount) {
        const sourceUpdate = await Account.updateOne(
          { _id: source._id, customerId: request.user.uid, currency: sourceCurrency, ledgerMinor: sourceLedgerMinor, availableMinor: sourceAvailableMinor },
          { $set: {
            ledgerMinor: posting.source.ledgerMinor,
            availableMinor: posting.source.availableMinor,
            ledgerBalance: posting.source.ledgerMinor / 100,
            availableBalance: posting.source.availableMinor / 100,
          } },
          { session },
        );
        if (sourceUpdate.matchedCount !== 1) throw new Error('INSUFFICIENT_AVAILABLE_BALANCE');
      }
      source.ledgerMinor = posting.source.ledgerMinor;
      source.availableMinor = posting.source.availableMinor;
      source.ledgerBalance = posting.source.ledgerMinor / 100;
      source.availableBalance = posting.source.availableMinor / 100;
      if (clearing) {
        clearing.balanceMinor = posting.clearingAccount.balanceMinor;
        await clearing.save({ session });
      }

      const created = await Transfer.create([{
          customerId: request.user.uid, senderName: profile?.fullName ?? '', recipientCustomerId: recipient.destination?.customerId ?? '', transactionReference, category, paymentRail,
          sourceAccountCurrency: sourceCurrency, amountMinor, feeMinor, totalDebitMinor,
          senderAccountNumber: source.accountNumber,
          amount: amountMinor / 100, fee: feeMinor / 100, totalDebit: totalDebitMinor / 100,
          currency: transferCurrency, reference, description, purpose,
          beneficiaryId: recipient.beneficiary?._id ?? null,
          beneficiaryName: recipient.name, beneficiaryIban: recipient.iban,
          beneficiaryAccountIdentifierType: recipient.accountIdentifierType,
          beneficiaryAccountIdentifier: recipient.accountIdentifier,
          beneficiaryRoutingIdentifier: recipient.routingIdentifier,
          beneficiaryBankName: recipient.bankName, beneficiaryBic: recipient.bic || '', beneficiaryCountry: recipient.country,
          beneficiaryAddress: recipient.address, intermediaryBank: recipient.intermediaryBank,
          chargeBearer, executionDate: executeOn, settlementStatus: 'successful',
          providerStatus: category === 'internal' ? 'Internal Veritas account transfer posted to both customer ledgers.' : 'Processed internally; credited to Veritas outgoing-payments clearing. External delivery is not confirmed.',
          providerName: 'Veritas local transfer processor', idempotencyKey: normalizedIdempotencyKey, idempotencyFingerprint: requestFingerprint,
          receiptNumber, balanceAfterMinor: null, settledAt: new Date(),
        }], { session });
      transfer = created[0];

      const ledgerEntryDocuments = [{
        customerId: request.user.uid, accountId: source._id, accountCurrency: sourceCurrency, transferId: transfer._id,
        entryType: 'debit', amount: totalDebitMinor / 100, amountMinor: totalDebitMinor,
        balanceAfter: source.ledgerBalance, description: description || `Outgoing transfer to ${recipient.name}`,
        reference: transactionReference, status: 'posted',
      }];
      if (destinationAccount) ledgerEntryDocuments.push({
        customerId: recipient.destination.customerId, accountId: destinationAccount._id, accountCurrency: transferCurrency,
        transferId: transfer._id, entryType: 'credit', amount: amountMinor / 100, amountMinor,
        balanceAfter: destinationAccount.ledgerBalance, description: description || `Internal transfer from ${profile?.fullName ?? 'Veritas customer'}`,
        reference: transactionReference, status: 'posted',
      });
      const ledgerEntries = await LedgerEntry.create(ledgerEntryDocuments, { session, ordered: true });
      let clearingEntry = null;
      if (clearing) {
        [clearingEntry] = await ClearingLedgerEntry.create([{
          clearingAccountId: clearing._id,
          transferId: transfer._id,
          currency: sourceCurrency,
          entryType: 'credit',
          amountMinor: totalDebitMinor,
          balanceAfterMinor: clearing.balanceMinor,
          reference: transactionReference,
          description: 'Outgoing payment payable; external delivery not confirmed',
        }], { session });
      }
      transfer.ledgerEntries = ledgerEntries.map((entry) => entry._id);
      if (clearingEntry) transfer.clearingLedgerEntryId = clearingEntry._id;
      transfer.balanceAfterMinor = source.ledgerMinor;
      await transfer.save({ session });
      await TransferEvent.create([{ transferId: transfer._id, customerId: request.user.uid, eventType: category === 'internal' ? 'internal_ledger_transfer_posted' : 'outgoing_payment_processed', fromStatus: '', toStatus: 'successful', actor: 'Veritas local transfer processor', source: 'system', details: { transactionReference, amountMinor, feeMinor, totalDebitMinor, clearingAccountId: clearing?._id.toString() ?? '', clearingEntryId: clearingEntry?._id.toString() ?? '', receiptNumber } }], { session });
      });
    } finally {
      await session.endSession();
      session = null;
    }

    await ensureTransferReceipt(transfer._id);
    return response.status(201).json(serializeTransfer(await Transfer.findById(transfer._id).lean()));
  } catch (error) {
    if (session) await session.endSession();
    if (error?.code === 11000) {
      const existing = await Transfer.findOne({ customerId: request.user.uid, idempotencyKey: String(request.body?.idempotencyKey ?? '').trim() }).lean();
      if (existing && (!existing.idempotencyFingerprint || existing.idempotencyFingerprint === requestFingerprint)) {
        await ensureTransferReceipt(existing._id);
        return response.json({ ...serializeTransfer(await Transfer.findById(existing._id).lean()), duplicate: true });
      }
      if (existing) return response.status(409).json({ error: 'This idempotency key was already used with different transfer details.' });
      return response.status(409).json({ error: 'This transfer has already been submitted.' });
    }
    if (error?.message === 'INSUFFICIENT_AVAILABLE_BALANCE') {
      return response.status(422).json({ error: `Insufficient ${request.body?.currency ?? 'account'} available balance.` });
    }
    if (error?.message === 'ACCOUNT_NOT_FOUND') return response.status(422).json({ error: 'Source or destination account is unavailable.' });
    if (error?.message === 'CURRENCY_MISMATCH') return response.status(422).json({ error: 'Internal transfers require matching account currencies.' });
    if (error?.message === 'SAME_ACCOUNT') return response.status(422).json({ error: 'Source and destination accounts must differ.' });
    return next(error);
  }
});

app.post('/api/admin/credits', authenticate, async (request, response, next) => {
  if (!requireAccountCreditPermission(request, response) || !requireFinancialMongo(response)) return;
  let session;
  try {
    const { customerUid, currency, amount, reason, administrativeReference, idempotencyKey } = request.body ?? {};
    const amountMinor = parseAmountMinor(amount);
    const cleanReason = typeof reason === 'string' ? reason.trim() : '';
    const cleanReference = typeof administrativeReference === 'string' ? administrativeReference.trim() : '';
    const cleanIdempotencyKey = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : '';
    if (typeof customerUid !== 'string' || customerUid.trim().length < 1 || customerUid.trim().length > 128 || customerUid === request.user.uid) {
      return response.status(400).json({ error: 'A valid customer account owner is required.' });
    }
    if (!['EUR', 'CHF'].includes(currency) || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      return response.status(400).json({ error: 'Credit currency or amount is invalid.' });
    }
    if (cleanReason.length < 5 || cleanReason.length > 280 || cleanReference.length < 3 || cleanReference.length > 140) {
      return response.status(400).json({ error: 'A credit reason and administrative reference are required.' });
    }
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(cleanIdempotencyKey)) {
      return response.status(400).json({ error: 'A valid idempotency key is required.' });
    }
    const requestFingerprint = createHash('sha256').update(JSON.stringify({ customerUid: customerUid.trim(), currency, amountMinor, reason: cleanReason, administrativeReference: cleanReference })).digest('hex');

    const priorCredit = await AdminCredit.findOne({ actorUid: request.user.uid, idempotencyKey: cleanIdempotencyKey }).lean();
    if (priorCredit) {
      if (priorCredit.requestFingerprint !== requestFingerprint) return response.status(409).json({ error: 'This idempotency key was already used with different credit details.' });
      const [account, receipt] = await Promise.all([
        Account.findById(priorCredit.accountId).lean(),
        TransferReceipt.findOne({ adminCreditId: priorCredit._id }).select('receiptNumber').lean(),
      ]);
      return response.json({
        id: priorCredit._id.toString(), transactionReference: priorCredit.transactionReference,
        receiptNumber: receipt?.receiptNumber ?? '', status: priorCredit.status,
        currency: priorCredit.currency, amount: moneyFromMinor(priorCredit.amountMinor),
        previousBalance: moneyFromMinor(priorCredit.previousBalanceMinor), newBalance: moneyFromMinor(priorCredit.newBalanceMinor),
        account: account ? serializeAccount(account) : null, duplicate: true,
      });
    }

    const targetAccount = await Account.findOne({ customerId: customerUid.trim(), currency, status: 'active' }).lean();
    if (!targetAccount) return response.status(404).json({ error: 'The customer does not have an active account in that currency.' });
    if (!Number.isSafeInteger(targetAccount.ledgerMinor) || !Number.isSafeInteger(targetAccount.availableMinor)) {
      return response.status(409).json({ error: 'Customer account minor-unit balances require migration before crediting.' });
    }

    const transactionReference = `VPB-CR-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    session = await mongoose.startSession();
    let committedCreditId;
    await session.withTransaction(async () => {
      const account = await Account.findOne({ _id: targetAccount._id, customerId: customerUid.trim(), currency, status: 'active' }).session(session);
      if (!account) throw new Error('ACCOUNT_NOT_FOUND');
      if (!Number.isSafeInteger(account.ledgerMinor) || !Number.isSafeInteger(account.availableMinor)) throw new Error('ACCOUNT_MINOR_UNITS_REQUIRED');
      const nextLedgerMinor = account.ledgerMinor + amountMinor;
      const nextAvailableMinor = account.availableMinor + amountMinor;
      if (!Number.isSafeInteger(nextLedgerMinor) || !Number.isSafeInteger(nextAvailableMinor)) throw new Error('BALANCE_LIMIT_EXCEEDED');

      const funding = await FundingAdjustmentAccount.findOneAndUpdate(
        { currency },
        { $setOnInsert: { accountName: `${currency} administrative funding adjustments`, balanceMinor: 0 } },
        { upsert: true, new: true, setDefaultsOnInsert: true, session },
      );
      const posting = postAdministrativeCredit(
        { _id: account._id, currency, ledgerMinor: account.ledgerMinor, availableMinor: account.availableMinor },
        { _id: funding._id, currency, balanceMinor: funding.balanceMinor },
        amountMinor,
      );
      const accountUpdate = await Account.updateOne(
        { _id: account._id, customerId: customerUid.trim(), currency, ledgerMinor: account.ledgerMinor, availableMinor: account.availableMinor },
        { $set: {
          ledgerMinor: posting.customer.ledgerMinor,
          availableMinor: posting.customer.availableMinor,
          ledgerBalance: posting.customer.ledgerMinor / 100,
          availableBalance: posting.customer.availableMinor / 100,
        } },
        { session },
      );
      if (accountUpdate.matchedCount !== 1) throw new Error('ACCOUNT_BALANCE_CONFLICT');
      funding.balanceMinor = posting.fundingAccount.balanceMinor;
      await funding.save({ session });

      const [credit] = await AdminCredit.create([{
        customerId: customerUid.trim(), accountId: account._id, actorUid: request.user.uid,
        transactionReference, administrativeReference: cleanReference, idempotencyKey: cleanIdempotencyKey,
        requestFingerprint,
        currency, amountMinor, reason: cleanReason,
        previousBalanceMinor: account.ledgerMinor, newBalanceMinor: posting.customer.ledgerMinor,
      }], { session });
      const [customerEntry] = await LedgerEntry.create([{
        customerId: customerUid.trim(), accountId: account._id, adminCreditId: credit._id,
        accountCurrency: currency, entryType: 'credit', amount: amountMinor / 100, amountMinor,
        balanceAfter: posting.customer.ledgerMinor / 100, description: cleanReason,
        reference: transactionReference, status: 'posted',
      }], { session });
      const [fundingEntry] = await FundingAdjustmentEntry.create([{
        accountId: funding._id, adminCreditId: credit._id, currency, entryType: 'debit', amountMinor,
        balanceAfterMinor: funding.balanceMinor, reference: `FUND-${transactionReference}`,
        description: cleanReason,
      }], { session });

      const receiptNumber = `RCP-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
      const profile = await Profile.findOne({ customerId: customerUid.trim() }).session(session).lean();
      const receiptPayload = {
        receiptNumber, brand: 'VERITAS PRIVATE BANK', documentType: 'ACCOUNT CREDIT CONFIRMATION',
        transactionReference, status: 'SUCCESSFUL - CREDITED BY VERITAS', senderName: 'Veritas Private Bank',
        senderAccount: funding.accountName, recipientName: profile?.fullName ?? 'Private client',
        recipientBankName: 'Veritas Private Bank', recipientCountry: profile?.residencyCountry ?? '',
        recipientAccountIdentifierType: 'Veritas account', recipientAccountIdentifier: account.accountNumber || `${currency} Private Account`,
        recipientRoutingIdentifier: '', currency, amount: moneyFromMinor(amountMinor), fee: '0.00',
        totalDebit: moneyFromMinor(amountMinor), paymentReference: cleanReference, description: cleanReason,
        processedAt: new Date(), previousBalance: moneyFromMinor(account.ledgerMinor),
        newBalance: moneyFromMinor(posting.customer.ledgerMinor),
        disclaimer: 'Confirms an administrator-authorized credit within the Veritas internal ledger. It is not evidence of an external funds transfer.',
      };
      const receiptPdf = await generatePaymentReceiptPdf(receiptPayload);
      const [receipt] = await TransferReceipt.create([{
        adminCreditId: credit._id, customerId: customerUid.trim(), receiptNumber,
        documentType: receiptPayload.documentType, status: receiptPayload.status,
        generatedAt: new Date(), payload: receiptPayload, pdf: receiptPdf,
      }], { session });
      credit.ledgerEntryId = customerEntry._id;
      credit.fundingEntryId = fundingEntry._id;
      credit.receiptId = receipt._id;
      await credit.save({ session });
      await AdministrativeAudit.create([{
        actorUid: request.user.uid, action: 'account_credit_posted', targetUid: customerUid.trim(),
        entityId: credit._id, reference: transactionReference,
        details: { administrativeReference: cleanReference, reason: cleanReason, currency, amountMinor, previousBalanceMinor: account.ledgerMinor, newBalanceMinor: posting.customer.ledgerMinor },
      }], { session });
      committedCreditId = credit._id;
    });
    const credit = await AdminCredit.findById(committedCreditId).lean();
    const [account, receipt] = await Promise.all([
      Account.findById(credit.accountId).lean(),
      TransferReceipt.findOne({ adminCreditId: credit._id }).select('receiptNumber').lean(),
    ]);
    return response.status(201).json({
      id: credit._id.toString(), transactionReference: credit.transactionReference,
      receiptNumber: receipt?.receiptNumber ?? '', status: credit.status, currency: credit.currency,
      amount: moneyFromMinor(credit.amountMinor), previousBalance: moneyFromMinor(credit.previousBalanceMinor),
      newBalance: moneyFromMinor(credit.newBalanceMinor), account: serializeAccount(account),
    });
  } catch (error) {
    if (error?.code === 11000) {
      const key = String(request.body?.idempotencyKey ?? '').trim();
      const existing = await AdminCredit.findOne({ actorUid: request.user.uid, idempotencyKey: key }).lean();
      if (existing && existing.requestFingerprint === requestFingerprint) return response.json({ id: existing._id.toString(), transactionReference: existing.transactionReference, status: existing.status, duplicate: true });
      if (existing) return response.status(409).json({ error: 'This idempotency key was already used with different credit details.' });
    }
    if (error?.message === 'ACCOUNT_NOT_FOUND') return response.status(404).json({ error: 'The customer account is unavailable.' });
    if (error?.message === 'ACCOUNT_MINOR_UNITS_REQUIRED') return response.status(409).json({ error: 'Customer account minor-unit balances require migration before crediting.' });
    if (error?.message === 'BALANCE_LIMIT_EXCEEDED') return response.status(422).json({ error: 'Credit exceeds the supported account balance range.' });
    if (error?.message === 'ACCOUNT_BALANCE_CONFLICT') return response.status(409).json({ error: 'The customer balance changed concurrently. Retry with the same idempotency key.' });
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
});

app.post('/api/provider/webhook', async (request, response, next) => {
  if (!requireFinancialMongo(response)) return;
  let session;
  try {
    const secret = process.env.PAYMENT_PROVIDER_WEBHOOK_SECRET;
    const signature = request.get('x-provider-signature') ?? '';
    const timestamp = request.get('x-provider-timestamp') ?? '';
    if (!secret || !signature || !request.rawBody) {
      return response.status(503).json({ error: 'Provider webhook is not configured.' });
    }

    const timestampSeconds = Number(timestamp);
    if (!Number.isInteger(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
      return response.status(401).json({ error: 'Provider timestamp is invalid or expired.' });
    }
    const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(request.rawBody).digest();
    let supplied;
    try {
      supplied = Buffer.from(signature, 'hex');
    } catch {
      return response.status(401).json({ error: 'Provider signature is invalid.' });
    }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return response.status(401).json({ error: 'Provider signature is invalid.' });
    }

    const { eventId, transferId, status, providerReference = '', responseCode = '', responseMessage = '' } = request.body ?? {};
    if (typeof eventId !== 'string' || !eventId.trim() || typeof transferId !== 'string' || !mongoose.isValidObjectId(transferId) || !['accepted', 'processing', 'settled', 'rejected', 'returned', 'reversed'].includes(status)) {
      return response.status(400).json({ error: 'Provider event is invalid.' });
    }

    if (await TransferEvent.exists({ providerEventId: eventId })) {
      const existing = await Transfer.findById(transferId).lean();
      return response.json({ accepted: true, duplicate: true, transfer: serializeTransfer(existing) });
    }

    session = await mongoose.startSession();
    let outcome;
    await session.withTransaction(async () => {
      const transfer = await Transfer.findById(transferId).session(session);
      if (!transfer || transfer.category === 'internal') throw new Error('TRANSFER_NOT_FOUND');
      if (transfer.providerEventIds.includes(eventId)) {
        outcome = transfer;
        return;
      }

      const priorStatus = transfer.settlementStatus;
      const account = await Account.findOne({ customerId: transfer.customerId, currency: transfer.sourceAccountCurrency }).session(session);
      if (!account) throw new Error('TRANSFER_RESERVATION_MISSING');
      const state = applyProviderStatus(
        { ...transfer.toObject(), totalDebitMinor: transfer.totalDebitMinor, providerEventIds: transfer.providerEventIds },
        { ...account.toObject(), ledgerMinor: account.ledgerMinor, availableMinor: account.availableMinor, pendingMinor: account.pendingMinor },
        { eventId, status, providerReference, message: responseMessage },
      );
      if (state.duplicate) {
        outcome = transfer;
        return;
      }
      account.availableMinor = state.account.availableMinor;
      account.pendingMinor = state.account.pendingMinor;
      account.ledgerMinor = state.account.ledgerMinor;
      transfer.settlementStatus = state.transfer.settlementStatus;
      transfer.providerStatus = typeof responseMessage === 'string' && responseMessage ? responseMessage.slice(0, 120) : `Provider status: ${status}`;
      transfer.providerReference = typeof providerReference === 'string' ? providerReference.slice(0, 120) : '';
      transfer.providerEventIds = state.transfer.providerEventIds;
      transfer.settledAt = state.transfer.settledAt || transfer.settledAt;
      if (state.entries.length) {
        const entries = await LedgerEntry.create(state.entries.map((entry) => ({
          customerId: transfer.customerId,
          accountId: account._id,
          accountCurrency: transfer.sourceAccountCurrency,
          transferId: transfer._id,
          entryType: entry.entryType,
          amount: entry.amountMinor / 100,
          amountMinor: entry.amountMinor,
          balanceAfter: account.ledgerMinor / 100,
          description: entry.description,
          reference: transfer.transactionReference,
          status: 'posted',
        })), { session });
        transfer.ledgerEntries.push(...entries.map((entry) => entry._id));
      }
      account.availableBalance = account.availableMinor / 100;
      account.pendingBalance = account.pendingMinor / 100;
      account.ledgerBalance = account.ledgerMinor / 100;
      await account.save({ session });
      await transfer.save({ session });
      await TransferEvent.create([{
        transferId: transfer._id, customerId: transfer.customerId, eventType: 'provider_status_update',
        fromStatus: priorStatus, toStatus: status, actor: transfer.providerName || 'payment-provider',
        source: 'provider', providerEventId: eventId,
        details: { providerReference: transfer.providerReference, responseCode: String(responseCode).slice(0, 80), responseMessage: String(responseMessage).slice(0, 500) },
      }], { session });
      outcome = transfer;
    });

    return response.json({ accepted: true, transfer: serializeTransfer(outcome) });
  } catch (error) {
    if (error?.message === 'TRANSFER_NOT_FOUND') return response.status(404).json({ error: 'Transfer was not found.' });
    if (error?.message === 'TRANSFER_RESERVATION_MISSING') return response.status(409).json({ error: 'Transfer reservation is inconsistent.' });
    if (error?.message === 'INVALID_TRANSFER_TRANSITION') return response.status(409).json({ error: 'Provider status transition is not permitted.' });
    if (error?.message === 'TRANSFER_ON_HOLD') return response.status(409).json({ error: 'Transfer is on hold and must be released by operations before provider processing can continue.' });
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
});

app.post('/api/sandbox/transfers/:transferId/provider-event', authenticate, async (request, response, next) => {
  if (process.env.PAYMENT_PROVIDER_MODE !== 'sandbox') return response.status(404).json({ error: 'Sandbox controls are disabled.' });
  if (!['operations', 'admin'].includes(request.user.role)) return response.status(403).json({ error: 'Operations permission is required.' });
  if (!requireFinancialMongo(response)) return;

  let session;
  try {
    if (!mongoose.isValidObjectId(request.params.transferId)) return response.status(400).json({ error: 'Transfer identifier is invalid.' });
    const { eventId, status, providerReference = '', responseMessage = '' } = request.body ?? {};
    if (typeof eventId !== 'string' || eventId.trim().length < 6 || !['accepted', 'processing', 'settled', 'rejected', 'returned', 'reversed'].includes(status)) {
      return response.status(400).json({ error: 'Sandbox provider event is invalid.' });
    }

    session = await mongoose.startSession();
    let result;
    await session.withTransaction(async () => {
      const transfer = await Transfer.findById(request.params.transferId).session(session);
      if (!transfer || transfer.category === 'internal') throw new Error('TRANSFER_NOT_FOUND');
      const account = await Account.findOne({ customerId: transfer.customerId, currency: transfer.sourceAccountCurrency }).session(session);
      if (!account) throw new Error('TRANSFER_RESERVATION_MISSING');
      const state = applyProviderStatus(
        { ...transfer.toObject(), providerEventIds: transfer.providerEventIds },
        { ...account.toObject() },
        { eventId, status, providerReference, message: responseMessage || `Sandbox simulation: ${status}; no payment was sent to a bank.` },
      );
      if (state.duplicate) { result = transfer; return; }
      account.availableMinor = state.account.availableMinor;
      account.pendingMinor = state.account.pendingMinor;
      account.ledgerMinor = state.account.ledgerMinor;
      account.availableBalance = account.availableMinor / 100;
      account.pendingBalance = account.pendingMinor / 100;
      account.ledgerBalance = account.ledgerMinor / 100;
      transfer.settlementStatus = state.transfer.settlementStatus;
      transfer.providerStatus = state.transfer.providerStatus;
      transfer.providerReference = state.transfer.providerReference;
      transfer.providerEventIds = state.transfer.providerEventIds;
      transfer.settledAt = state.transfer.settledAt || transfer.settledAt;
      if (state.entries.length) {
        const entries = await LedgerEntry.create(state.entries.map((entry) => ({
          customerId: transfer.customerId, accountId: account._id,
          accountCurrency: transfer.sourceAccountCurrency, transferId: transfer._id,
          entryType: entry.entryType, amount: entry.amountMinor / 100, amountMinor: entry.amountMinor,
          balanceAfter: account.ledgerMinor / 100, description: entry.description,
          reference: transfer.transactionReference, status: 'posted',
        })), { session });
        transfer.ledgerEntries.push(...entries.map((entry) => entry._id));
      }
      await account.save({ session });
      await transfer.save({ session });
      await TransferEvent.create([{
        transferId: transfer._id, customerId: transfer.customerId, eventType: 'sandbox_provider_event',
        fromStatus: state.priorStatus, toStatus: status, actor: request.user.uid, source: 'operations',
        providerEventId: eventId, details: { providerReference, responseMessage: responseMessage || 'Sandbox simulation only; no bank was contacted.' },
      }], { session });
      result = transfer;
    });
    return response.json({ sandbox: true, notice: 'Sandbox event only; no external payment was sent.', transfer: serializeTransfer(result) });
  } catch (error) {
    if (error?.message === 'TRANSFER_NOT_FOUND') return response.status(404).json({ error: 'External transfer was not found.' });
    if (error?.message === 'TRANSFER_RESERVATION_MISSING') return response.status(409).json({ error: 'Transfer reservation is inconsistent.' });
    if (error?.message === 'INVALID_TRANSFER_TRANSITION') return response.status(409).json({ error: 'Sandbox status transition is not permitted.' });
    if (error?.message === 'TRANSFER_ON_HOLD') return response.status(409).json({ error: 'Transfer is on hold and must be released before simulating provider processing.' });
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
});

app.put('/api/profile', authenticate, async (request, response, next) => {
  try {
    const { phone, countryOfResidence, residentialAddress } = request.body ?? {};
    if (typeof phone !== 'string' || phone.trim().length < 5 || phone.length > 40
      || typeof countryOfResidence !== 'string' || !countryOfResidence.trim() || countryOfResidence.length > 80
      || typeof residentialAddress !== 'string' || residentialAddress.trim().length < 8 || residentialAddress.length > 300) {
      return response.status(400).json({ error: 'Profile fields are invalid.' });
    }

    const session = await mongoose.startSession();
    let updatedCustomer;
    try {
      await session.withTransaction(async () => {
        updatedCustomer = await Customer.findOneAndUpdate(
          { _id: request.user.uid, status: 'active' },
          { $set: { phone: phone.trim(), countryOfResidence: countryOfResidence.trim(), residentialAddress: residentialAddress.trim() } },
          { new: true, runValidators: true, session },
        ).lean();
        if (!updatedCustomer) throw new Error('CUSTOMER_NOT_FOUND');
        await Profile.updateOne(
          { customerId: request.user.uid },
          { $set: { phone: updatedCustomer.phone, residencyCountry: updatedCustomer.countryOfResidence } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }
    return response.json({
      customerReference: updatedCustomer.customerReference,
      firstName: updatedCustomer.firstName,
      middleName: updatedCustomer.middleName,
      lastName: updatedCustomer.lastName,
      fullName: [updatedCustomer.firstName, updatedCustomer.middleName, updatedCustomer.lastName].filter(Boolean).join(' '),
      email: updatedCustomer.email,
      phone: updatedCustomer.phone,
      dateOfBirth: updatedCustomer.dateOfBirth,
      countryOfResidence: updatedCustomer.countryOfResidence,
      residentialAddress: updatedCustomer.residentialAddress,
      status: updatedCustomer.status,
      createdAt: updatedCustomer.createdAt,
    });
  } catch (error) {
    if (error?.message === 'CUSTOMER_NOT_FOUND') return response.status(404).json({ error: 'Customer profile was not found.' });
    return next(error);
  }
});

app.get('/api/beneficiaries', authenticate, async (request, response, next) => {
  try {
    const beneficiaries = await Beneficiary.find({ customerId: request.user.uid }).sort({ createdAt: -1 }).lean();
    return response.json(beneficiaries.map(({ _id, name, iban, accountIdentifierType, accountIdentifier, routingIdentifier, currency, status, bankName, bic, country, address }) => ({ id: _id.toString(), name, iban, accountIdentifierType, accountIdentifier: accountIdentifier || iban, routingIdentifier, currency, status, bankName, bic, country, address, initials: name.slice(0, 2).toUpperCase() })));
  } catch (error) {
    return next(error);
  }
});

app.post('/api/beneficiaries', authenticate, async (request, response, next) => {
  try {
    const { name, iban = '', accountIdentifierType = 'IBAN', accountIdentifier = iban, routingIdentifier = '', currency, bankName = '', bic = '', country = '', address = '' } = request.body ?? {};
    const normalizedCountry = String(country || (accountIdentifierType === 'IBAN' ? iban.slice(0, 2) : '')).toUpperCase();
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 120 || !['EUR', 'CHF'].includes(currency)) {
      return response.status(400).json({ error: 'Beneficiary details are invalid.' });
    }
    if (!validateCountryAccountDetails({ country: normalizedCountry, accountIdentifierType, accountIdentifier, routingIdentifier })) return response.status(400).json({ error: 'Beneficiary account identifier does not match the selected country or format.' });
    const normalizedIban = accountIdentifierType === 'IBAN' ? String(accountIdentifier).replace(/\s/g, '').toUpperCase() : '';
    if (bic && (typeof bic !== 'string' || !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/i.test(bic))) return response.status(400).json({ error: 'BIC/SWIFT format is invalid.' });
    if ([bankName, address, routingIdentifier].some((value) => typeof value !== 'string') || bankName.length > 120 || address.length > 300 || routingIdentifier.length > 80) return response.status(400).json({ error: 'Beneficiary bank or address details are invalid.' });

    const beneficiary = await Beneficiary.create({ customerId: request.user.uid, name: name.trim(), iban: normalizedIban, accountIdentifierType, accountIdentifier: String(accountIdentifier).trim(), routingIdentifier: String(routingIdentifier).trim(), currency, bankName: bankName.trim(), bic: bic.toUpperCase(), country: normalizedCountry, address: address.trim() });
    return response.status(201).json({ id: beneficiary._id.toString(), name: beneficiary.name, iban: beneficiary.iban, accountIdentifierType: beneficiary.accountIdentifierType, accountIdentifier: beneficiary.accountIdentifier, routingIdentifier: beneficiary.routingIdentifier, currency: beneficiary.currency, status: beneficiary.status, bankName: beneficiary.bankName, bic: beneficiary.bic, country: beneficiary.country, address: beneficiary.address, initials: beneficiary.name.slice(0, 2).toUpperCase() });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/beneficiaries/:beneficiaryId/verify', authenticate, async (request, response, next) => {
  if (!['operations', 'admin'].includes(request.user.role)) {
    return response.status(403).json({ error: 'Operations permission is required to verify beneficiaries.' });
  }

  try {
    if (!mongoose.isValidObjectId(request.params.beneficiaryId)) {
      return response.status(400).json({ error: 'Beneficiary identifier is invalid.' });
    }
    const beneficiary = await Beneficiary.findOneAndUpdate(
      { _id: request.params.beneficiaryId, status: 'pending_verification' },
      { $set: { status: 'verified' } },
      { new: true, runValidators: true },
    ).lean();
    if (!beneficiary) return response.status(404).json({ error: 'Pending beneficiary was not found.' });
    return response.json({ id: beneficiary._id.toString(), name: beneficiary.name, iban: beneficiary.iban, currency: beneficiary.currency, status: beneficiary.status, initials: beneficiary.name.slice(0, 2).toUpperCase() });
  } catch (error) {
    return next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error('API request failed:', error.message);
  return response.status(500).json({ error: 'The server could not complete this request.' });
});

if (process.env.MONGODB_URI) {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    mongoTransactionTopology = resolveMongoTransactionTopology(hello);
    mongoConnectionStatus = 'connected';
    if (mongoTransactionTopology === 'standalone') {
      console.error('MongoDB is standalone; financial writes are disabled because multi-document transactions are unsupported. Configure a replica set or sharded cluster.');
    }
  } catch (error) {
    mongoConnectionStatus = 'unreachable';
    mongoConnectionError = error.name || 'MongoDBError';
    console.error(`MongoDB connection failed (${mongoConnectionError}); API will start with financial writes disabled.`);
  }
} else {
  mongoConnectionStatus = 'missing_uri';
  console.warn('MongoDB is not configured; financial routes will remain unavailable until MONGODB_URI points to a replica set or sharded cluster.');
}

if (process.env.VERCEL !== '1') {
  app.listen(port, () => console.log(`API listening on port ${port}${previewMode ? ' (preview mode)' : ''}`));
}

export default app;