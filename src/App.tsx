import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Activity, ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Bell,
  Check, ChevronDown, CircleHelp, ClipboardList,
  CreditCard, Download, FileText, Globe2, Landmark, LockKeyhole,
  Menu, MessageSquare, MoreHorizontal, Plus, Search, Send, Settings2,
  ShieldCheck, UserRound, UsersRound, WalletCards, X, LogIn, ArrowRight,
} from 'lucide-react';
import { apiRequest, apiRequestBlob } from '@/lib/api';
import './public.css';

type Section = 'Overview' | 'My Accounts' | 'Transfers' | 'Beneficiaries' | 'Account Funding' | 'Transactions' | 'Statements' | 'Currency Exchange' | 'Notifications' | 'Secure Messages' | 'My Profile' | 'Security Settings' | 'Support';
type IconType = typeof Activity;

type Account = { currency: 'EUR' | 'CHF'; balance: string; available: string; pending: string; number: string };
type Beneficiary = { id: string; name: string; iban: string; accountIdentifierType?: string; accountIdentifier?: string; routingIdentifier?: string; currency: 'EUR' | 'CHF'; status: 'verified' | 'pending_verification'; initials: string; tone?: string; bankName?: string; bic?: string; country?: string; address?: string };
type RecurringTemplate = { id: string; name: string; beneficiaryId: string; beneficiaryName: string; amount: string; currency: 'EUR' | 'CHF'; frequency: 'Monthly' | 'Quarterly' | 'Yearly'; nextExecution: string; reference: string; status: 'active' | 'paused' };
type CustomerProfile = { customerReference: string; firstName: string; middleName: string; lastName: string; fullName: string; email: string; phone: string; dateOfBirth: string; countryOfResidence: string; residentialAddress: string; status: string; createdAt: string };
type Customer = { id: string; customerReference: string; firstName: string; middleName: string; lastName: string; fullName: string; email: string; phone: string; dateOfBirth: string; countryOfResidence: string; residentialAddress: string; status: string; createdAt: string };
type TransferInstruction = {
  id: string; beneficiaryName: string; beneficiaryIban: string; amount: string; currency: 'EUR' | 'CHF'; reference: string; status: string; createdAt: string;
  category?: 'internal' | 'domestic' | 'international'; sourceAccountCurrency?: 'EUR' | 'CHF'; beneficiaryId?: string; destinationAccountId?: string;
  beneficiaryBankName?: string; beneficiaryBic?: string; beneficiaryCountry?: string; beneficiaryAddress?: string; intermediaryBank?: string;
  beneficiaryAccountIdentifierType?: string; beneficiaryAccountIdentifier?: string; beneficiaryRoutingIdentifier?: string;
  purpose?: string; description?: string; executionDate?: string; chargeBearer?: 'SHA' | 'OUR' | 'BEN'; fee?: string; totalDebit?: string; transactionReference?: string;
  authorizationCode?: string; quoteToken?: string;
};
type ServerTransfer = TransferInstruction & { id: string; status: string; transactionReference?: string; receiptId?: string; receiptNumber?: string; senderAccountNumber?: string; balanceAfter?: string; providerStatus?: string; providerReference?: string; providerName?: string; settledAt?: string | null; paymentRail?: string };
type ServerTransaction = { id: string; transferId?: string; creditId?: string; transactionReference?: string; date: string; title: string; reference: string; amount: string; fee?: string; totalDebit?: string; currency: 'EUR' | 'CHF'; direction: 'debit' | 'credit'; status: string; beneficiaryName?: string; beneficiaryIban?: string; beneficiaryAccountIdentifierType?: string; beneficiaryAccountIdentifier?: string; beneficiaryRoutingIdentifier?: string; beneficiaryBankName?: string; beneficiaryBic?: string; beneficiaryCountry?: string; senderAccount?: string; category?: string; paymentRail?: string; providerStatus?: string; settledAt?: string | null; description?: string; previousBalance?: string; newBalance?: string };
type InternalRecipient = { id: string; accountNumber: string; currency: 'EUR' | 'CHF'; recipientName: string };
type TransferQuote = { quoteToken: string; amount: string; fee: string; totalDebit: string; currency: 'EUR' | 'CHF'; expiresAt: string; rate: string | null; rateSource: string | null };
type FundingRequest = { id: string; accountCurrency: 'EUR' | 'CHF'; amount: string; source: string; status: 'Under review'; createdAt: string };
type PreviewTransaction = { date: string; title: string; meta: string; amount: string; type: string; currency: 'EUR' | 'CHF'; transferId?: string; creditId?: string; reference?: string; fee?: string; totalDebit?: string; beneficiaryName?: string; beneficiaryIban?: string; beneficiaryAccountIdentifierType?: string; beneficiaryAccountIdentifier?: string; beneficiaryRoutingIdentifier?: string; beneficiaryBankName?: string; beneficiaryBic?: string; beneficiaryCountry?: string; senderAccount?: string; category?: string; paymentRail?: string; providerStatus?: string; description?: string; previousBalance?: string; newBalance?: string };

function mapServerTransferToInstruction(transfer: ServerTransfer): TransferInstruction {
  return {
    id: transfer.id,
    beneficiaryName: transfer.beneficiaryName,
    beneficiaryIban: transfer.beneficiaryIban,
    amount: transfer.amount,
    currency: transfer.currency,
    reference: transfer.reference,
    status: transfer.status,
    createdAt: transfer.createdAt,
  };
}

function mapServerTransaction(transaction: ServerTransaction): PreviewTransaction {
  const transferKey = transaction.transferId || transaction.transactionReference || transaction.id;
  const outgoingInstructionRecorded = transaction.direction === 'debit' && transaction.category !== 'internal' && transaction.status === 'successful';
  return {
    date: new Date(transaction.date).toLocaleDateString(),
    title: transaction.title,
    transferId: transaction.transferId,
    creditId: transaction.creditId,
    meta: `${transaction.status} · ${transaction.transactionReference || transferKey}`,
    amount: `${transaction.direction === 'debit' ? '-' : '+'}${transaction.currency === 'EUR' ? '€' : 'CHF'} ${transaction.amount}`,
    type: transaction.direction === 'debit' ? 'out' : 'in',
    currency: transaction.currency,
    reference: transaction.reference,
    fee: transaction.fee,
    totalDebit: transaction.totalDebit,
    beneficiaryName: transaction.beneficiaryName,
    beneficiaryIban: transaction.beneficiaryIban,
    beneficiaryAccountIdentifierType: transaction.beneficiaryAccountIdentifierType,
    beneficiaryAccountIdentifier: transaction.beneficiaryAccountIdentifier,
    beneficiaryRoutingIdentifier: transaction.beneficiaryRoutingIdentifier,
    beneficiaryBankName: transaction.beneficiaryBankName,
    beneficiaryBic: transaction.beneficiaryBic,
    beneficiaryCountry: transaction.beneficiaryCountry,
    senderAccount: transaction.senderAccount,
    category: transaction.category,
    paymentRail: transaction.paymentRail,
    providerStatus: outgoingInstructionRecorded ? 'Instruction recorded' : transaction.providerStatus,
    description: transaction.description,
    previousBalance: transaction.previousBalance,
    newBalance: transaction.newBalance,
  };
}

const navigation: { label: Section; icon: IconType; group: string }[] = [
  { label: 'Overview', icon: Activity, group: 'Client portal' },
  { label: 'My Accounts', icon: WalletCards, group: 'Client portal' },
  { label: 'Transfers', icon: ArrowLeftRight, group: 'Payments' },
  { label: 'Beneficiaries', icon: UsersRound, group: 'Payments' },
  { label: 'Account Funding', icon: Landmark, group: 'Payments' },
  { label: 'Transactions', icon: CreditCard, group: 'Records' },
  { label: 'Statements', icon: FileText, group: 'Records' },
  { label: 'Currency Exchange', icon: Globe2, group: 'Records' },
  { label: 'Notifications', icon: Bell, group: 'Communication' },
  { label: 'Secure Messages', icon: MessageSquare, group: 'Communication' },
  { label: 'My Profile', icon: UserRound, group: 'Preferences' },
  { label: 'Security Settings', icon: ShieldCheck, group: 'Preferences' },
  { label: 'Support', icon: CircleHelp, group: 'Preferences' },
];

function accountFor(accounts: Account[], currency: Account['currency']) {
  return accounts.find((account) => account.currency === currency) ?? { currency, balance: '0.00', available: '0.00', pending: '0.00', number: 'Not issued' };
}

function formatAmount(value: string) {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
    : value;
}

function accountDisplayBalance(account: Account) {
  return `${account.currency === 'EUR' ? '€' : 'CHF'} ${formatAmount(account.balance)}`;
}

function profileInitials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase();
}

function downloadFile(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function getTimeGreeting(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function App() {
  const [section, setSection] = useState<Section>('Overview');
  const [user, setUser] = useState<Customer | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const [publicPage, setPublicPage] = useState<'home' | 'login' | 'register' | 'app'>(() => window.location.pathname === '/login' ? 'login' : window.location.pathname === '/register' ? 'register' : window.location.pathname === '/app' ? 'app' : 'home');
  const [financialProcessingAvailable, setFinancialProcessingAvailable] = useState(false);
  const [serverHealth, setServerHealth] = useState<{
    databaseConnected?: boolean;
    databaseStatus?: string;
    databaseError?: string;
    transactionTopology?: string;
    financialProcessingAvailable?: boolean;
    missingServerConfiguration?: string[];
    customerAuthentication?: string;
    customerAuthConfigured?: boolean;
  } | null>(null);
  const [transactionTargetId, setTransactionTargetId] = useState('');
  const [profile, setProfile] = useState<CustomerProfile>({ customerReference: '', firstName: '', middleName: '', lastName: '', fullName: '', email: '', phone: '', dateOfBirth: '', countryOfResidence: '', residentialAddress: '', status: '', createdAt: '' });
  const [greeting, setGreeting] = useState(() => getTimeGreeting());
  const [isOperations, setIsOperations] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showFunding, setShowFunding] = useState(false);
  const [showBeneficiary, setShowBeneficiary] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [transferSeed, setTransferSeed] = useState<RecurringTemplate | null>(null);
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  const [internalRecipients, setInternalRecipients] = useState<InternalRecipient[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transactions, setTransactions] = useState<PreviewTransaction[]>([]);
  const [transferInstructions, setTransferInstructions] = useState<TransferInstruction[]>([]);
  const [fundingRequests, setFundingRequests] = useState<FundingRequest[]>([]);
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [localMessages, setLocalMessages] = useState<{ id: string; text: string; createdAt: string }[]>([]);
  const [supportRequests, setSupportRequests] = useState<{ id: string; topic: string; text: string; createdAt: string }[]>([]);
  const [toast, setToast] = useState('');

  useEffect(() => {
    const handlePopState = () => setPublicPage(window.location.pathname === '/login' ? 'login' : window.location.pathname === '/register' ? 'register' : window.location.pathname === '/app' ? 'app' : 'home');
    window.addEventListener('popstate', handlePopState);
    const apiUrl = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV
      ? `${window.location.protocol}//${window.location.hostname}:4000`
      : '');
    void fetch(`${apiUrl}/api/health`).then((response) => response.ok ? response.json() : null).then((health: {
      databaseConnected?: boolean;
      databaseStatus?: string;
      databaseError?: string;
      transactionTopology?: string;
      financialProcessingAvailable?: boolean;
      missingServerConfiguration?: string[];
      customerAuthentication?: string;
      customerAuthConfigured?: boolean;
    } | null) => {
      setServerHealth(health);
      setFinancialProcessingAvailable(Boolean(health?.financialProcessingAvailable));
    }).catch(() => {
      setServerHealth(null);
      setFinancialProcessingAvailable(false);
    });
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (publicPage === 'login' || publicPage === 'register') window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [publicPage]);

  const loadCustomerData = async (customer: Customer) => {
    setUser(customer);
    setProfile({ customerReference: customer.customerReference, firstName: customer.firstName, middleName: customer.middleName, lastName: customer.lastName, fullName: customer.fullName, email: customer.email, phone: customer.phone, dateOfBirth: customer.dateOfBirth, countryOfResidence: customer.countryOfResidence, residentialAddress: customer.residentialAddress, status: customer.status, createdAt: customer.createdAt });
    const [profileResult, beneficiaryResult, accountResult, transferResult, transactionResult, recipientResult] = await Promise.all([
      apiRequest<CustomerProfile>('/api/profile'),
      apiRequest<Beneficiary[]>('/api/beneficiaries'),
      apiRequest<Account[]>('/api/accounts'),
      apiRequest<ServerTransfer[]>('/api/transfers'),
      apiRequest<ServerTransaction[]>('/api/transactions'),
      apiRequest<InternalRecipient[]>('/api/internal-recipients'),
    ]);
    setProfile(profileResult);
    setBeneficiaries(beneficiaryResult);
    setAccounts(accountResult);
    setTransferInstructions(transferResult.map(mapServerTransferToInstruction));
    setTransactions(transactionResult.map(mapServerTransaction));
    setInternalRecipients(recipientResult);
  };

  useEffect(() => {
    let active = true;
    void apiRequest<{ customer: Customer }>('/api/auth/session').then(async ({ customer }) => {
      if (!active) return;
      await loadCustomerData(customer);
    }).catch(() => {
      if (active) setUser(null);
    }).finally(() => {
      if (active) setAuthLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const updateGreeting = () => setGreeting(getTimeGreeting());
    const intervalId = window.setInterval(updateGreeting, 60_000);
    return () => window.clearInterval(intervalId);
  }, []);


  const title = isOperations ? 'Operations overview' : section;
  const subtitle = isOperations ? 'Operations overview' : section === 'Overview' ? `${greeting}, ${profile.fullName}` : 'Veritas Private Bank';
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2600); };
  const navigatePublic = (page: 'home' | 'login' | 'register' | 'app') => {
    const path = page === 'home' ? '/' : `/${page}`;
    window.history.pushState({}, '', path);
    setPublicPage(page);
  };
  const login = async (email: string, password: string) => {
    setAuthNotice('');
    setAuthError('');
    const result = await apiRequest<{ customer: Customer }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    await loadCustomerData(result.customer);
    navigatePublic('app');
  };
  const logout = async () => {
    try { await apiRequest('/api/auth/logout', { method: 'POST' }); } finally {
      setUser(null); setAccounts([]); setTransactions([]); setBeneficiaries([]); setTransferInstructions([]); setInternalRecipients([]);
      setProfile({ customerReference: '', firstName: '', middleName: '', lastName: '', fullName: '', email: '', phone: '', dateOfBirth: '', countryOfResidence: '', residentialAddress: '', status: '', createdAt: '' });
      navigatePublic('home');
    }
  };
  const saveBeneficiary = async (beneficiary: Beneficiary) => {
    try {
      const saved = await apiRequest<Beneficiary>('/api/beneficiaries', { method: 'POST', body: JSON.stringify(beneficiary) });
      setBeneficiaries((current) => [saved, ...current]);
      setShowBeneficiary(false);
      notify('Beneficiary saved for verification');
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'We could not save this beneficiary.');
    }
  };
  const saveProfile = async (nextProfile: CustomerProfile) => {
    try {
      const saved = await apiRequest<CustomerProfile>('/api/profile', { method: 'PUT', body: JSON.stringify(nextProfile) });
      setProfile(saved);
      notify('Profile details saved');
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'We could not save your profile.');
    }
  };

  if (publicPage === 'home') return <PublicLanding onLogin={() => navigatePublic('login')} onRegister={() => navigatePublic('register')} />;
  if (publicPage === 'login') return <AuthView error={authError} success={authNotice} onLogin={login} onRegister={() => navigatePublic('register')} onHome={() => navigatePublic('home')} />;
  if (publicPage === 'register') return <RegistrationView onLogin={() => navigatePublic('login')} onHome={() => navigatePublic('home')} onRegistered={() => { setAuthError(''); setAuthNotice('Account created. Sign in with your new credentials.'); navigatePublic('login'); }} />;
  if (authLoading) return <LoadingScreen />;
  if (!user) return <AuthView error="Your session is not signed in. Log in to open the customer portal." success="" onLogin={login} onRegister={() => navigatePublic('register')} onHome={() => navigatePublic('home')} />;

  return (
    <div className="app-shell">
      {mobileMenu && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMobileMenu(false)} />}
      <aside className={`sidebar ${mobileMenu ? 'sidebar-open' : ''}`}>
        <div className="brand-lockup"><div className="brand-mark"><ShieldCheck size={21} /></div><div><div className="brand-name">VERITAS</div><div className="brand-type">PRIVATE BANK</div></div><button className="mobile-close" aria-label="Close navigation" onClick={() => setMobileMenu(false)}><X size={18} /></button></div>
        <nav className="side-nav">
           {['Client portal', 'Payments', 'Records', 'Communication', 'Preferences'].map((group) => (
          <div key={group} className="nav-group"><div className="nav-label">{group}</div>{navigation.filter((item) => item.group === group).map((item) => <button key={item.label} className={`nav-item ${section === item.label && !isOperations ? 'active' : ''}`} onClick={() => { setSection(item.label); setIsOperations(false); setMobileMenu(false); }}><item.icon size={16} strokeWidth={1.7} /><span>{item.label}</span></button>)}</div>
          ))}
        </nav>
        <div className="sidebar-bottom"><button className={`ops-switch ${isOperations ? 'selected' : ''}`} onClick={() => { setIsOperations(!isOperations); setMobileMenu(false); }}><Settings2 size={16} /><span>Operations portal</span><ChevronDown size={14} /></button><div className="secure-note"><LockKeyhole size={14} /><span>Secure session<br /><b>Customer account</b></span></div><button className="sidebar-signout" onClick={() => void logout()}>Sign out</button></div>
      </aside>

      <main className="main-area">
        <header className="topbar"><button className="mobile-menu" aria-label="Open navigation" aria-expanded={mobileMenu} onClick={() => setMobileMenu(true)}><Menu size={21} /></button><div className="topbar-brand"><span className="brand-mark"><ShieldCheck size={18} /></span><span><b>VERITAS</b><small>PRIVATE BANK</small></span></div><div className="breadcrumb">VERITAS / <span className={isOperations ? 'eyebrow' : ''}>{isOperations ? 'OPERATIONS' : section.toUpperCase()}</span></div><div className="top-actions"><button className="icon-button notification-button" aria-label={`Notifications${transactions.length ? ', new updates available' : ''}`} onClick={() => { setSection('Notifications'); setIsOperations(false); }}><Bell size={18} />{transactions.length > 0 && <span className="notification-dot" aria-hidden="true" />}</button><button className="profile-chip profile-chip-button" aria-label="Open my profile" onClick={() => { setSection('My Profile'); setIsOperations(false); setMobileMenu(false); }}><span className="avatar">{profileInitials(profile.fullName)}</span><span className="profile-copy"><b>{profile.fullName}</b><span>Private client</span></span><ChevronDown size={15} /></button><button className="signout-button" onClick={() => void logout()}>Sign out</button></div></header>
        <div className="page-wrap"><div className="page-heading"><div><div className="eyebrow">{isOperations ? 'OPERATIONS' : 'PRIVATE CLIENT DESK'}</div><h1>{title}</h1><p>{subtitle}</p></div><div className="heading-actions">{!isOperations && <button className="outline-button" onClick={() => setSection('Secure Messages')}><MessageSquare size={16} /> Messages</button>}</div></div>
          {authError && <div className="cloud-error"><ShieldCheck size={15} /> {authError}<button onClick={() => setAuthError('')}><X size={14} /></button></div>}
          {isOperations ? <OperationsView notify={notify} /> : <ClientView section={section} profile={profile} accounts={accounts} transactions={transactions} transactionTargetId={transactionTargetId} onTransactionTargetOpened={() => setTransactionTargetId('')} onOpenTransaction={(transaction) => { setTransactionTargetId(transaction.transferId || transaction.creditId || ''); setSection('Transactions'); }} beneficiaries={beneficiaries} templates={templates} transferInstructions={transferInstructions} fundingRequests={fundingRequests} localMessages={localMessages} supportRequests={supportRequests} onSaveMessage={(text) => setLocalMessages((current) => [{ id: `message-${Date.now()}`, text, createdAt: new Date().toISOString() }, ...current])} onSaveSupport={(topic, text) => setSupportRequests((current) => [{ id: `support-${Date.now()}`, topic, text, createdAt: new Date().toISOString() }, ...current])} onProfileSave={saveProfile} onSignOut={() => void logout()} onTransfer={(template) => { setTransferSeed(template ?? null); setShowTransfer(true); }} onFunding={() => setShowFunding(true)} onAddBeneficiary={() => setShowBeneficiary(true)} onAddTemplate={() => setShowTemplate(true)} onToggleTemplate={(id) => setTemplates((current) => current.map((template) => template.id === id ? { ...template, status: template.status === 'active' ? 'paused' : 'active' } : template))} onDeleteTemplate={(id) => setTemplates((current) => current.filter((template) => template.id !== id))} notify={notify} />}
        </div>
      </main>
      {showTransfer && <TransferModal seed={transferSeed} beneficiaries={beneficiaries} accounts={accounts} internalRecipients={internalRecipients} profile={profile} previewMode={false} financialProcessingAvailable={financialProcessingAvailable} serverHealth={serverHealth} onClose={() => { setShowTransfer(false); setTransferSeed(null); }} onDashboard={() => { setShowTransfer(false); setTransferSeed(null); setSection('Overview'); }} onAnotherTransfer={() => { setShowTransfer(false); setTransferSeed(null); window.setTimeout(() => setShowTransfer(true), 0); }} onViewTransactions={(transferId) => { setShowTransfer(false); setTransferSeed(null); setTransactionTargetId(transferId); setSection('Transactions'); }} onSave={async (instruction) => {
        try {
          const selected = instruction.category === 'internal' ? undefined : beneficiaries.find((beneficiary) => beneficiary.id === instruction.beneficiaryId);

          const result = await apiRequest<ServerTransfer>('/api/transfers', {
            method: 'POST',
            body: JSON.stringify({
              beneficiaryId: selected?.id,
              category: instruction.category,
              sourceAccountCurrency: instruction.sourceAccountCurrency,
              amount: instruction.amount,
              currency: instruction.currency,
              reference: instruction.reference,
              description: instruction.description,
              purpose: instruction.purpose,
              executionDate: instruction.executionDate,
              beneficiary: {
                name: instruction.beneficiaryName,
                iban: instruction.beneficiaryIban,
                accountIdentifierType: instruction.beneficiaryAccountIdentifierType,
                accountIdentifier: instruction.beneficiaryAccountIdentifier,
                routingIdentifier: instruction.beneficiaryRoutingIdentifier,
                bankName: instruction.beneficiaryBankName,
                bic: instruction.beneficiaryBic,
                country: instruction.beneficiaryCountry,
                address: instruction.beneficiaryAddress,
                intermediaryBank: instruction.intermediaryBank,
              },
              destinationAccountId: instruction.destinationAccountId,
              chargeBearer: instruction.chargeBearer,
              authorizationCode: instruction.authorizationCode,
              quoteToken: instruction.quoteToken,
              idempotencyKey: `transfer-${instruction.id}`,
            }),
          });

          const [nextAccounts, nextTransactions] = await Promise.all([
            apiRequest<Account[]>('/api/accounts'),
            apiRequest<ServerTransaction[]>('/api/transactions'),
          ]);
          setAccounts(nextAccounts);
          setTransactions(nextTransactions.map(mapServerTransaction));
          setTransferInstructions((current) => [mapServerTransferToInstruction(result), ...current.filter((item) => item.id !== result.id)]);
          setAuthError('');
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'We could not process this transfer.';
          setAuthError(message);
          throw error;
        }
      }} />}
      {showFunding && <FundingModal accounts={accounts} onClose={() => setShowFunding(false)} onSave={(request) => { setFundingRequests((current) => [request, ...current]); setShowFunding(false); notify('Funding notice saved'); }} />}
      {showBeneficiary && <BeneficiaryModal onClose={() => setShowBeneficiary(false)} onSave={saveBeneficiary} />}
      {showTemplate && <TemplateModal beneficiaries={beneficiaries} onClose={() => setShowTemplate(false)} onSave={(template) => { setTemplates((current) => [template, ...current]); setShowTemplate(false); notify('Recurring transfer template saved'); }} />}
      {toast && <div className="toast"><Check size={16} /> {toast}</div>}
    </div>
  );
}

function ClientView({ section, profile, accounts, transactions, transactionTargetId, onTransactionTargetOpened, onOpenTransaction, beneficiaries, templates, transferInstructions, fundingRequests, localMessages, supportRequests, onSaveMessage, onSaveSupport, onProfileSave, onSignOut, onTransfer, onFunding, onAddBeneficiary, onAddTemplate, onToggleTemplate, onDeleteTemplate, notify }: { section: Section; profile: CustomerProfile; accounts: Account[]; transactions: PreviewTransaction[]; transactionTargetId: string; onTransactionTargetOpened: () => void; onOpenTransaction: (transaction: PreviewTransaction) => void; beneficiaries: Beneficiary[]; templates: RecurringTemplate[]; transferInstructions: TransferInstruction[]; fundingRequests: FundingRequest[]; localMessages: { id: string; text: string; createdAt: string }[]; supportRequests: { id: string; topic: string; text: string; createdAt: string }[]; onSaveMessage: (text: string) => void; onSaveSupport: (topic: string, text: string) => void; onProfileSave: (profile: CustomerProfile) => void; onSignOut: () => void; onTransfer: (template?: RecurringTemplate) => void; onFunding: () => void; onAddBeneficiary: () => void; onAddTemplate: () => void; onToggleTemplate: (id: string) => void; onDeleteTemplate: (id: string) => void; notify: (message: string) => void }) {
  if (section === 'Overview') return <Overview accounts={accounts} transactions={transactions} onTransfer={onTransfer} onFunding={onFunding} notify={notify} />;
  if (section === 'My Accounts') return <AccountsView accounts={accounts} notify={notify} />;
  if (section === 'Transfers') return <TransfersView templates={templates} instructions={transferInstructions} onTransfer={onTransfer} onAddTemplate={onAddTemplate} onToggleTemplate={onToggleTemplate} onDeleteTemplate={onDeleteTemplate} />;
  if (section === 'Beneficiaries' ) return <BeneficiariesView beneficiaries={beneficiaries} onAdd={onAddBeneficiary} notify={notify} />;
  if (section === 'Account Funding') return <FundingView beneficiaries={beneficiaries} requests={fundingRequests} onFunding={onFunding} onAddBeneficiary={onAddBeneficiary} />;
  if (section === 'Transactions') return <TransactionsView transactions={transactions} transactionTargetId={transactionTargetId} onTransactionTargetOpened={onTransactionTargetOpened} />;
  if (section === 'Notifications') return <NotificationsView transactions={transactions} onOpenTransaction={onOpenTransaction} />;
  if (section === 'Statements') return <StatementsView accounts={accounts} notify={notify} />;
  if (section === 'Currency Exchange') return <ExchangeView accounts={accounts} />;
  return <UtilityView section={section} profile={profile} localMessages={localMessages} supportRequests={supportRequests} onSaveMessage={onSaveMessage} onSaveSupport={onSaveSupport} onProfileSave={onProfileSave} onSignOut={onSignOut} notify={notify} />;
}

function Overview({ accounts, transactions, onTransfer, onFunding, notify }: { accounts: Account[]; transactions: PreviewTransaction[]; onTransfer: () => void; onFunding: () => void; notify: (message: string) => void }) {
  const eurAccount = accountFor(accounts, 'EUR');
  const chfAccount = accountFor(accounts, 'CHF');
  const monthTransactions = transactions.filter((transaction) => {
    const date = new Date(transaction.date);
    const now = new Date();
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  });
  return <><div className="notice-banner"><div className="notice-icon"><ShieldCheck size={19} /></div><div><b>Account overview</b><span>EUR and CHF accounts</span></div></div><div className="metric-grid"><Metric label="Total in EUR" value={accountDisplayBalance(eurAccount)} detail={`Available € ${formatAmount(eurAccount.available)}`} tone="navy" /><Metric label="Total in CHF" value={accountDisplayBalance(chfAccount)} detail={`Available CHF ${formatAmount(chfAccount.available)}`} tone="light" /><Metric label="Month activity" value={`${monthTransactions.length} transactions`} detail="From your account history" tone="gold" /></div><div className="content-grid"><section className="panel accounts-panel"><PanelHeader title="Your accounts" action="View all" onClick={() => notify('Account list selected')} />{accounts.length ? accounts.map((account) => <AccountRow key={account.currency} account={account} />) : <EmptyState icon={WalletCards} title="No accounts available" text="Account records will appear here after they are provisioned." />}</section><section className="panel quick-panel"><PanelHeader title="Quick actions" /><div className="quick-actions"><button onClick={onTransfer}><div className="quick-icon"><Send size={17} /></div><span>Transfer</span></button><button onClick={onFunding}><div className="quick-icon"><Plus size={17} /></div><span>Funding notice</span></button><button onClick={() => { window.print(); notify('Statement print view opened'); }}><div className="quick-icon"><Download size={17} /></div><span>Print statement</span></button></div></section></div><section className="panel activity-panel"><PanelHeader title="Recent activity" />{transactions.length ? <ActivityTable items={transactions} /> : <EmptyState icon={Activity} title="No recent transactions" text="Persisted account activity will appear here." />}</section></>;
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) { return <div className={`metric-card ${tone}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small><div className="metric-line" /></div>; }
function PanelHeader({ title, action, onClick }: { title: string; action?: string; onClick?: () => void }) { return <div className="panel-header"><h2>{title}</h2>{action && <button onClick={onClick}>{action} <ArrowUpRight size={14} /></button>}</div>; }
function AccountRow({ account }: { account: Account }) { return <div className="account-row"><div className={`currency-badge ${account.currency.toLowerCase()}`}>{account.currency === 'EUR' ? '€' : '₣'}</div><div className="account-id"><b>{account.currency} Private Account</b><span>{account.number}</span></div><div className="account-balance"><b>{accountDisplayBalance(account)}</b><span>Available {account.currency === 'EUR' ? '€' : 'CHF '}{formatAmount(account.available)}</span></div><MoreHorizontal size={18} className="muted-icon" /></div>; }
function ActivityTable({ items }: { items: PreviewTransaction[] }) { return <div className="activity-table"><div className="table-head"><span>DATE</span><span>DESCRIPTION</span><span>REFERENCE</span><span className="align-right">AMOUNT</span></div>{items.map((item) => <div className="table-row" key={item.meta}><span className="date-cell">{item.date}</span><span className="description-cell"><i className={item.type}><ArrowDownLeft size={14} /></i><b>{item.title}</b></span><span className="reference-cell">{item.meta.split(' · ')[1]}</span><span className={`amount-cell ${item.type}`}>{item.amount}</span></div>)}</div>; }

function AccountsView({ accounts, notify }: { accounts: Account[]; notify: (message: string) => void }) { const eurAccount = accountFor(accounts, 'EUR'); const chfAccount = accountFor(accounts, 'CHF'); const downloadRegister = () => { const rows = ['Currency,Account,Number,Balance,Available,Pending', ...accounts.map((account) => `${account.currency},${account.currency} Private Account,${account.number},${account.balance},${account.available},${account.pending}`)].join('\n'); downloadFile('account-register.csv', rows, 'text/csv'); notify('Account register downloaded'); }; return <><div className="metric-grid two"><Metric label="EUR private account" value={accountDisplayBalance(eurAccount)} detail={`Available € ${formatAmount(eurAccount.available)}`} tone="navy" /><Metric label="CHF private account" value={accountDisplayBalance(chfAccount)} detail={`Available CHF ${formatAmount(chfAccount.available)}`} tone="light" /></div><section className="panel detail-panel"><PanelHeader title="Account register" action="Download register" onClick={downloadRegister} /><div className="account-detail-grid">{accounts.map((account) => <div className="account-detail" key={account.currency}><div className="detail-top"><div className={`currency-badge ${account.currency.toLowerCase()}`}>{account.currency === 'EUR' ? '€' : '₣'}</div><span className="pill active">Account</span></div><h3>{account.currency} Private Account</h3><p>Internal number <b>{account.number}</b></p><div className="detail-values"><div><span>Ledger balance</span><b>{accountDisplayBalance(account)}</b></div><div><span>Available balance</span><b>{accountDisplayBalance({ ...account, balance: account.available })}</b></div><div><span>Pending funds</span><b>{account.currency === 'EUR' ? '€' : 'CHF '}{formatAmount(account.pending)}</b></div></div><button className="text-button" onClick={() => notify(`${account.currency} account · ${accountDisplayBalance(account)}`)}>View account summary <ArrowUpRight size={14} /></button></div>)}</div></section></> }
function TransfersView({ templates, instructions, onTransfer, onAddTemplate, onToggleTemplate, onDeleteTemplate }: { templates: RecurringTemplate[]; instructions: TransferInstruction[]; onTransfer: (template?: RecurringTemplate) => void; onAddTemplate: () => void; onToggleTemplate: (id: string) => void; onDeleteTemplate: (id: string) => void }) {
  const statusLabel: Record<string, string> = {
    pending_authorization: 'Pending authorization',
    pending_review: 'Pending review',
    preview_instruction: 'Preview only · not sent',
    processing: 'Awaiting provider confirmation',
    accepted: 'Accepted by provider, not settled',
    settled: 'Settled by provider',
    rejected: 'Rejected',
    returned: 'Returned',
    reversed: 'Reversed',
    on_hold: 'On hold',
  };
  const statusClass: Record<string, string> = {
    pending_review: 'paused',
    preview_instruction: 'paused',
    processing: 'paused',
    completed: 'active',
    rejected: 'paused',
  };

  return <>
    <div className="action-card"><div className="action-card-icon"><Send size={20} /></div><div><h3>Transfers</h3><p>Create and review transfer instructions.</p></div><button className="primary-button" onClick={() => onTransfer()}>New transfer <Plus size={16} /></button></div>
    <section className="panel template-panel"><PanelHeader title="Recurring templates" action="New template" onClick={onAddTemplate} />{templates.map((template) => <div className="template-row" key={template.id}><div className="template-icon"><ArrowLeftRight size={16} /></div><div className="template-main"><b>{template.name}</b><span>{template.beneficiaryName} · {template.frequency.toLowerCase()} · Next {template.nextExecution}</span></div><div className="template-amount"><b>{template.currency === 'EUR' ? '€' : 'CHF'} {template.amount}</b><span className={`template-status ${template.status}`}>{template.status}</span></div><div className="template-actions"><button onClick={() => onTransfer(template)}>Use</button><button onClick={() => onToggleTemplate(template.id)}>{template.status === 'active' ? 'Pause' : 'Resume'}</button><button className="danger-link" onClick={() => onDeleteTemplate(template.id)}>Remove</button></div></div>)}</section>
    <section className="panel"><PanelHeader title="Transfer instructions" />{instructions.length ? instructions.map((item) => <div className="template-row" key={item.id}><div className="template-icon"><ArrowLeftRight size={16} /></div><div className="template-main"><b>{item.beneficiaryName}</b><span>{item.reference || 'No reference'} · {new Date(item.createdAt).toLocaleString()}</span></div><div className="template-amount"><b>{item.currency === 'EUR' ? '€' : 'CHF'} {item.amount}</b><span className={`template-status ${statusClass[item.status] ?? 'paused'}`} title={item.status}>{statusLabel[item.status] ?? item.status}</span></div></div>) : <EmptyState icon={ArrowLeftRight} title="No transfer instructions" text="Saved instructions appear here." />}</section>
  </>;
}

function BeneficiariesView({ beneficiaries, onAdd, notify }: { beneficiaries: Beneficiary[]; onAdd: () => void; notify: (message: string) => void }) { return <section className="panel"><PanelHeader title="Saved contacts" action="Add contact" onClick={onAdd} /><div className="beneficiary-note"><ShieldCheck size={15} /><span>Saved recipient details are unverified unless explicitly confirmed by an authorized review or provider.</span></div>{beneficiaries.map((beneficiary) => <div className="beneficiary-row" key={beneficiary.id}><div className={`avatar large ${beneficiary.tone ?? ''}`}>{beneficiary.initials}</div><div><b>{beneficiary.name}</b><span>{beneficiary.country || 'Country not supplied'} · {beneficiary.accountIdentifierType || 'IBAN'} {beneficiary.accountIdentifier || beneficiary.iban} · {beneficiary.currency}</span></div><span className={`pill ${beneficiary.status === 'verified' ? 'verified' : 'pending'}`}>{beneficiary.status === 'verified' ? 'Verified' : 'Verification pending'}</span><button className="icon-button row-menu" onClick={() => notify(`${beneficiary.name} · ${beneficiary.currency} contact`)}><MoreHorizontal size={18} /></button></div>)}</section>; }
function FundingView({ beneficiaries, requests, onFunding, onAddBeneficiary }: { beneficiaries: Beneficiary[]; requests: FundingRequest[]; onFunding: () => void; onAddBeneficiary: () => void }) { return <><div className="action-card funding-card"><div className="action-card-icon"><Landmark size={20} /></div><div><h3>Funding</h3><p>Prepare account funding notices.</p></div><button className="primary-button" onClick={onFunding}>New notice <Plus size={16} /></button></div><section className="panel funding-contacts"><PanelHeader title="Saved contacts" action="Add contact" onClick={onAddBeneficiary} />{beneficiaries.filter((beneficiary) => beneficiary.status === 'verified').map((beneficiary) => <div className="funding-contact" key={beneficiary.id}><div className="currency-badge">{beneficiary.currency === 'EUR' ? '€' : '₣'}</div><div><b>{beneficiary.name}</b><span>{beneficiary.iban} · {beneficiary.currency}</span></div><span className="pill verified">Saved contact</span></div>)}</section><section className="panel"><PanelHeader title="Funding notices" />{requests.length ? requests.map((item) => <div className="template-row" key={item.id}><div className="template-icon"><Landmark size={16} /></div><div className="template-main"><b>{item.accountCurrency} account · {item.source}</b><span>{new Date(item.createdAt).toLocaleString()}</span></div><div className="template-amount"><b>{item.accountCurrency === 'EUR' ? '€' : 'CHF'} {item.amount}</b><span className="template-status paused">{item.status}</span></div></div>) : <EmptyState icon={ClipboardList} title="No funding notices" text="Saved notices appear here." />}</section></> }
function TransactionsView({ transactions, transactionTargetId, onTransactionTargetOpened }: { transactions: PreviewTransaction[]; transactionTargetId: string; onTransactionTargetOpened: () => void }) {
  const [query, setQuery] = useState('');
  const [currency, setCurrency] = useState('All');
  const [kind, setKind] = useState('All');
  const [dateRange, setDateRange] = useState('all');
  const [selected, setSelected] = useState<PreviewTransaction | null>(null);
  const [receiptBusy, setReceiptBusy] = useState(false);
  useEffect(() => {
    if (!transactionTargetId) return;
    const target = transactions.find((item) => item.transferId === transactionTargetId || item.creditId === transactionTargetId);
    if (target) {
      setSelected(target);
      onTransactionTargetOpened();
    }
  }, [onTransactionTargetOpened, transactionTargetId, transactions]);
  const filtered = transactions.filter((item) => {
    const matchesQuery = `${item.title} ${item.meta}`.toLowerCase().includes(query.toLowerCase());
    const matchesCurrency = currency === 'All' || item.currency === currency;
    const status = item.meta.toLowerCase();
    const matchesKind = kind === 'All'
      || (kind === 'Transfers' && status.includes('transfer'))
      || (kind === 'Incoming' && item.type === 'in')
      || (kind === 'Outgoing' && item.type === 'out')
      || (kind === 'Pending' && /(pending|processing|accepted|review|sandbox|reconciliation|on_hold)/.test(status))
      || (kind === 'Completed' && /(successful|settled|posted|completed)/.test(status))
      || (kind === 'Failed' && /(rejected|returned|reversed|failed)/.test(status));
    const transactionDate = new Date(item.date);
    const now = new Date();
    const rangeStart = dateRange === '30' ? new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) : dateRange === 'year' ? new Date(now.getFullYear(), 0, 1) : dateRange === '90' ? new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000) : new Date(0);
    const matchesDate = Number.isFinite(transactionDate.getTime()) && transactionDate >= rangeStart;
    return matchesQuery && matchesCurrency && matchesKind && matchesDate;
  });
  const downloadReceipt = async () => {
    const receiptTransferId = selected?.transferId;
    const receiptCreditId = selected?.creditId;
    if (!receiptTransferId && !receiptCreditId) return;
    setReceiptBusy(true);
    try {
      const pdf = await apiRequestBlob(receiptCreditId
        ? `/api/credits/${receiptCreditId}/receipt.pdf`
        : `/api/transfers/${receiptTransferId}/receipt.pdf`);
      const url = URL.createObjectURL(pdf);
      const link = document.createElement('a');
      link.href = url;
      link.download = `veritas-payment-confirmation-${selected?.meta.split(' · ').slice(-1)[0] ?? receiptTransferId ?? receiptCreditId}.pdf`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Receipt is unavailable.');
    } finally {
      setReceiptBusy(false);
    }
  };

  return <section className="panel transactions-panel">
    <div className="transactions-heading"><div><span className="eyebrow">ACCOUNT ACTIVITY</span><h2>Transaction history</h2><p>Review incoming and outgoing account activity.</p></div><span className="transaction-count">{filtered.length} {filtered.length === 1 ? 'transaction' : 'transactions'}</span></div>
    <div className="filter-bar transaction-filters"><div className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or reference" /></div><select className="filter-select" aria-label="Filter by currency" value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="All">All currencies</option><option>EUR</option><option>CHF</option></select><select className="filter-select" aria-label="Filter by transaction type" value={kind} onChange={(event) => setKind(event.target.value)}><option value="All">All activity</option><option>Transfers</option><option>Incoming</option><option>Outgoing</option><option>Pending</option><option>Completed</option><option>Failed</option></select><select className="filter-select" aria-label="Filter by date range" value={dateRange} onChange={(event) => setDateRange(event.target.value)}><option value="all">All history</option><option value="90">Last 90 days</option><option value="30">Last 30 days</option><option value="year">This year</option></select></div>
    {filtered.length ? <div className="transaction-list"><div className="ledger-columns"><span>Activity</span><span>Reference</span><span>Status</span><span>Amount</span></div>{filtered.map((item) => {
      const metaParts = item.meta.split(' · ');
      const metaStatus = metaParts[0] || '';
      const knownPreviewStatuses: Record<string, string> = {
        'preview debit': 'Preview only',
        'draft for review': 'Draft for review',
        'sandbox instruction': 'Sandbox instruction · not sent',
        'qa preview transfer': 'Preview only',
      };
      const statusText = item.providerStatus || knownPreviewStatuses[metaStatus.toLowerCase()] || (/^(pending|processing|accepted|settled|rejected|returned|reversed|on_hold|posted|completed)/i.test(metaStatus) ? metaStatus : 'Recorded');
      const referenceText = item.reference || (metaParts.length > 1 ? metaParts[metaParts.length - 1] : 'No reference');
      const statusClassName = /(pending|processing|accepted|review|sandbox|preview|reconciliation)/i.test(statusText) ? 'pending' : /(rejected|returned|reversed|failed)/i.test(statusText) ? 'failed' : 'completed';
      return <button className="transaction-detail-row ledger-row" key={`${item.date}-${item.meta}-${item.title}`} onClick={() => setSelected(item)}>
        <span className={`transaction-direction ${item.type}`}>{item.type === 'out' ? <ArrowUpRight size={16} /> : <ArrowDownLeft size={16} />}</span>
        <span className="transaction-main"><b>{item.title}</b><small>{item.date}<span className="ledger-reference">{referenceText}</span></small></span>
        <span className={`ledger-status ${statusClassName}`}>{statusText}</span>
        <strong className={`ledger-amount ${item.type}`}>{item.amount}</strong>
      </button>;
    })}</div> : <EmptyState icon={Search} title="No matching transactions" text="No transactions match the current filters." />}
    {selected && <div className="modal-backdrop" onClick={() => setSelected(null)}><section className="modal transaction-detail-modal" role="dialog" aria-modal="true" aria-label="Transaction details" onClick={(event) => event.stopPropagation()}>
      <div className="modal-head"><div><span className="eyebrow">ACCOUNT ACTIVITY</span><h2>Transaction details</h2><p>{selected.date}</p></div><button aria-label="Close transaction details" onClick={() => setSelected(null)}><X size={18} /></button></div>
      <div className="transaction-detail-summary"><div><span>{selected.type === 'out' ? 'Amount debited' : 'Amount credited'}</span><strong>{selected.amount}</strong></div><span className={`ledger-status ${/reject|return|reverse|fail/i.test(selected.providerStatus || selected.meta.split(' · ')[0]) ? 'failed' : /pending|processing|review/i.test(selected.providerStatus || selected.meta.split(' · ')[0]) ? 'pending' : 'completed'}`}>{selected.providerStatus || selected.meta.split(' · ')[0]}</span></div>
      <div className="transaction-detail-section"><h3>Transaction</h3><div className="transaction-detail-fields">
        <div><span>Transaction reference</span><b>{selected.meta.split(' · ').slice(-1)[0]}</b></div>
        <div><span>Payment route</span><b>{selected.category || (selected.type === 'out' ? 'Outgoing transfer' : 'Incoming transfer')} · {selected.paymentRail || 'Account ledger'}</b></div>
        <div><span>Description</span><b>{selected.description || selected.title}</b></div>
        <div><span>Payment reference</span><b>{selected.reference || 'None'}</b></div>
      </div></div>
      <div className="transaction-detail-section"><h3>Accounts and recipient</h3><div className="transaction-detail-fields">
        <div><span>Sender account</span><b>{selected.senderAccount || 'Not recorded'}</b></div>
        <div><span>Recipient / sender</span><b>{selected.beneficiaryName || 'Not applicable'}</b></div>
        <div><span>Recipient bank</span><b>{selected.beneficiaryBankName || 'Not provided'}</b></div>
        <div><span>Recipient country</span><b>{selected.beneficiaryCountry || 'Not provided'}</b></div>
        <div><span>Account identifier</span><b>{selected.beneficiaryAccountIdentifierType || 'Account'} · {selected.beneficiaryAccountIdentifier || selected.beneficiaryIban || 'Not provided'}</b></div>
        <div><span>Routing / BIC</span><b>{selected.beneficiaryRoutingIdentifier || selected.beneficiaryBic || 'Not provided'}</b></div>
      </div></div>
      <div className="transaction-detail-section"><h3>Amount summary</h3><div className="transaction-detail-fields compact">
        <div><span>Amount</span><b>{selected.amount}</b></div>
        <div><span>Fee</span><b>{selected.currency} {selected.fee ?? '0.00'}</b></div>
        <div><span>Total debit</span><b>{selected.currency} {selected.totalDebit ?? selected.amount}</b></div>
        {selected.newBalance && <div><span>Balance after credit</span><b>{selected.currency} {selected.newBalance}</b></div>}
      </div></div>
      <div className="transaction-detail-actions">{(selected.transferId || selected.creditId) && <button className="primary-button" disabled={receiptBusy} onClick={() => void downloadReceipt()}><Download size={15} /> {receiptBusy ? 'Preparing receipt…' : 'Download PDF receipt'}</button>}</div>
    </section></div>}
  </section>;
}
function StatementsView({ accounts, notify }: { accounts: Account[]; notify: (message: string) => void }) { const exportStatement = (currency: Account['currency']) => { const account = accountFor(accounts, currency); const content = ['Currency,Account,Number,Balance,Available,Pending', `${currency},${currency} Private Account,${account.number},${account.balance},${account.available},${account.pending}`].join('\n'); downloadFile(`veritas-${currency.toLowerCase()}-account-summary.csv`, content, 'text/csv'); notify(`${currency} account summary downloaded`); }; return <section className="panel"><PanelHeader title="Account statements" /><p className="section-caption">Statement exports include only current account data. Transaction statements will be available when persisted history is present.</p>{accounts.length ? accounts.map((account) => <div className="statement-row" key={account.currency}><div className="statement-icon"><FileText size={18} /></div><div><b>{account.currency} Private Account</b><span>Current balance: {accountDisplayBalance(account)} · Account identifier: {account.number}</span></div><button className="download-link" onClick={() => exportStatement(account.currency)}><Download size={15} /> CSV</button></div>) : <EmptyState icon={FileText} title="No accounts available" text="Account information will appear after it is provisioned in the customer database." />}</section>; }
function ExchangeView({ accounts }: { accounts: Account[] }) {
  const [amount, setAmount] = useState('100.00');
  const [baseCurrency, setBaseCurrency] = useState<Account['currency']>('EUR');
  const [referenceRate, setReferenceRate] = useState<number | null>(null);
  const [rateDate, setRateDate] = useState('');
  const [rateLoading, setRateLoading] = useState(true);
  const [rateError, setRateError] = useState('');
  const quoteCurrency: Account['currency'] = baseCurrency === 'EUR' ? 'CHF' : 'EUR';

  useEffect(() => {
    const controller = new AbortController();
    void fetch('https://api.frankfurter.dev/v1/latest?base=EUR&symbols=CHF', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Reference rate is temporarily unavailable.');
        return response.json() as Promise<{ date: string; rates: { CHF?: number } }>;
      })
      .then((result) => {
        if (!Number.isFinite(result.rates.CHF) || !result.date) throw new Error('Reference rate is temporarily unavailable.');
        setReferenceRate(result.rates.CHF ?? null);
        setRateDate(result.date);
        setRateError('');
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRateError(error instanceof Error ? error.message : 'Reference rate is temporarily unavailable.');
      })
      .finally(() => setRateLoading(false));
    return () => controller.abort();
  }, []);

  const amountValue = Number(amount);
  const normalizedRate = referenceRate === null ? null : baseCurrency === 'EUR' ? referenceRate : 1 / referenceRate;
  const convertedAmount = normalizedRate !== null && Number.isFinite(amountValue) && amountValue >= 0 ? amountValue * normalizedRate : null;
  const formatCurrencyAmount = (currency: Account['currency'], value: number) => `${currency === 'EUR' ? '€' : 'CHF'} ${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;

  return <section className="exchange-page">
    <div className="exchange-heading"><div><span className="eyebrow">CURRENCY SERVICES</span><h2>EUR / CHF reference calculator</h2><p>Compare an indicative conversion between your currency accounts.</p></div><div className="exchange-pair-mark"><Globe2 size={17} /> EUR <ArrowLeftRight size={14} /> CHF</div></div>
    <div className="exchange-layout">
      <section className="panel exchange-card">
        <div className="exchange-card-title"><div><span className="eyebrow">CONVERSION ESTIMATE</span><h3>Enter an amount</h3></div><span className="exchange-live-dot">Reference rate</span></div>
        <label className="exchange-amount-label">You convert<div className="exchange-input-wrap"><input aria-label="Amount to convert" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /><select aria-label="From currency" value={baseCurrency} onChange={(event) => setBaseCurrency(event.target.value as Account['currency'])}><option value="EUR">EUR</option><option value="CHF">CHF</option></select></div></label>
        <div className="exchange-swap-row"><span><ArrowLeftRight size={15} /> Reference conversion</span><span>{normalizedRate === null ? 'Rate loading' : `1 ${baseCurrency} = ${normalizedRate.toFixed(4)} ${quoteCurrency}`}</span></div>
        <div className="exchange-result"><div><span>Estimated amount</span><strong>{convertedAmount === null ? '—' : formatCurrencyAmount(quoteCurrency, convertedAmount)}</strong></div><span className="exchange-currency-tag">{quoteCurrency}</span></div>
        <div className="exchange-rate-meta">{rateLoading ? 'Loading the latest reference rate…' : rateError || `Reference rate dated ${rateDate} · Source: Frankfurter`}</div>
      </section>
      <aside className="rate-card"><Globe2 size={21} /><span>REFERENCE RATE</span><b>{referenceRate === null ? 'EUR / CHF' : `1 EUR = ${referenceRate.toFixed(4)} CHF`}</b><p>{rateDate ? `Published ${rateDate}` : rateLoading ? 'Retrieving current reference data' : 'Rate data will refresh when available.'}</p></aside>
    </div>
    <div className="exchange-accounts-heading"><div><span className="eyebrow">YOUR ACCOUNTS</span><h3>Currency balances</h3></div></div>
    <div className="exchange-account-grid">{(['EUR', 'CHF'] as const).map((currency) => {
      const account = accountFor(accounts, currency);
      return <article className="exchange-account" key={currency}><div className={`currency-badge ${currency.toLowerCase()}`}>{currency === 'EUR' ? '€' : '₣'}</div><div className="exchange-account-copy"><span>{currency} Private Account</span><strong>{accountDisplayBalance(account)}</strong><small>Available {formatCurrencyAmount(currency, Number(account.available))}</small></div><span className="exchange-account-status">ACTIVE</span></article>;
    })}</div>
  </section>;
}
function UtilityView({ section, profile, localMessages, supportRequests, onSaveMessage, onSaveSupport, onProfileSave, onSignOut, notify }: { section: Section; profile: CustomerProfile; localMessages: { id: string; text: string; createdAt: string }[]; supportRequests: { id: string; topic: string; text: string; createdAt: string }[]; onSaveMessage: (text: string) => void; onSaveSupport: (topic: string, text: string) => void; onProfileSave: (profile: CustomerProfile) => void; onSignOut: () => void; notify: (message: string) => void }) { if (section === 'Secure Messages') return <MessagesView messages={localMessages} onSave={onSaveMessage} />; if (section === 'My Profile') return <ProfileView profile={profile} onSave={onProfileSave} />; if (section === 'Security Settings') return <SecurityView onSignOut={onSignOut} />; return <SupportView requests={supportRequests} onSave={onSaveSupport} />; }
function NotificationsView({ transactions, onOpenTransaction }: { transactions: PreviewTransaction[]; onOpenTransaction: (transaction: PreviewTransaction) => void }) {
  const recent = [...transactions].sort((first, second) => new Date(second.date).getTime() - new Date(first.date).getTime());
  return <section className="panel utility-list notification-feed">
    <div className="panel-header"><div><h2>Notifications</h2><p>Recent account activity and transaction updates</p></div><span className="notification-feed-count">{recent.length} updates</span></div>
    {recent.length ? recent.map((transaction) => <button className="notification-row" key={`${transaction.transferId || transaction.creditId || transaction.meta}-${transaction.date}`} onClick={() => onOpenTransaction(transaction)}>
      <span className={`notification-mark ${transaction.type === 'in' ? 'incoming' : 'outgoing'}`} />
      <span><b>{transaction.title}</b><small>{transaction.providerStatus || transaction.meta.split(' · ')[0]} · {transaction.date}</small><em>{transaction.meta.split(' · ').slice(-1)[0]}</em></span>
      <strong className={`ledger-amount ${transaction.type}`}>{transaction.amount}</strong>
    </button>) : <EmptyState icon={Bell} title="No recent activity" text="Transaction updates will appear here when there is account activity." />}
  </section>;
}
function MessagesView({ messages, onSave }: { messages: { id: string; text: string; createdAt: string }[]; onSave: (text: string) => void }) { const [message, setMessage] = useState(''); return <section className="panel message-view"><div className="utility-icon"><MessageSquare size={22} /></div><h2>Messages</h2><p>Save a message draft in this browser.</p><label>New message<textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Write a message" rows={5} /></label><button className="primary-button" disabled={!message.trim()} onClick={() => { onSave(message.trim()); setMessage(''); }}>Save message <Send size={16} /></button>{messages.map((item) => <div className="audit-item" key={item.id}><MessageSquare size={14} /><div><b>{new Date(item.createdAt).toLocaleString()}</b><span>{item.text}</span></div></div>)}</section>; }
function ProfileView({ profile, onSave }: { profile: CustomerProfile; onSave: (profile: CustomerProfile) => void }) {
  const [phone, setPhone] = useState(profile.phone);
  const [country, setCountry] = useState(profile.countryOfResidence);
  const [address, setAddress] = useState(profile.residentialAddress);

  return <section className="panel profile-view">
    <div className="profile-view-heading">
      <div className="profile-view-identity">
        <div className="avatar large">{profileInitials(profile.fullName)}</div>
        <div><span className="eyebrow">CLIENT PROFILE</span><h2>{profile.fullName}</h2><p>{profile.customerReference}</p></div>
      </div>
      <span className="pill active">{profile.status}</span>
    </div>
    <section className="profile-details-section">
      <div className="profile-section-heading"><h3>Personal details</h3><span>Registered identity</span></div>
      <div className="profile-details-grid">
        <div><span>Legal name</span><b>{profile.fullName}</b></div>
        <div><span>Email address</span><b>{profile.email}</b></div>
        <div><span>Date of birth</span><b>{new Date(profile.dateOfBirth).toLocaleDateString()}</b></div>
        <div><span>Customer reference</span><b>{profile.customerReference}</b></div>
      </div>
    </section>
    <section className="profile-contact-section">
      <div className="profile-section-heading"><h3>Contact details</h3><span>Changes are saved to your profile</span></div>
      <div className="profile-contact-fields">
        <label>Phone number<input autoComplete="tel" value={phone} onChange={(event) => setPhone(event.target.value)} /></label>
        <label>Country of residence<input autoComplete="country-name" value={country} onChange={(event) => setCountry(event.target.value)} /></label>
        <label className="profile-address-field">Residential address<textarea rows={3} autoComplete="street-address" value={address} onChange={(event) => setAddress(event.target.value)} /></label>
      </div>
      <div className="profile-save-row"><button className="primary-button" onClick={() => onSave({ ...profile, phone, countryOfResidence: country, residentialAddress: address })}><Check size={16} /> Save changes</button></div>
    </section>
  </section>;
}
function SecurityView({ onSignOut }: { onSignOut: () => void }) {
  return <section className="security-page">
    <header className="security-page-heading">
      <div><span className="eyebrow">ACCOUNT PREFERENCES</span><h2>Security settings</h2><p>Manage your sign-in session and account access.</p></div>
      <div className="security-status"><span /> Session active</div>
    </header>
    <section className="panel security-session-panel">
      <div className="security-section-heading"><div className="security-icon"><LockKeyhole size={18} /></div><div><h3>Current session</h3><p>This browser is signed in to your client account.</p></div></div>
      <div className="security-facts">
        <div><span>Session protection</span><b>HTTP-only secure cookie</b></div>
        <div><span>Session duration</span><b>Up to 7 days</b></div>
        <div><span>Additional verification</span><b>Required for high-value transfers</b></div>
      </div>
      <div className="security-session-actions"><div><b>Sign out of this device</b><span>End this session and return to the sign-in page.</span></div><button className="outline-button" onClick={onSignOut}>Sign out <ArrowRight size={14} /></button></div>
    </section>
    <section className="security-information"><ShieldCheck size={16} /><p>Your account pages require an authenticated session. Sign out when you have finished using this device.</p></section>
  </section>;
}
function SupportView({ requests, onSave }: { requests: { id: string; topic: string; text: string; createdAt: string }[]; onSave: (topic: string, text: string) => void }) { const [topic, setTopic] = useState('Account administration'); const [question, setQuestion] = useState(''); return <section className="panel form-panel"><div className="utility-icon"><CircleHelp size={22} /></div><h2>Support requests</h2><p>Save a support request draft in this browser.</p><label>Topic<select value={topic} onChange={(event) => setTopic(event.target.value)}><option>Account administration</option><option>Payment support</option><option>Statement request</option><option>Security concern</option></select></label><label>Your request<textarea value={question} onChange={(event) => setQuestion(event.target.value)} rows={5} placeholder="Describe what you need help with" /></label><button className="primary-button" disabled={!question.trim()} onClick={() => { onSave(topic, question.trim()); setQuestion(''); }}>Save support request <Send size={16} /></button>{requests.map((item) => <div className="audit-item" key={item.id}><CircleHelp size={14} /><div><b>{item.topic} · {new Date(item.createdAt).toLocaleString()}</b><span>{item.text}</span></div></div>)}</section>; }
function EmptyState({ icon: Icon, title, text }: { icon: IconType; title: string; text: string }) { return <div className="empty-state"><Icon size={25} /><b>{title}</b><span>{text}</span></div>; }

function OperationsView({ notify }: { notify: (message: string) => void }) {
  return <OperationsTransferConsole notify={notify} />;
}

function OperationsTransferConsole({ notify }: { notify: (message: string) => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [transfers, setTransfers] = useState<ServerTransfer[]>([]);
  const [selected, setSelected] = useState<ServerTransfer | null>(null);
  const [events, setEvents] = useState<{ eventType: string; fromStatus: string; toStatus: string; actor: string; source: string; details: Record<string, unknown>; createdAt: string }[]>([]);
  const [reason, setReason] = useState('');
  const [sandboxBusy, setSandboxBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('query', query.trim());
      if (status) params.set('status', status);
      setTransfers(await apiRequest<ServerTransfer[]>(`/api/operations/transfers?${params.toString()}`));
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Operations transfer search failed');
    }
  }, [notify, query, status]);
  useEffect(() => { void refresh(); }, [refresh]);

  const openTransfer = async (transfer: ServerTransfer) => {
    setSelected(transfer);
    setEvents(await apiRequest(`/api/operations/transfers/${transfer.id}/events`));
  };
  const setHold = async (hold: boolean) => {
    if (!selected || reason.trim().length < 5) return;
    try {
      const updated = await apiRequest<ServerTransfer>(`/api/operations/transfers/${selected.id}/hold`, { method: 'POST', body: JSON.stringify({ hold, reason }) });
      setSelected(updated);
      setReason('');
      await refresh();
      await openTransfer(updated);
      notify(hold ? 'Payment hold applied and audited' : 'Payment hold released and audited');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Payment hold action failed');
    }
  };

  const simulateProviderStatus = async (nextStatus: 'accepted' | 'processing' | 'settled' | 'rejected' | 'returned' | 'reversed') => {
    if (!selected) return;
    setSandboxBusy(true);
    try {
      const result = await apiRequest<{ transfer: ServerTransfer; notice: string }>(`/api/sandbox/transfers/${selected.id}/provider-event`, {
        method: 'POST',
        body: JSON.stringify({ eventId: `sandbox-${crypto.randomUUID()}`, status: nextStatus, responseMessage: `Sandbox simulated ${nextStatus}; no bank was contacted.` }),
      });
      setSelected(result.transfer);
      await refresh();
      await openTransfer(result.transfer);
      notify(result.notice);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Sandbox provider event failed');
    } finally {
      setSandboxBusy(false);
    }
  };

  return <section className="panel operations-transfers">
    <div className="panel-header"><h2>Payment operations</h2><span className="pill active">MongoDB records</span></div>
    <div className="filter-bar"><div className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void refresh()} placeholder="Reference, customer, recipient or IBAN" /></div><select className="filter-select" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option><option value="pending_review">Pending review</option><option value="processing">Processing</option><option value="accepted">Accepted</option><option value="settled">Settled</option><option value="rejected">Rejected</option><option value="returned">Returned</option><option value="reversed">Reversed</option><option value="on_hold">On hold</option></select><button className="outline-button" onClick={() => void refresh()}>Search</button></div>
    {transfers.length ? transfers.map((transfer) => <button className="transaction-detail-row" key={transfer.id} onClick={() => void openTransfer(transfer)}><span className="transaction-direction out"><ArrowLeftRight size={15} /></span><span className="transaction-main"><b>{transfer.transactionReference || transfer.id} · {transfer.beneficiaryName}</b><small>{transfer.category} · {transfer.beneficiaryIban || transfer.beneficiaryBankName} · {transfer.status}</small></span><strong>{transfer.currency} {transfer.amount}</strong></button>) : <EmptyState icon={Search} title="No payment records" text="Search across transfers visible to your operations role." />}
    {selected && <div className="modal-backdrop" onClick={() => setSelected(null)}><section className="modal transaction-detail-modal" role="dialog" aria-modal="true" aria-label="Operations transfer details" onClick={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>{selected.transactionReference || 'Transfer details'}</h2><p>{selected.status} · {selected.providerStatus || 'No provider response'}</p></div><button aria-label="Close details" onClick={() => setSelected(null)}><X size={18} /></button></div><div className="transaction-detail-fields"><div><span>Category and rail</span><b>{selected.category} · {selected.paymentRail}</b></div><div><span>Recipient</span><b>{selected.beneficiaryName} · {selected.beneficiaryIban}</b></div><div><span>Amount / fees / total debit</span><b>{selected.currency} {selected.amount} / {selected.fee ?? '0.00'} / {selected.totalDebit ?? selected.amount}</b></div><div><span>References</span><b>{selected.reference} · {selected.providerReference}</b></div></div><h3>Audit timeline</h3>{events.map((event, index) => <div className="audit-item" key={`${event.eventType}-${index}`}><ShieldCheck size={14} /><div><b>{event.fromStatus} → {event.toStatus} · {event.eventType}</b><span>{event.source} · {new Date(event.createdAt).toLocaleString()} · {event.actor}</span></div></div>)}{selected.providerName?.toLowerCase().includes('sandbox') && <div className="sandbox-controls"><p className="modal-note"><ShieldCheck size={15} /> Sandbox controls only. No external bank was contacted.</p><div className="template-actions">{(['accepted', 'processing', 'settled', 'rejected', 'returned', 'reversed'] as const).map((nextStatus) => <button key={nextStatus} disabled={sandboxBusy} onClick={() => void simulateProviderStatus(nextStatus)}>{nextStatus}</button>)}</div></div>}{['pending_authorization', 'pending_review', 'processing', 'accepted', 'on_hold'].includes(selected.status) && <><label>Reason for hold/release<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Required audit reason" /></label><div className="modal-actions">{selected.status === 'on_hold' ? <button className="primary-button" disabled={reason.trim().length < 5} onClick={() => void setHold(false)}>Release hold</button> : <button className="outline-button" disabled={reason.trim().length < 5} onClick={() => void setHold(true)}>Apply hold</button>}</div></>}</section></div>}
  </section>;
}

function TransferModal({ seed, beneficiaries, accounts, internalRecipients, profile, previewMode, financialProcessingAvailable, serverHealth, onClose, onDashboard, onAnotherTransfer, onViewTransactions, onSave }: { seed: RecurringTemplate | null; beneficiaries: Beneficiary[]; accounts: Account[]; internalRecipients: InternalRecipient[]; profile: CustomerProfile; previewMode: boolean; financialProcessingAvailable: boolean; serverHealth: { databaseConnected?: boolean; databaseStatus?: string; databaseError?: string; transactionTopology?: string; missingServerConfiguration?: string[]; customerAuthConfigured?: boolean } | null; onClose: () => void; onDashboard: () => void; onAnotherTransfer: () => void; onViewTransactions: (transferId: string) => void; onSave: (instruction: TransferInstruction) => Promise<ServerTransfer> }) {
  const transferTitle = seed && typeof seed.name === 'string' && seed.name.trim() && seed.name !== 'undefined'
    ? 'Review template'
    : 'New transfer';
  const [stage, setStage] = useState(0);
  const [category, setCategory] = useState<'internal' | 'domestic' | 'international'>('domestic');
  const [sourceCurrency, setSourceCurrency] = useState<Account['currency']>(() => beneficiaries.find((beneficiary) => beneficiary.id === seed?.beneficiaryId)?.currency ?? beneficiaries.find((beneficiary) => beneficiary.status === 'verified')?.currency ?? 'EUR');
  const [beneficiaryId, setBeneficiaryId] = useState(seed?.beneficiaryId ?? '');
  const selected = beneficiaries.find((beneficiary) => beneficiary.id === beneficiaryId);
  const [destinationAccountId, setDestinationAccountId] = useState('');
  const eligibleInternalRecipients = internalRecipients.filter((recipient) => !/^test\s+user$/i.test(recipient.recipientName.trim()));
  const internalRecipient = eligibleInternalRecipients.find((recipient) => recipient.id === destinationAccountId);
  const [recipientName, setRecipientName] = useState('');
  const [accountIdentifier, setAccountIdentifier] = useState('');
  const [accountIdentifierType, setAccountIdentifierType] = useState('IBAN');
  const [routingIdentifier, setRoutingIdentifier] = useState('');
  const [bankName, setBankName] = useState('');
  const [bic, setBic] = useState('');
  const [country, setCountry] = useState('CH');
  const [customCountry, setCustomCountry] = useState('');
  const [address, setAddress] = useState('');
  const [intermediaryBank, setIntermediaryBank] = useState('');
  const [amount, setAmount] = useState(seed?.amount ?? '');
  const [reference, setReference] = useState(seed?.reference ?? '');
  const [description, setDescription] = useState('');
  const [purpose, setPurpose] = useState('');
  const [executionDate, setExecutionDate] = useState(new Date().toISOString().slice(0, 10));
  const [chargeBearer, setChargeBearer] = useState<'SHA' | 'OUR' | 'BEN'>('SHA');
  const [authorized, setAuthorized] = useState(false);
  const [transferRequestId] = useState(() => `transfer-${crypto.randomUUID()}`);
  const [submittedTransfer, setSubmittedTransfer] = useState<ServerTransfer | null>(null);
  const [processing, setProcessing] = useState(false);
  const [processingError, setProcessingError] = useState('');
  const [quote, setQuote] = useState<TransferQuote | null>(null);
  const [quoteError, setQuoteError] = useState('');
  const [quoteBusy, setQuoteBusy] = useState(false);
  const currency = selected?.currency ?? sourceCurrency;
  const sourceAccount = accountFor(accounts, sourceCurrency);
  const amountValue = Number(amount);
  const validAmount = /^\d{1,10}(\.\d{1,2})?$/.test(amount) && Number.isFinite(amountValue) && amountValue > 0 && amountValue <= Number(sourceAccount.available.replace(/,/g, ''));
  const currentAccountIdentifier = category === 'internal' ? '' : accountIdentifier || selected?.accountIdentifier || selected?.iban || '';
  const recipientCountry = country === 'OTHER' ? customCountry : country;
  const currentIban = accountIdentifierType === 'IBAN' ? currentAccountIdentifier : '';
  const normalizedIdentifier = currentAccountIdentifier.replace(/[\s-]/g, '').toUpperCase();
  const countryIdentifierValid = accountIdentifierType === 'IBAN'
    ? /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(normalizedIdentifier) && normalizedIdentifier.startsWith(recipientCountry)
    : country === 'US' ? /^\d{4,17}$/.test(normalizedIdentifier) && /^\d{9}$/.test(routingIdentifier.replace(/\D/g, ''))
      : country === 'GB' ? /^\d{8}$/.test(normalizedIdentifier) && /^\d{6}$/.test(routingIdentifier.replace(/\D/g, ''))
        : country === 'CA' ? /^\d{5,17}$/.test(normalizedIdentifier) && /^\d{8}$/.test(routingIdentifier.replace(/\D/g, ''))
          : country === 'AU' ? /^\d{5,10}$/.test(normalizedIdentifier) && /^\d{6}$/.test(routingIdentifier.replace(/\D/g, ''))
            : /^[A-Z0-9]{5,34}$/i.test(normalizedIdentifier);
  const recipientDetailsValid = category === 'internal'
    || Boolean(recipientName.trim() && countryIdentifierValid && (category !== 'domestic' || recipientCountry === 'CH'));
  const quoteMatchesCurrentTransfer = Boolean(quote && quote.currency === currency && Number(quote.amount) === Number(amount) && quote.expiresAt && new Date(quote.expiresAt).getTime() > Date.now());
  const fee = quoteMatchesCurrentTransfer ? Number(quote!.fee) : null;
  const totalDebit = quoteMatchesCurrentTransfer ? Number(quote!.totalDebit) : null;
  const affordableTotalDebit = totalDebit !== null && totalDebit <= Number(sourceAccount.available.replace(/,/g, ''));
  const stageNames = ['Type & source', 'Recipient', 'Payment details', 'Review', 'Confirm'];
  const processingEnabled = !previewMode && financialProcessingAvailable;
  const processingBlockers: string[] = [];
  if (previewMode) processingBlockers.push('Preview access cannot submit or save financial transactions. Sign in with a MongoDB customer account.');
  if (!serverHealth) {
    processingBlockers.push('The API health endpoint is unreachable. Start the API and check VITE_API_URL in project/.env.');
  } else {
    if (serverHealth.missingServerConfiguration?.length) {
      processingBlockers.push(`Backend configuration is missing in project/server/.env: ${serverHealth.missingServerConfiguration.join(', ')}.`);
    }
    if (serverHealth.transactionTopology === 'standalone') {
      processingBlockers.push('MongoDB is connected as standalone. Configure MongoDB Atlas or a local replica set; standalone MongoDB cannot run the required atomic transaction.');
    } else if (serverHealth.databaseConnected && !['replica_set', 'sharded'].includes(serverHealth.transactionTopology ?? '')) {
      processingBlockers.push('MongoDB transaction topology is not available. Use a replica set or sharded cluster.');
    } else if (!serverHealth.databaseConnected && !serverHealth.missingServerConfiguration?.includes('MONGODB_URI')) {
      processingBlockers.push(`MongoDB connection status is ${serverHealth.databaseStatus || 'unknown'}${serverHealth.databaseError ? ` (${serverHealth.databaseError})` : ''}. Check URI, network access, and database credentials in project/server/.env.`);
    }
    if (!serverHealth.customerAuthConfigured) {
      processingBlockers.push('MongoDB customer sessions are not configured. Set SESSION_SECRET (32+ random characters) in project/server/.env.');
    }
  }
  const canAdvance = stage === 0
    ? Boolean(sourceCurrency)
    : stage === 1
      ? category === 'internal' ? Boolean(internalRecipient && !/^test\s+user$/i.test(internalRecipient.recipientName.trim()) && internalRecipient.currency === sourceCurrency) : recipientDetailsValid
      : stage === 2
        ? validAmount && Boolean(executionDate)
        : stage === 3 ? validAmount && Boolean(executionDate) : authorized && recipientDetailsValid && validAmount && quoteMatchesCurrentTransfer && affordableTotalDebit;
  useEffect(() => {
    setQuote(null);
    setQuoteError('');
    setAuthorized(false);
  }, [amount, category, chargeBearer, sourceCurrency, beneficiaryId, destinationAccountId, recipientName, accountIdentifier, accountIdentifierType, routingIdentifier, recipientCountry]);
  const buildInstruction = (): TransferInstruction => ({
    id: transferRequestId,
    category,
    sourceAccountCurrency: sourceCurrency,
    beneficiaryId: selected?.id,
    destinationAccountId,
    beneficiaryName: category === 'internal' ? internalRecipient?.recipientName ?? '' : recipientName || selected?.name || '',
    beneficiaryIban: currentIban,
    beneficiaryAccountIdentifierType: accountIdentifierType,
    beneficiaryAccountIdentifier: currentAccountIdentifier,
    beneficiaryRoutingIdentifier: routingIdentifier,
    beneficiaryBankName: bankName || selected?.bankName || '',
    beneficiaryBic: bic || selected?.bic || '',
    beneficiaryCountry: recipientCountry,
    beneficiaryAddress: address,
    intermediaryBank,
    amount: amountValue.toFixed(2),
    currency,
    reference: reference.trim(),
    description: description.trim(),
    purpose: purpose.trim(),
    executionDate,
    chargeBearer,
    fee: fee?.toFixed(2),
    totalDebit: totalDebit?.toFixed(2),
    quoteToken: quote?.quoteToken,
    status: 'pending_authorization',
    createdAt: new Date().toISOString(),
  });

  const refreshTransferQuote = async () => {
    setQuoteBusy(true);
    setQuoteError('');
    try {
      const nextQuote = await apiRequest<TransferQuote>('/api/transfers/quote', {
        method: 'POST',
        body: JSON.stringify({ category, sourceAccountCurrency: sourceCurrency, currency, amount, chargeBearer }),
      });
      setQuote(nextQuote);
      return true;
    } catch (error) {
      setQuoteError(error instanceof Error ? error.message : 'Could not obtain an authoritative fee quote.');
      return false;
    } finally {
      setQuoteBusy(false);
    }
  };

  const downloadProcessedReceipt = async () => {
    if (!submittedTransfer) return;
    setProcessing(true);
    setProcessingError('');
    try {
      const receipt = await apiRequestBlob(`/api/transfers/${submittedTransfer.id}/receipt.pdf`);
      const receiptUrl = URL.createObjectURL(receipt);
      const link = document.createElement('a');
      link.href = receiptUrl;
      link.download = `veritas-payment-confirmation-${submittedTransfer.transactionReference || submittedTransfer.id}.pdf`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(receiptUrl), 1000);
    } catch (error) {
      setProcessingError(error instanceof Error ? error.message : 'The stored receipt could not be downloaded.');
    } finally {
      setProcessing(false);
    }
  };

  if (submittedTransfer) return <Modal title="Transfer confirmation" subtitle="VERITAS PRIVATE BANK · Transaction record" onClose={onClose} className="transfer-modal transfer-result-modal">
    <div className="completion-brand"><div className="completion-mark"><ShieldCheck size={20} /></div><div><b>VERITAS</b><span>PRIVATE BANK</span></div><span className="completion-status"><Check size={14} /> {submittedTransfer.category === 'internal' ? 'Completed' : 'Instruction recorded'}</span></div>
    <div className="completion-amount"><span>{submittedTransfer.category === 'internal' ? 'Transfer amount' : 'Payment instruction amount'}</span><strong>{submittedTransfer.currency} {submittedTransfer.amount}</strong><small>Fee {submittedTransfer.currency} {submittedTransfer.fee ?? '0.00'} · Total debited {submittedTransfer.currency} {submittedTransfer.totalDebit ?? submittedTransfer.amount}</small></div>
    <div className="completion-reference"><span>TRANSACTION REFERENCE</span><b>{submittedTransfer.transactionReference || submittedTransfer.id}</b><small>Receipt {submittedTransfer.receiptNumber || 'Not returned'}</small></div>
    <div className="completion-details">
      <div><span>Sender</span><b>{profile.fullName}</b></div>
      <div><span>Sender account</span><b>{submittedTransfer.sourceAccountCurrency} Private Account · {submittedTransfer.senderAccountNumber || sourceAccount.number}</b></div>
      <div><span>Recipient</span><b>{submittedTransfer.beneficiaryName}</b></div>
      <div><span>Recipient bank</span><b>{submittedTransfer.beneficiaryBankName || (submittedTransfer.category === 'internal' ? 'Veritas Private Bank' : 'Not provided')}</b></div>
      <div><span>Country</span><b>{submittedTransfer.beneficiaryCountry || 'Not provided'}</b></div>
      <div><span>Recipient account</span><b>{submittedTransfer.beneficiaryAccountIdentifier || submittedTransfer.beneficiaryIban || 'Veritas account'}</b></div>
      <div><span>Payment reference</span><b>{submittedTransfer.reference || 'None'}</b></div>
      <div><span>Processed</span><b>{submittedTransfer.createdAt ? new Date(submittedTransfer.createdAt).toLocaleString() : 'Time not returned'}</b></div>
      {submittedTransfer.balanceAfter && <div><span>Updated sender balance</span><b>{submittedTransfer.currency} {submittedTransfer.balanceAfter}</b></div>}
    </div>
    <p className="completion-disclaimer">{submittedTransfer.category === 'internal' ? 'Transfer completed between Veritas accounts.' : 'Outgoing payment instruction recorded. Review its current status in Transactions.'}</p>
    {processingError && <div className="auth-error">{processingError}</div>}
    <div className="completion-actions"><button className="outline-button" onClick={() => onViewTransactions(submittedTransfer.id)}><FileText size={15} /> View transaction details</button><button className="outline-button" disabled={processing} onClick={() => void downloadProcessedReceipt()}><Download size={15} /> {processing ? 'Preparing…' : 'Download receipt'}</button><button className="outline-button" onClick={onDashboard}>Return to dashboard</button><button className="primary-button" onClick={onAnotherTransfer}><Send size={15} /> Make another transfer</button></div>
  </Modal>;

  return <Modal title={transferTitle} subtitle="Enter transfer details and review the summary before confirmation." onClose={onClose} className="transfer-modal">
    <div className="transfer-steps" aria-label="Transfer progress">{stageNames.map((name, index) => <div key={name} className={index === stage ? 'current' : index < stage ? 'complete' : ''}><b>{index + 1}</b><span>{name}</span></div>)}</div>
    {stage === 0 && <>
      <label>Transfer type<select value={category} onChange={(event) => setCategory(event.target.value as typeof category)}><option value="internal">Internal Veritas transfer</option><option value="domestic">Swiss domestic transfer</option><option value="international">International transfer</option></select></label>
      <label>Source account<select value={sourceCurrency} onChange={(event) => setSourceCurrency(event.target.value as Account['currency'])}><option value="EUR">EUR account · {accountDisplayBalance(accountFor(accounts, 'EUR'))} · available {formatAmount(accountFor(accounts, 'EUR').available)}</option><option value="CHF">CHF account · {accountDisplayBalance(accountFor(accounts, 'CHF'))} · available {formatAmount(accountFor(accounts, 'CHF').available)}</option></select></label>
    </>}
    {stage === 1 && (category === 'internal' ? <>
      <label>Veritas destination account<select value={destinationAccountId} onChange={(event) => setDestinationAccountId(event.target.value)}><option value="">Select issued recipient account</option>{eligibleInternalRecipients.filter((recipient) => recipient.currency === sourceCurrency).map((recipient) => <option value={recipient.id} key={recipient.id}>{recipient.recipientName} · {recipient.accountNumber} · {recipient.currency}</option>)}</select></label>
      {!eligibleInternalRecipients.some((recipient) => recipient.currency === sourceCurrency) && <p className="section-caption">No eligible Veritas recipient accounts are available yet. Recipient account details must be issued and enabled before they can receive an internal transfer.</p>}
    </> : <>
      <label>Saved recipient, if available<select value={beneficiaryId} onChange={(event) => { setBeneficiaryId(event.target.value); const beneficiary = beneficiaries.find((item) => item.id === event.target.value); if (beneficiary) setSourceCurrency(beneficiary.currency); setRecipientName(beneficiary?.name ?? ''); setAccountIdentifier(beneficiary?.accountIdentifier ?? beneficiary?.iban ?? ''); setAccountIdentifierType(beneficiary?.accountIdentifierType ?? 'IBAN'); setRoutingIdentifier(beneficiary?.routingIdentifier ?? ''); setCountry(beneficiary?.country ?? beneficiary?.iban.slice(0, 2) ?? 'CH'); setBankName(beneficiary?.bankName ?? ''); setBic(beneficiary?.bic ?? ''); }}><option value="">Enter new recipient details</option>{beneficiaries.map((beneficiary) => <option key={beneficiary.id} value={beneficiary.id}>{beneficiary.name} · {beneficiary.currency} · {beneficiary.status === 'verified' ? 'Verified' : 'Pending verification'}</option>)}</select></label>
      <label>Recipient legal name<input value={recipientName || selected?.name || ''} onChange={(event) => setRecipientName(event.target.value)} /></label>
      <div className="form-row"><label>Recipient country<select value={['CH', 'US', 'GB', 'CA', 'AU', 'DE', 'FR'].includes(country) ? country : 'OTHER'} onChange={(event) => { setCountry(event.target.value); setAccountIdentifier(''); setRoutingIdentifier(''); setAccountIdentifierType(event.target.value === 'CH' || event.target.value === 'DE' || event.target.value === 'FR' ? 'IBAN' : 'account_number'); }}><option value="CH">Switzerland</option><option value="US">United States</option><option value="GB">United Kingdom</option><option value="CA">Canada</option><option value="AU">Australia</option><option value="DE">Germany</option><option value="FR">France</option><option value="OTHER">Other country</option></select></label><label>Bank name, if available<input value={bankName} onChange={(event) => setBankName(event.target.value)} placeholder="Bank name" /></label></div>
      {country === 'OTHER' && <label>Destination country code<input value={customCountry} onChange={(event) => setCustomCountry(event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2))} placeholder="ISO 3166-1 alpha-2, e.g. JP" /></label>}
      <label>Account identifier type<select value={accountIdentifierType} onChange={(event) => setAccountIdentifierType(event.target.value)}><option value="IBAN">IBAN</option><option value="account_number">Domestic account number</option></select></label>
      <label>{accountIdentifierType === 'IBAN' ? 'Recipient IBAN' : country === 'US' ? 'US bank account number' : country === 'GB' ? 'UK account number' : country === 'CA' ? 'Canadian account number' : country === 'AU' ? 'Australian account number' : 'Recipient account number'}<input value={accountIdentifier} onChange={(event) => setAccountIdentifier(event.target.value.toUpperCase())} placeholder={accountIdentifierType === 'IBAN' ? 'Enter IBAN' : 'Enter domestic account number'} /></label>
      {accountIdentifierType !== 'IBAN' && <label>{country === 'US' ? 'ABA routing number' : country === 'GB' ? 'Sort code' : country === 'CA' ? 'Institution and transit number' : country === 'AU' ? 'BSB number' : 'Local bank routing identifier'}<input value={routingIdentifier} onChange={(event) => setRoutingIdentifier(event.target.value.toUpperCase())} placeholder={country === 'US' ? '9 digits' : country === 'GB' ? '6 digits' : country === 'CA' ? 'Institution + transit' : country === 'AU' ? '6 digits' : 'Bank routing identifier'} /></label>}
      {category === 'international' && <><label>Recipient address<input value={address} onChange={(event) => setAddress(event.target.value)} /></label><label>Recipient bank BIC/SWIFT<input value={bic} onChange={(event) => setBic(event.target.value.toUpperCase())} /></label><label>Intermediary/correspondent bank, if required<input value={intermediaryBank} onChange={(event) => setIntermediaryBank(event.target.value)} /></label></>}
      {category === 'domestic' && recipientCountry !== 'CH'
        ? <p className="section-caption">Choose Switzerland for a domestic transfer, or select International transfer for another country.</p>
        : !countryIdentifierValid && <div className="auth-error">Check the account and routing details for the selected country.</div>}
    </>)}
    {stage === 2 && <>
      <div className="form-row"><label>Amount<input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" inputMode="decimal" /></label><label>Currency<select value={currency} disabled={Boolean(selected)} onChange={(event) => setSourceCurrency(event.target.value as Account['currency'])}><option>EUR</option><option>CHF</option></select></label></div>
      <label>Payment reference<input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={140} /></label>
      <label>Description<input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={280} placeholder="Purpose shown on transaction history" /></label>
      <label>Transfer purpose<input value={purpose} onChange={(event) => setPurpose(event.target.value)} maxLength={140} /></label>
      <div className="form-row">
        <label>Execution date<input type="date" value={executionDate} onChange={(event) => setExecutionDate(event.target.value)} /></label>
        {category === 'international' && (
          <label>Fee arrangement
            <select value={chargeBearer} onChange={(event) => setChargeBearer(event.target.value as typeof chargeBearer)}>
              <option value="SHA">SHA · shared</option>
              <option value="OUR">OUR · sender pays</option>
              <option value="BEN">BEN · beneficiary pays</option>
            </select>
          </label>
        )}
      </div>
      <div className="transfer-total"><span>Fee</span><b>{quoteMatchesCurrentTransfer ? `${currency} ${fee!.toFixed(2)}` : quoteBusy ? 'Calculating…' : 'Unavailable'}</b><span>Total debit</span><strong>{totalDebit === null ? '—' : `${currency} ${totalDebit.toFixed(2)}`}</strong>{quoteMatchesCurrentTransfer && <small className="quote-expiry">Quote valid until {new Date(quote!.expiresAt).toLocaleTimeString()}</small>}</div>
      {quoteError && <div className="auth-error">{quoteError}</div>}
    </>}
    {stage === 3 && <>
      <div className="transfer-confirmation">
        <div className="eyebrow">CONFIRM TRANSFER DETAILS</div>
        <div className="transfer-confirm-row"><span>Sender</span><b>{profile.fullName}</b></div>
        <div className="transfer-confirm-row"><span>Source account</span><b>{sourceCurrency} · {sourceAccount.number}</b></div>
        <div className="transfer-confirm-row"><span>Recipient</span><b>{recipientName || selected?.name || internalRecipient?.recipientName || ''}</b></div>
        {internalRecipient && <div className="transfer-confirm-row"><span>Recipient account</span><b>{internalRecipient.accountNumber}</b></div>}
        {currentIban && <div className="transfer-confirm-row"><span>Recipient IBAN</span><b>{currentIban}</b></div>}
        <div className="transfer-confirm-row"><span>Recipient bank</span><b>{category === 'internal' ? 'Veritas Private Bank' : bankName || 'Not supplied by a trusted bank lookup'}</b></div>
        <div className="transfer-confirm-row"><span>Payment type / rail</span><b>{category} · selected by server/provider capability</b></div>
        <div className="transfer-confirm-row"><span>Amount</span><b>{currency} {amountValue.toFixed(2)}</b></div>
        <div className="transfer-confirm-row"><span>Exchange rate</span><b>Not applicable; no conversion</b></div>
        <div className="transfer-confirm-row"><span>Fee / total debit</span><b>{fee === null || totalDebit === null ? 'Quote unavailable' : `${currency} ${fee.toFixed(2)} / ${currency} ${totalDebit.toFixed(2)}`}</b></div>
        <div className="transfer-confirm-row"><span>Reference / execution</span><b>{reference || 'None'} · {executionDate}</b></div>
        <div className="modal-note"><ShieldCheck size={15} /> Payment status updates are shown here as they are confirmed.</div>
      </div>
    </>}
    {stage === 4 && <>
      <label className="authorization-check"><input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} /> I authorize the displayed amount and fee to be debited from my selected account.</label>
      <p className="section-caption">{category === 'internal' ? 'The selected Veritas recipient account will be credited when you confirm.' : 'Your payment instruction and debit will be recorded in your account activity when you confirm.'}</p>
      {!processingEnabled && <div className="auth-error" role="status"><b>Transfer processing is unavailable.</b><ul>{processingBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>No preview balance will be debited.</div>}
    </>}
    <div className="modal-actions"><button className="outline-button" disabled={processing} onClick={stage === 0 ? onClose : () => setStage((current) => current - 1)}>{stage === 0 ? 'Cancel' : 'Back'}</button>{stage < stageNames.length - 1 ? <button className="primary-button" disabled={!canAdvance} onClick={async () => {
      if ((stage === 2 || stage === 3) && !(await refreshTransferQuote())) return;
      setStage((current) => current + 1);
    }}>Continue <ArrowUpRight size={16} /></button> : !quoteMatchesCurrentTransfer ? <button className="primary-button" disabled={quoteBusy || !validAmount} onClick={() => void refreshTransferQuote()}>{quoteBusy ? 'Refreshing quote…' : 'Refresh fee quote'} <ArrowLeftRight size={16} /></button> : <button className="primary-button" disabled={!authorized || !recipientDetailsValid || !validAmount || !affordableTotalDebit || !processingEnabled || processing} onClick={async () => {
      if (!quoteMatchesCurrentTransfer) return;
      setProcessing(true);
      setProcessingError('');
      try {
        const result = await onSave(buildInstruction());
        setSubmittedTransfer(result);
      } catch (error) {
        setProcessingError(error instanceof Error ? error.message : 'The transfer could not be processed.');
      } finally {
        setProcessing(false);
      }
    }}>{processing ? 'Processing transfer…' : 'Process transfer'} <ShieldCheck size={16} /></button>}</div>
  </Modal>;
}
function FundingModal({ accounts, onClose, onSave }: { accounts: Account[]; onClose: () => void; onSave: (request: FundingRequest) => void }) { const [amount, setAmount] = useState(''); const [source, setSource] = useState(''); const [accountCurrency, setAccountCurrency] = useState<Account['currency']>('EUR'); const validAmount = Number.isFinite(Number(amount)) && Number(amount) > 0; return <Modal title="New funding notice" subtitle="Funding notice" onClose={onClose}><label>Account<select value={accountCurrency} onChange={(event) => setAccountCurrency(event.target.value as Account['currency'])}><option value="EUR">EUR Private Account · {accountDisplayBalance(accountFor(accounts, 'EUR'))}</option><option value="CHF">CHF Private Account · {accountDisplayBalance(accountFor(accounts, 'CHF'))}</option></select></label><label>Expected amount<input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" inputMode="decimal" /></label><label>Source<input value={source} onChange={(event) => setSource(event.target.value)} placeholder="Source of funds" /></label><div className="modal-actions"><button className="outline-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!validAmount || !source.trim()} onClick={() => onSave({ id: `preview-funding-${Date.now()}`, accountCurrency, amount: Number(amount).toFixed(2), source: source.trim(), status: 'Under review', createdAt: new Date().toISOString() })}>Save notice <ArrowUpRight size={16} /></button></div></Modal>; }
function BeneficiaryModal({ onClose, onSave }: { onClose: () => void; onSave: (beneficiary: Beneficiary) => void }) {
  const [name, setName] = useState('');
  const [country, setCountry] = useState('CH');
  const [customCountry, setCustomCountry] = useState('');
  const [accountIdentifierType, setAccountIdentifierType] = useState('IBAN');
  const [accountIdentifier, setAccountIdentifier] = useState('');
  const [routingIdentifier, setRoutingIdentifier] = useState('');
  const [bankName, setBankName] = useState('');
  const [bic, setBic] = useState('');
  const [address, setAddress] = useState('');
  const [currency, setCurrency] = useState<'EUR' | 'CHF'>('EUR');
  const normalizedIdentifier = accountIdentifier.replace(/[\s-]/g, '').toUpperCase();
  const beneficiaryCountry = country === 'OTHER' ? customCountry : country;
  const validIdentifier = accountIdentifierType === 'IBAN'
    ? /^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(normalizedIdentifier) && normalizedIdentifier.startsWith(beneficiaryCountry)
    : country === 'US' ? /^\d{4,17}$/.test(normalizedIdentifier) && /^\d{9}$/.test(routingIdentifier.replace(/\D/g, ''))
      : country === 'GB' ? /^\d{8}$/.test(normalizedIdentifier) && /^\d{6}$/.test(routingIdentifier.replace(/\D/g, ''))
        : country === 'CA' ? /^\d{5,17}$/.test(normalizedIdentifier) && /^\d{8}$/.test(routingIdentifier.replace(/\D/g, ''))
          : country === 'AU' ? /^\d{5,10}$/.test(normalizedIdentifier) && /^\d{6}$/.test(routingIdentifier.replace(/\D/g, ''))
            : /^[A-Z0-9]{5,34}$/i.test(normalizedIdentifier);
  const identifierLabel = accountIdentifierType === 'IBAN' ? 'IBAN' : country === 'US' ? 'US bank account number' : country === 'GB' ? 'UK account number' : country === 'CA' ? 'Canadian account number' : country === 'AU' ? 'Australian account number' : 'Recipient account number';
  const routingLabel = country === 'US' ? 'ABA routing number' : country === 'GB' ? 'Sort code' : country === 'CA' ? 'Institution and transit number' : country === 'AU' ? 'BSB number' : 'Local routing identifier';
  return <Modal title="Save beneficiary" subtitle="Save recipient details for future payment instructions." onClose={onClose}>
    <label>Beneficiary legal name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Full name or registered business name" /></label>
    <div className="form-row"><label>Destination country<select value={country} onChange={(event) => { setCountry(event.target.value); setAccountIdentifier(''); setRoutingIdentifier(''); setAccountIdentifierType(event.target.value === 'CH' || event.target.value === 'DE' || event.target.value === 'FR' ? 'IBAN' : 'account_number'); }}><option value="CH">Switzerland</option><option value="US">United States</option><option value="GB">United Kingdom</option><option value="CA">Canada</option><option value="AU">Australia</option><option value="DE">Germany</option><option value="FR">France</option><option value="OTHER">Other country</option></select></label><label>Account currency<select value={currency} onChange={(event) => setCurrency(event.target.value as 'EUR' | 'CHF')}><option>EUR</option><option>CHF</option></select></label></div>
    {country === 'OTHER' && <label>Destination country code<input value={customCountry} onChange={(event) => setCustomCountry(event.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2))} placeholder="ISO 3166-1 alpha-2, e.g. JP" /></label>}
    <label>Account identifier type<select value={accountIdentifierType} onChange={(event) => setAccountIdentifierType(event.target.value)}><option value="IBAN">IBAN</option><option value="account_number">Domestic account number</option></select></label>
    <label>{identifierLabel}<input value={accountIdentifier} onChange={(event) => setAccountIdentifier(event.target.value.toUpperCase())} placeholder={`Enter ${identifierLabel.toLowerCase()}`} /></label>
    {accountIdentifierType !== 'IBAN' && <label>{routingLabel}<input value={routingIdentifier} onChange={(event) => setRoutingIdentifier(event.target.value.toUpperCase())} placeholder="Enter local bank routing details" /></label>}
    <div className="form-row"><label>Bank name<input value={bankName} onChange={(event) => setBankName(event.target.value)} placeholder="Bank name" /></label><label>BIC/SWIFT, if available<input value={bic} onChange={(event) => setBic(event.target.value.toUpperCase())} placeholder="Optional" /></label></div>
    <label>Recipient address, if required<input value={address} onChange={(event) => setAddress(event.target.value)} /></label>
    <div className="iban-hint"><ShieldCheck size={14} /> Confirm account and routing details with the recipient before submitting.</div>
    <div className="modal-actions"><button className="outline-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!name.trim() || !validIdentifier || !/^[A-Z]{2}$/.test(beneficiaryCountry)} onClick={() => onSave({ id: `beneficiary-${Date.now()}`, name: name.trim(), iban: accountIdentifierType === 'IBAN' ? accountIdentifier : '', accountIdentifierType, accountIdentifier, routingIdentifier, currency, status: 'pending_verification', initials: name.trim().slice(0, 2).toUpperCase(), country: beneficiaryCountry, bankName, bic, address })}>Save beneficiary <ArrowUpRight size={16} /></button></div>
  </Modal>;
}
function TemplateModal({ beneficiaries, onClose, onSave }: { beneficiaries: Beneficiary[]; onClose: () => void; onSave: (template: RecurringTemplate) => void }) { const [name, setName] = useState(''); const [beneficiaryId, setBeneficiaryId] = useState(beneficiaries.find((beneficiary) => beneficiary.status === 'verified')?.id ?? '');
  const [amount, setAmount] = useState(''); const [frequency, setFrequency] = useState<RecurringTemplate['frequency']>('Monthly'); const [nextExecution, setNextExecution] = useState('2026-12-01'); const [reference, setReference] = useState(''); const selected = beneficiaries.find((beneficiary) => beneficiary.id === beneficiaryId);
  return <Modal title="New recurring wire template" subtitle="Save a repeatable instruction. Each future payment still requires fresh controls and provider confirmation." onClose={onClose}><label>Template name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="For example: Nordic advisory retainer" /></label><label>Verified beneficiary<select value={beneficiaryId} onChange={(event) => setBeneficiaryId(event.target.value)}>{beneficiaries.filter((beneficiary) => beneficiary.status === 'verified').map((beneficiary) => <option key={beneficiary.id} value={beneficiary.id}>{beneficiary.name} · {beneficiary.currency}</option>)}</select></label><div className="form-row"><label>Amount<input value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" inputMode="decimal" /></label><label>Frequency<select value={frequency} onChange={(event) => setFrequency(event.target.value as RecurringTemplate['frequency'])}><option>Monthly</option><option>Quarterly</option><option>Yearly</option></select></label></div><div className="form-row"><label>Next review date<input type="date" value={nextExecution} onChange={(event) => setNextExecution(event.target.value)} /></label><label>Currency<input value={selected?.currency ?? ''} readOnly /></label></div><label>Reference<input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Optional payment reference" /></label><div className="modal-actions"><button className="outline-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={!name.trim() || !amount || !selected} onClick={() => onSave({ id: `template-${Date.now()}`, name: name.trim(), beneficiaryId: selected!.id, beneficiaryName: selected!.name, amount, currency: selected!.currency, frequency, nextExecution: new Date(`${nextExecution}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }), reference, status: 'active' })}>Save template <ArrowUpRight size={16} /></button></div></Modal>; }
function LoadingScreen() { return <div className="auth-shell"><div className="auth-card loading-card"><div className="brand-mark"><ShieldCheck size={21} /></div><h1>Loading your relationship</h1><p>Securing your session and retrieving your cloud profile.</p></div></div>; }
function AuthView({ error, success, onLogin, onRegister, onHome }: { error: string; success: string; onLogin: (email: string, password: string) => Promise<void>; onRegister: () => void; onHome: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState(error);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setMessage('');
    try { await onLogin(email, password); } catch (failure) { setMessage(failure instanceof Error ? failure.message : 'Sign-in failed. Check your credentials and try again.'); }
    finally { setBusy(false); }
  };
  return <div className="auth-shell public-auth-shell">
    <main className="auth-main">
      <div className="auth-card">
        <div className="eyebrow">SECURE CLIENT ACCESS</div>
        <h1>Welcome back</h1>
        <p className="auth-intro">Sign in to your private client relationship.</p>
        {success && <div className="auth-success" role="status">{success}</div>}
        {message && <div className="auth-error" role="alert">{message}</div>}
        <label>Email address<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void submit()} /></label>
        <button className="primary-button auth-submit" disabled={busy || !email || !password} onClick={() => void submit()}>{busy ? 'Signing in…' : 'Sign in securely'} <LogIn size={16} /></button>
        <button className="auth-switch" onClick={onRegister}>Become a client <ArrowRight size={14} /></button>
        <button className="auth-switch" onClick={onHome}>Return to Veritas home</button>
      </div>
    </main>
    <section className="auth-visual">
      <div className="auth-visual-image" />
      <div className="auth-visual-content">
        <button className="auth-brand auth-brand-button" onClick={onHome}>
          <div className="brand-mark"><ShieldCheck size={21} /></div>
          <div><div className="brand-name">VERITAS</div><div className="brand-type">PRIVATE BANK</div></div>
        </button>
        <div className="eyebrow">PRIVATE CLIENT ACCESS</div>
        <h2>Clarity for your financial life.</h2>
        <p>Access your EUR and CHF accounts, review activity, and manage your client profile.</p>
      </div>
      <div className="auth-visual-caption">VERITAS · PRIVATE CLIENT PORTAL</div>
    </section>
  </div>;
}

function RegistrationView({ onLogin, onHome, onRegistered }: { onLogin: () => void; onHome: () => void; onRegistered: () => void }) {
  const [form, setForm] = useState({ firstName: '', middleName: '', lastName: '', email: '', phone: '', dateOfBirth: '', countryOfResidence: '', residentialAddress: '', password: '', confirmPassword: '', acceptTerms: false });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const update = (key: keyof typeof form, value: string | boolean) => setForm((current) => ({ ...current, [key]: value }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      await apiRequest('/api/auth/register', { method: 'POST', body: JSON.stringify(form) });
      onRegistered();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Registration could not be completed.'); }
    finally { setBusy(false); }
  };
  return <div className="registration-shell"><div className="registration-top"><button className="auth-brand auth-brand-button" onClick={onHome}><div className="brand-mark"><ShieldCheck size={21} /></div><div><div className="brand-name">VERITAS</div><div className="brand-type">PRIVATE BANK</div></div></button><button className="text-button" onClick={onLogin}>Already a client? Sign in <ArrowRight size={14} /></button></div><form className="registration-panel" onSubmit={(event) => void submit(event)}><div className="eyebrow">PRIVATE CLIENT APPLICATION</div><h1>Begin a relationship</h1><p className="muted-copy">Create a secure client profile. Account balances begin at zero and require verified funding.</p>{message && <div className="auth-error" role="alert">{message}</div>}<div className="registration-grid"><label>First name<input required autoComplete="given-name" value={form.firstName} onChange={(event) => update('firstName', event.target.value)} /></label><label>Middle name <span>Optional</span><input autoComplete="additional-name" value={form.middleName} onChange={(event) => update('middleName', event.target.value)} /></label><label>Last name<input required autoComplete="family-name" value={form.lastName} onChange={(event) => update('lastName', event.target.value)} /></label><label>Email address<input required type="email" autoComplete="email" value={form.email} onChange={(event) => update('email', event.target.value)} /></label><label>Phone number<input required type="tel" autoComplete="tel" value={form.phone} onChange={(event) => update('phone', event.target.value)} /></label><label>Date of birth<input required type="date" value={form.dateOfBirth} onChange={(event) => update('dateOfBirth', event.target.value)} /></label><label>Country of residence<input required autoComplete="country-name" value={form.countryOfResidence} onChange={(event) => update('countryOfResidence', event.target.value)} /></label><label className="registration-address">Residential address<textarea required minLength={8} autoComplete="street-address" rows={3} value={form.residentialAddress} onChange={(event) => update('residentialAddress', event.target.value)} /></label><label>Password<input required type="password" autoComplete="new-password" minLength={12} value={form.password} onChange={(event) => update('password', event.target.value)} /><small>12+ characters, uppercase, lowercase, number and symbol.</small></label><label>Confirm password<input required type="password" autoComplete="new-password" value={form.confirmPassword} onChange={(event) => update('confirmPassword', event.target.value)} /></label></div><label className="terms-check"><input type="checkbox" checked={form.acceptTerms} onChange={(event) => update('acceptTerms', event.target.checked)} /> I accept the terms of service and privacy policy.</label><div className="registration-actions"><button className="outline-button" type="button" onClick={onHome}>Cancel</button><button className="primary-button" disabled={busy || !form.acceptTerms}>{busy ? 'Creating profile…' : 'Create client profile'} <ArrowRight size={15} /></button></div></form></div>;
}

function PublicLanding({ onLogin, onRegister }: { onLogin: () => void; onRegister: () => void }) {
  return <div className="public-site">
    <header className="public-header">
      <a className="public-brand" href="/" onClick={(event) => { event.preventDefault(); window.history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); }}>
        <span className="public-brand-mark"><ShieldCheck size={20} /></span>
        <span><b>VERITAS</b><small>PRIVATE BANK</small></span>
      </a>
      <nav className="public-nav">
        <a href="#private-banking">Overview</a>
        <a href="#services">Services</a>
        <a href="#accounts">Accounts</a>
        <a href="#payments">Payments</a>
        <a href="#security">Security</a>
      </nav>
      <div className="public-actions">
        <button className="public-login" onClick={onLogin}>Client Login</button>
        <button className="public-apply" onClick={onRegister}>Create Profile</button>
      </div>
    </header>
    <main>
      <section className="public-hero" id="private-banking">
        <div className="public-hero-image" role="img" aria-label="Lake Geneva and the Swiss Alps at dusk" />
        <div className="public-hero-content">
          <span className="eyebrow">EUR &amp; CHF CLIENT ACCOUNTS</span>
          <h1>Your EUR and CHF accounts, in one clear view.</h1>
          <p>Review balances and transaction activity, manage payment instructions, and access your client profile through one secure portal.</p>
          <div className="public-hero-actions">
            <button className="public-apply" onClick={onRegister}>Create a client profile <ArrowRight size={15} /></button>
            <button className="public-hero-link" onClick={() => document.getElementById('services')?.scrollIntoView({ behavior: 'smooth' })}>Explore account services</button>
          </div>
        </div>
        <div className="public-hero-caption">EUR · CHF · CLIENT PORTAL</div>
      </section>
      <section className="public-intro" id="accounts">
        <span className="eyebrow">ACCOUNT OVERVIEW</span>
        <h2>Your account information, in one place.</h2>
        <p>Review account details, ledger and available balances, and recorded activity for your EUR and CHF accounts.</p>
      </section>
      <section className="public-services" id="services">
        <div className="public-section-heading">
          <span className="eyebrow">CLIENT SERVICES</span>
          <h2>Account services</h2>
        </div>
        <div className="service-grid">
          <article><span>01</span><h3>EUR and CHF accounts</h3><p>Review account identifiers, ledger balances, available balances, and pending amounts.</p></article>
          <article><span>02</span><h3>Internal transfers</h3><p>Transfer funds between eligible Veritas accounts. Completed transfers are recorded to both account ledgers.</p></article>
          <article><span>03</span><h3>Payment instructions</h3><p>Prepare payment instructions, review applicable fees, and track their status.</p></article>
          <article><span>04</span><h3>Funding notices</h3><p>Submit an incoming-funds notice for review and track its status.</p></article>
          <article><span>05</span><h3>Transactions and statements</h3><p>Review account activity and export statements from available account data.</p></article>
          <article><span>06</span><h3>Profile and access</h3><p>Manage your profile through authenticated, customer-scoped account access.</p></article>
        </div>
      </section>
      <section className="public-philosophy" id="payments">
        <div>
          <span className="eyebrow">TRANSFERS AND PAYMENTS</span>
          <h2>Payment instructions with clear status tracking.</h2>
        </div>
        <p>Transfer funds between eligible Veritas accounts or prepare outgoing payment instructions. Review fee quotes, references, and status updates in the client portal.</p>
      </section>
      <section className="public-security" id="security">
        <div>
          <span className="eyebrow">ACCOUNT SECURITY</span>
          <h2>Protected account access.</h2>
          <p>Passwords are stored as derived hashes, and session cookies are HTTP-only. Authenticated requests are scoped to the signed-in customer.</p>
        </div>
        <div className="security-list">
          <div><LockKeyhole size={17} /> Protected customer sessions</div>
          <div><ShieldCheck size={17} /> Account-scoped access</div>
          <div><ClipboardList size={17} /> Recorded ledger activity</div>
        </div>
      </section>
      <section className="public-contact" id="contact">
        <span className="eyebrow">GET STARTED</span>
        <h2>Access your client portal.</h2>
        <p>Create a client profile to access your EUR and CHF accounts, or sign in to continue to your existing profile.</p>
        <button className="public-apply" onClick={onRegister}>Create a client profile <ArrowRight size={15} /></button>
      </section>
    </main>
    <footer className="public-footer" id="legal">
      <div className="footer-brand">
        <span className="public-brand-mark"><ShieldCheck size={20} /></span>
        <span><b>VERITAS</b><small>PRIVATE BANK</small></span>
        <p>Client account and servicing portal.</p>
      </div>
      <div><b>Veritas</b><a href="#private-banking">Overview</a><a href="#services">Client services</a><a href="#security">Account security</a></div>
      <div><b>Client access</b><button onClick={onLogin}>Client Login</button><button onClick={onRegister}>Create Profile</button></div>
      <div><b>Information</b><a href="#payments">Payment processing</a><a href="#security">Account security</a></div>
    </footer>
  </div>;
}

function Modal({ title, subtitle, onClose, children, className = '' }: { title: string; subtitle: string; onClose: () => void; children: ReactNode; className?: string }) { return <div className="modal-backdrop"><div className={`modal ${className}`}><div className="modal-head"><div><h2>{title}</h2><p>{subtitle}</p></div><button onClick={onClose}><X size={18} /></button></div>{children}</div></div>; }

export default App;
