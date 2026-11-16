import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config({ path: new URL('../.env', import.meta.url) });

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI);

  const receipts = mongoose.connection.collection('transferreceipts');
  const existingIndexes = await receipts.indexes();
  for (const index of existingIndexes) {
    if (index.unique && index.key?.transferId === 1 && !index.partialFilterExpression) {
      await receipts.dropIndex(index.name);
    }
  }
  await receipts.createIndex(
    { transferId: 1 },
    { unique: true, partialFilterExpression: { transferId: { $type: 'objectId' } }, name: 'uniq_receipt_transfer' },
  );
  await receipts.createIndex(
    { adminCreditId: 1 },
    { unique: true, partialFilterExpression: { adminCreditId: { $type: 'objectId' } }, name: 'uniq_receipt_admin_credit' },
  );

  await mongoose.connection.collection('admincredits').createIndex(
    { actorUid: 1, idempotencyKey: 1 },
    { unique: true },
  );
  await mongoose.connection.collection('admincredits').createIndex(
    { customerId: 1, createdAt: -1 },
    {},
  );
  await mongoose.connection.collection('fundingadjustmentaccounts').createIndex(
    { currency: 1 },
    { unique: true, name: 'uniq_funding_adjustment_currency' },
  );
  await mongoose.connection.collection('administrativeaudits').createIndex(
    { entityId: 1, createdAt: -1 },
    { name: 'admin_credit_audit_lookup' },
  );

  console.log('Ensured receipt, administrative credit, funding adjustment, and audit indexes.');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await mongoose.disconnect();
});