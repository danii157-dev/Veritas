import 'dotenv/config';
import mongoose from 'mongoose';

const accountSchema = new mongoose.Schema({
  ledgerBalance: Number,
  availableBalance: Number,
  pendingBalance: Number,
  ledgerMinor: Number,
  availableMinor: Number,
  pendingMinor: Number,
}, { strict: false, collection: 'accounts' });

const Account = mongoose.model('TransferAccountMigration', accountSchema);

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI);
  const accounts = await Account.find({ $or: [
    { ledgerMinor: { $exists: false } },
    { availableMinor: { $exists: false } },
    { pendingMinor: { $exists: false } },
  ] }).lean();
  for (const account of accounts) {
    await Account.updateOne({ _id: account._id }, { $set: {
      ledgerMinor: Math.round(Number(account.ledgerBalance || 0) * 100),
      availableMinor: Math.round(Number(account.availableBalance || 0) * 100),
      pendingMinor: Math.round(Number(account.pendingBalance || 0) * 100),
    } });
  }
  await Account.collection.createIndex({ firebaseUid: 1, currency: 1 }, { unique: true, name: 'uniq_customer_currency' });
  await mongoose.connection.collection('transfers').createIndex(
    { firebaseUid: 1, idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string', $gt: '' } }, name: 'uniq_customer_idempotency' },
  );
  await mongoose.connection.collection('transferEvents').createIndex(
    { providerEventId: 1 },
    { unique: true, partialFilterExpression: { providerEventId: { $type: 'string', $gt: '' } }, name: 'uniq_provider_event' },
  );
  console.log(`Migrated ${accounts.length} account balances to integer minor units and ensured transfer indexes.`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await mongoose.disconnect();
});
