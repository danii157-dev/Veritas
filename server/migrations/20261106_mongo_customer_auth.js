import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config({ path: new URL('../.env', import.meta.url) });

const ownedCollections = [
  'profiles', 'accounts', 'beneficiaries', 'ledgerentries', 'transfers', 'transferreceipts',
  'admincredits', 'transferevents',
];

async function run() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  await mongoose.connect(process.env.MONGODB_URI);
  const database = mongoose.connection.db;
  const customers = database.collection('customers');
  const mapping = new Map();
  const legacyRows = new Map();

  for (const collectionName of ownedCollections) {
    const collection = database.collection(collectionName);
    const indexes = await collection.indexes();
    for (const index of indexes) {
      if (Object.hasOwn(index.key ?? {}, 'firebaseUid') || Object.hasOwn(index.key ?? {}, 'recipientFirebaseUid')) {
        await collection.dropIndex(index.name);
      }
    }
  }

  for (const collectionName of ownedCollections) {
    const collection = database.collection(collectionName);
    const rows = await collection.find({ firebaseUid: { $type: 'string' } }).toArray();
    legacyRows.set(collectionName, rows);
    for (const row of rows) {
      if (!mapping.has(row.firebaseUid)) {
        const profile = await database.collection('profiles').findOne({ firebaseUid: row.firebaseUid });
        if (!profile?.email) continue;
        const customer = await customers.findOne({ email: profile.email.toLowerCase() }, { projection: { _id: 1 } });
        if (customer) mapping.set(row.firebaseUid, customer._id.toString());
      }
    }
  }

  const summary = {};
  for (const collectionName of ownedCollections) {
    const collection = database.collection(collectionName);
    const rows = legacyRows.get(collectionName) ?? [];
    let migrated = 0;
    for (const row of rows) {
      const customerId = mapping.get(row.firebaseUid);
      if (!customerId) continue;
      const update = { $set: { customerId }, $unset: { firebaseUid: '' } };
      if (collectionName === 'transfers' && row.recipientFirebaseUid) {
        const recipientId = mapping.get(row.recipientFirebaseUid);
        if (recipientId) update.$set.recipientCustomerId = recipientId;
        update.$unset.recipientFirebaseUid = '';
      }
      await collection.updateOne({ _id: row._id }, update);
      migrated += 1;
    }
    summary[collectionName] = { matched: rows.length, migrated, retainedForReview: rows.length - migrated };
  }

  const transferIndexes = await database.collection('transfers').indexes();
  for (const index of transferIndexes) {
    if (index.name?.includes('firebaseUid_idempotencyKey')) {
      await database.collection('transfers').dropIndex(index.name);
    }
  }
  await database.collection('transfers').createIndex(
    { customerId: 1, idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string', $gt: '' } }, name: 'uniq_customer_idempotency' },
  );
  await database.collection('accounts').createIndex({ customerId: 1, currency: 1 }, { unique: true, name: 'uniq_customer_currency' });
  await database.collection('accounts').createIndex(
    { accountNumber: 1 },
    { unique: true, partialFilterExpression: { accountNumber: { $type: 'string', $gt: '' } }, name: 'uniq_internal_account_number' },
  );
  await database.collection('profiles').createIndex({ customerId: 1 }, { unique: true, name: 'uniq_customer_profile' });
  await database.collection('customersessions').createIndex({ tokenHash: 1 }, { unique: true, name: 'uniq_customer_session_token' });

  console.log(JSON.stringify({ collections: summary }, null, 2));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await mongoose.disconnect();
});
