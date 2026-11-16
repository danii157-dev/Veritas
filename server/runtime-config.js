export function resolveServerRuntimeConfig(env = process.env) {
  const requiredEnvironment = ['MONGODB_URI', 'SESSION_SECRET'];
  const isConfigured = (value) => typeof value === 'string' && value.trim().length > 0 && !/<[^>]+>|\.\.\.|replace-with|generate-a-random-secret/i.test(value);
  const validMongoUri = isConfigured(env.MONGODB_URI) && /^mongodb(?:\+srv)?:\/\//i.test(env.MONGODB_URI);
  const missingEnvironment = requiredEnvironment.filter((key) => {
    if (key === 'MONGODB_URI') return !validMongoUri;
    if (key === 'SESSION_SECRET') return !isConfigured(env.SESSION_SECRET) || env.SESSION_SECRET.length < 32;
    return !isConfigured(env[key]);
  });
  const hasDatabase = validMongoUri;
  const hasCustomerAuth = isConfigured(env.SESSION_SECRET) && env.SESSION_SECRET.length >= 32;

  return {
    requiredEnvironment,
    missingEnvironment,
    hasDatabase,
    hasCustomerAuth,
    isPreviewMode: !hasDatabase || !hasCustomerAuth,
  };
}

export function resolveMongoTransactionTopology(hello = {}) {
  if (typeof hello.setName === 'string' && hello.setName) return 'replica_set';
  if (hello.msg === 'isdbgrid') return 'sharded';
  return 'standalone';
}

