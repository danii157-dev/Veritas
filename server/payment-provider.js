import { randomUUID } from 'node:crypto';

export function createPaymentProvider({ mode = 'unconfigured', environment = process.env.NODE_ENV } = {}) {
  if (mode === 'sandbox' && environment !== 'production') {
    return {
      name: 'Veritas Sandbox Payment Adapter',
      mode: 'sandbox',
        canSubmit: false,
        testOnly: true,
      async submitPayment(payment) {
        const status = ['accepted', 'processing', 'rejected'].includes(process.env.SANDBOX_PROVIDER_OUTCOME)
          ? process.env.SANDBOX_PROVIDER_OUTCOME
          : 'accepted';
        return {
          provider: 'sandbox',
          providerReference: `SBX-${randomUUID()}`,
          status,
          message: `Sandbox ${status} instruction for ${payment.rail}; no payment was sent to a bank.`,
        };
      },
    };
  }

  return {
    name: 'No live payment provider configured',
    mode: 'unconfigured',
    canSubmit: false,
      testOnly: false,
    async submitPayment() {
      throw new Error('No authorized live payment provider is configured.');
    },
  };
}