import { api, getSession, setSession } from './client.js';
import { toMinor, decimalAmount, formatMoney, scaleOf, estimateTarget, escapeHtml as escape } from './money.mjs';
import { createPreview } from './preview.mjs';

const icons = {
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  wallet: '<path d="M20 8V5H5a2 2 0 0 0 0 4h16v11H5a2 2 0 0 1-2-2V7"/><path d="M21 12h-6v5h6m-3-2.5h.01"/>',
  exchange: '<path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4"/>',
  activity: '<path d="M5 3h14v18l-3-2-4 2-4-2-3 2zM8 8h8M8 12h8M8 16h4"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  diagonal: '<path d="M6 18 18 6M6 6h12v12"/>',
  down: '<path d="M12 4v16m-6-6 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 3h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  logout: '<path d="M9 3H4v18h5m6-14 5 5-5 5M8 12h12"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6h14M5 18h14"/>',
  book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1zm0 0v15"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
  bank: '<path d="M3 9 12 4l9 5M5 10v8m4.7-8v8m4.6-8v8M19 10v8M3 20h18"/>',
};
const icon = (name, className = '') => `<svg class="icon ${className}" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.arrow}</svg>`;
const names = { NGN: 'Nigerian naira', USD: 'US dollar', EUR: 'Euro', GBP: 'British pound' };
const flag = (currency) => `<span class="flag flag-${escape(currency.toLowerCase())}" aria-hidden="true">${{ USD: '🇺🇸', EUR: '🇪🇺', GBP: '🇬🇧', NGN: '🇳🇬' }[currency] || icon('globe')}</span>`;
const brand = () => '<a class="brand" href="/" data-route="/"><img src="/assets/mark.svg" alt="" width="35" height="35">kobo<span>fx</span><span class="brand-dot">.</span></a>';
const button = (text, action, style = 'primary', attributes = '') => `<button class="button ${style}" data-action="${action}" ${attributes}>${text}</button>`;
const root = document.querySelector('#app');
let preview = sessionStorage.getItem('kobofx.preview') === 'true' ? createPreview() : null;
let balances = [], rates = null, items = [], cursor = null, loading = false, loadError = '', rateError = '', historyError = '';
let view = location.pathname, filter = '', search = '', hiddenBalance = false, pendingRegistration = null;
let modal = null, pollGeneration = 0, quote = null, tradeAttempt = null, toastTimer, lastFocus;
let beneficiaries = null, beneficiaryError = '', stash = null, stashItems = [], stashError = '', bankCache = null, withdrawAttempt = null, codeCooldownUntil = 0, codeTimer;
const user = () => preview?.user || getSession()?.user;
const request = (path, options) => preview ? preview.request(path, options) : api(path, options);
const money = (amount, currency, minorUnit) => formatMoney(amount, currency, minorUnit ?? scaleOf(currency, balances));
const amountVisible = (amount, currency, minorUnit) => hiddenBalance ? '••••••' : money(amount, currency, minorUnit);
const firstName = () => preview ? 'Ada' : (user()?.email?.split('@')[0].split(/[._-]/)[0] || 'there').replace(/^./, (letter) => letter.toUpperCase());
const readableDate = (date) => date ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(date)) : 'Just now';
const stateLabel = (status) => ({ COMPLETED: 'Completed', POSTED: 'Completed', PENDING: 'In progress', FAILED: 'Unsuccessful', REVERSED: 'Reversed' })[status] || status;
const getStored = (key) => { try { return JSON.parse(sessionStorage.getItem(`kobofx.${key}`) || 'null'); } catch { return null; } };

function toast(message) {
  const element = document.querySelector('#announcements');
  element.textContent = message; element.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('visible'), 5000);
}

function navigate(path) {
  closeModal(); view = path; history.pushState({}, '', path); render(); window.scrollTo({ top: 0 });
  if (user() && path === '/activity') loadHistory();
  if (user() && path === '/withdraw') loadWithdrawals();
  document.querySelector('#main h1')?.focus({ preventScroll: true });
}

async function loadData() {
  loading = true; loadError = ''; rateError = ''; historyError = ''; render();
  const results = await Promise.allSettled([request('/wallet'), request('/fx/rates'), request('/transactions?limit=10')]);
  if (results[0].status === 'fulfilled') balances = results[0].value.balances;
  else loadError = results[0].reason.message;
  if (results[1].status === 'fulfilled') rates = results[1].value;
  else { rates = null; rateError = results[1].reason.message; }
  if (results[2].status === 'fulfilled') { items = results[2].value.items; cursor = results[2].value.nextCursor; }
  else historyError = results[2].reason.message;
  loading = false; render();
}

async function loadHistory(append = false) {
  const query = new URLSearchParams({ limit: '20', ...(filter ? { type: filter } : {}), ...(append && cursor ? { cursor } : {}) });
  try {
    const result = await request(`/transactions?${query}`);
    items = append ? [...new Map([...items, ...result.items].map((item) => [item.reference, item])).values()] : result.items;
    cursor = result.nextCursor; historyError = ''; render();
  } catch (error) { historyError = error.message; render(); }
}

async function loadWithdrawals() {
  beneficiaryError = ''; stashError = '';
  const [list, held, receipts] = await Promise.allSettled([request('/wallet/withdrawal-beneficiaries?limit=100'), request('/stash'), request('/stash/transactions?limit=5')]);
  if (list.status === 'fulfilled') beneficiaries = list.value.items; else { beneficiaries = null; beneficiaryError = list.reason.message; }
  if (held.status === 'fulfilled') stash = held.value; else { stash = null; stashError = held.reason.message; }
  stashItems = receipts.status === 'fulfilled' ? receipts.value.items : [];
  if (view === '/withdraw') render();
}

/** `ada@example.com` → `a••@example.com`: enough to recognise, not to copy. */
function maskEmail(email = '') {
  const [name, domain] = email.split('@');
  return domain ? `${name[0]}${'•'.repeat(Math.max(2, name.length - 1))}@${domain}` : 'your email';
}

function globeArtwork() {
  return `<div class="world-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="globe-art"><svg viewBox="0 0 300 300"><circle cx="150" cy="150" r="132"/><ellipse cx="150" cy="150" rx="86" ry="132"/><ellipse cx="150" cy="150" rx="34" ry="132"/><ellipse cx="150" cy="150" rx="132" ry="46"/><ellipse cx="150" cy="150" rx="132" ry="95"/><path d="M18 150h264M150 18v264"/></svg></div><span class="float-currency currency-dollar">$</span><span class="float-currency currency-naira">₦</span><span class="float-currency currency-euro">€</span><div class="art-label">${icon('globe')} One wallet. More of the world.</div><span class="spark spark-one">✦</span><span class="spark spark-two">✧</span></div>`;
}

function landing() {
  return `<div class="landing"><header class="landing-nav">${brand()}<nav aria-label="Main navigation"><a href="#how-it-works">How it works</a><a href="#made-for-you">Made for you</a></nav><div>${button('Log in', 'login', 'text')}${button(`Get started ${icon('arrow')}`, 'signup')}</div></header>
    <main id="main"><section class="landing-hero"><div><span class="eyebrow"><span class="tiny-dot"></span> A LITTLE LOCAL. A LITTLE GLOBAL.</span><h1 tabindex="-1">Your money.<br>More <em>possibilities.</em></h1><p>From naira to your next big plan. Add money, hold different currencies, and exchange with confidence. All in one happy place.</p><div class="hero-actions">${button(`Make yourself at home ${icon('arrow')}`, 'signup')}${button(`Take a look around ${icon('diagonal')}`, 'preview', 'text')}</div><div class="hero-assurance">${icon('shield')} Your balance, always clear. Your next move, always yours.</div></div>${globeArtwork()}</section>
    <section class="currency-strip" aria-label="Supported wallets"><span>A wallet that speaks<br><strong>your currency.</strong></span>${Object.entries(names).map(([currency, name]) => `<div>${flag(currency)}<span><strong>${currency}</strong><small>${name}</small></span></div>`).join('')}</section>
    <section class="journey-section" id="how-it-works"><span class="eyebrow">BIG POSSIBILITIES. SMALL STEPS.</span><h2>Good things start with a little.</h2><p>No complicated charts. No guesswork. Just you, moving forward.</p><div class="journey-grid">${[['01', 'wallet', 'Make it yours', 'Create your account and verify your email. Your naira wallet will be waiting.'], ['02', 'plus', 'Give your wallet a little love', 'Add money securely with Paystack. We’ll let you know when it arrives.'], ['03', 'exchange', 'Find your next currency', 'See exactly what you’ll get, review your rate, and exchange when you’re ready.']].map(([number, symbol, title, description]) => `<article><div class="step-top"><span>${number}</span>${icon(symbol)}</div><h3>${title}</h3><p>${description}</p></article>`).join('')}</div></section>
    <section class="landing-bottom" id="made-for-you"><div><span class="eyebrow">ROOM FOR YOUR NEXT CHAPTER</span><h2>New currency.<br>Same peace of mind.</h2><p>See every balance and every move. A clearer way to make yourself at home in more than one currency.</p>${button(`Explore a sample wallet ${icon('arrow')}`, 'preview', 'white')}</div><div class="stacked-wallets" aria-hidden="true"><div><span>${flag('NGN')} Nigerian naira</span><strong>₦325,000.00</strong><small>Sample balance</small></div><div><span>${flag('USD')} US dollar</span><strong>$240.00</strong><small>Sample balance</small></div></div></section></main><footer class="landing-footer">${brand()}<span>A simpler way to move between currencies.</span><span>Made for your next move.</span></footer></div>`;
}

function authPage() {
  const register = view === '/signup'; const verify = view === '/verify';
  return `<div class="auth-layout"><aside class="auth-aside">${brand()}<div><span class="eyebrow">YOUR NEXT CHAPTER STARTS HERE</span><h2>A little local.<br>A little <em>global.</em></h2><p>Your money should feel at home.<br>Whatever currency you’re thinking in.</p>${globeArtwork()}</div><span class="auth-footnote">Simple steps. More possibilities.</span></aside><main id="main" class="auth-main"><a class="back-link" href="/" data-route="/">← Back to home</a><div class="auth-form-wrap"><span class="square-icon">${icon(verify ? 'mail' : register ? 'wallet' : 'user')}</span><h1 tabindex="-1">${verify ? 'Check your inbox.' : register ? 'Let’s make it yours.' : 'Good to have you back.'}</h1><p>${verify ? `We sent a six-digit code to <strong>${escape(pendingRegistration?.email || 'your email')}</strong>. Enter it below to get started.` : register ? 'One account. A world of possibilities.' : 'Your wallet is right where you left it.'}</p>
      <form id="auth-form" data-form="auth"><div class="form-error" role="alert" hidden></div>
      ${verify && pendingRegistration ? '' : `<label>Email address<input name="email" type="email" autocomplete="email" placeholder="you@example.com" required maxlength="254"></label>`}
      ${verify && pendingRegistration ? '' : `<label>Password<div class="password-field"><input name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" placeholder="${register ? 'Make it at least 12 characters' : 'Enter your password'}" minlength="${register ? '12' : '1'}" maxlength="128" required><button type="button" data-action="password" aria-label="Show password">${icon('eye')}</button></div>${register ? '<small>A memorable phrase makes a great password.</small>' : ''}</label>`}
      ${verify ? '<label>Verification code<input class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required></label>' : ''}
      <button class="button primary wide" type="submit">${verify ? 'Verify & open my wallet' : register ? 'Create my account' : 'Log in'} ${icon('arrow')}</button></form>
      ${verify ? `<div class="auth-switch">No code yet? <button class="text-link" data-action="resend">Send another code</button></div>` : `<div class="auth-switch">${register ? 'Already feel at home here?' : 'New to KoboFX?'} <a href="${register ? '/login' : '/signup'}" data-route="${register ? '/login' : '/signup'}">${register ? 'Log in' : 'Create an account'}</a></div>`}
      ${!register && !verify ? '<button class="text-link verify-link" data-route="/verify">Still need to verify your email?</button>' : ''}
      <div class="auth-divider"><span>just looking?</span></div>${button(`Explore with sample money ${icon('diagonal')}`, 'preview', 'secondary wide')}<p class="auth-note">${icon('lock')} Your account details stay private.</p></div></main></div>`;
}

function dashboardShell() {
  const page = view.split('/')[1] || 'home';
  const navigation = [['home', 'home', 'Overview'], ['wallets', 'wallet', 'My wallets'], ['exchange', 'exchange', 'Exchange'], ['withdraw', 'bank', 'Withdraw'], ['activity', 'activity', 'Activity']];
  return `<div class="app-shell"><aside class="sidebar">${brand()}<span class="sidebar-caption">YOUR EVERYDAY, EVERYWHERE</span><nav aria-label="Wallet navigation">${navigation.map(([path, symbol, title]) => `<a href="/${path}" data-route="/${path}" class="nav-item ${page === path ? 'active' : ''}" ${page === path ? 'aria-current="page"' : ''}>${icon(symbol)}${title}${page === path ? '<span class="nav-dot"></span>' : ''}</a>`).join('')}</nav><div class="sidebar-bottom"><div class="sidebar-prompt"><span class="little-spark">✦</span><strong>A new currency.<br>A new possibility.</strong><p>Make your next move a little simpler.</p><button class="text-link" data-route="/exchange">Let’s explore ${icon('arrow')}</button></div><a href="/help" data-route="/help" class="nav-item ${page === 'help' ? 'active' : ''}">${icon('help')}A little help</a><a href="/account" data-route="/account" class="nav-item ${page === 'account' ? 'active' : ''}">${icon('user')}My account</a><button class="nav-item logout" data-action="logout">${icon('logout')}${preview ? 'Leave preview' : 'Log out'}</button><div class="sidebar-note">${icon('shield')} Built around your peace of mind.</div></div></aside><div class="workspace"><header class="app-header"><div class="mobile-brand">${brand()}</div><div class="breadcrumb">My space <span>/</span> <strong>${navigation.find(([path]) => path === page)?.[2] || (page === 'help' ? 'A little help' : 'My account')}</strong></div><div class="header-right">${preview ? '<span class="preview-badge"><span></span> Preview mode</span>' : '<span class="session-badge">Your personal wallet</span>'}<button class="avatar" data-route="/account" aria-label="Open my account">${escape(firstName()[0])}</button></div></header>
    ${preview ? `<div class="preview-banner">${icon('globe')}<span>You’re exploring a sample wallet. No real money moves.</span><button data-action="signup">Make it yours ${icon('arrow')}</button></div>` : ''}
    <main id="main" class="app-main">${loadError ? `<div class="notice error">${icon('help')}<span>${escape(loadError)}</span><button class="text-link" data-action="refresh">Try again</button></div>` : ''}${page === 'home' ? overview() : page === 'wallets' ? walletsPage() : page === 'exchange' ? exchangePage() : page === 'withdraw' ? withdrawPage() : page === 'activity' ? activityPage() : page === 'account' ? accountPage() : helpPage()}</main><footer class="app-footer"><span>Made for your next move.</span><span>${icon('shield')} Clear balances. Confident decisions.</span></footer><nav class="mobile-nav" aria-label="Mobile navigation">${navigation.map(([path, symbol, title]) => `<a href="/${path}" data-route="/${path}" ${page === path ? 'aria-current="page"' : ''}>${icon(symbol)}<span>${title}</span></a>`).join('')}</nav></div></div>`;
}

function pageHeading(title, subtitle, action = '') { return `<div class="page-heading"><div><h1 tabindex="-1">${title}</h1><p>${subtitle}</p></div>${action}</div>`; }

function walletCards() {
  const currencies = [...new Set(['NGN', 'USD', 'EUR', 'GBP', ...balances.map((balance) => balance.currency)])];
  return `<div class="wallet-grid">${currencies.map((currency) => {
    const balance = balances.find((entry) => entry.currency === currency);
    return `<button class="wallet-card ${currency === 'NGN' ? 'main-wallet' : ''}" data-action="wallet-detail" data-currency="${currency}"><span class="wallet-card-top">${flag(currency)}<span>${currency}</span>${icon('diagonal')}</span><small>${escape(names[currency] || currency)}</small><strong>${loading ? '<span class="skeleton">&nbsp;</span>' : balance ? escape(amountVisible(balance.available, currency, balance.minorUnit)) : money('0', currency)}</strong><span class="wallet-card-bottom">${balance ? 'Available balance' : 'Ready when you are'}<span class="wallet-dot"></span></span></button>`;
  }).join('')}</div>`;
}

function overview() {
  const pending = !preview && getStored('funding');
  const pendingWithdrawal = !preview && getStored('withdrawal');
  return `${pageHeading(`A good day for possibilities, ${escape(firstName())}.`, 'A little overview of your money, wherever it’s headed.', `<div class="heading-actions">${button(`${icon('bank')} Withdraw`, 'withdraw', 'secondary')}${button(`${icon('plus')} Fund my wallet`, 'fund')}</div>`)}
    ${pending ? `<div class="notice">${icon('clock')}<span>You have a payment to check on.</span><button class="text-link" data-action="fund">Check payment ${icon('arrow')}</button></div>` : ''}
    ${pendingWithdrawal ? `<div class="notice">${icon('bank')}<span>You have a withdrawal on its way.</span><button class="text-link" data-action="withdrawal-check">Check withdrawal ${icon('arrow')}</button></div>` : ''}
    <section class="welcome-card"><div><span class="eyebrow">YOUR WORLD, A LITTLE CLOSER</span><h2>At home in naira.<br>Ready for <em>everywhere.</em></h2><p>Different currencies. One clear view.<br>Make room for whatever comes next.</p>${button(`Make your next move ${icon('arrow')}`, 'exchange', 'white')}</div>${globeArtwork()}</section>
    <section class="section"><div class="section-heading"><h2>Your little corner of the world <button class="icon-button" data-action="balance-visibility" aria-label="${hiddenBalance ? 'Show' : 'Hide'} balances" aria-pressed="${hiddenBalance}">${icon('eye')}</button></h2><a href="/wallets" data-route="/wallets">All wallets ${icon('arrow')}</a></div>${walletCards()}</section>
    <div class="overview-bottom"><section class="activity-card"><div class="section-heading"><h2>Your latest moves</h2><a href="/activity" data-route="/activity">View all ${icon('arrow')}</a></div>${transactionList(items.slice(0, 4))}</section><aside class="rates-card"><div class="section-heading"><h2>A world of rates</h2><span class="rate-dot">${preview ? 'Sample' : rates?.stale ? 'Updating' : rates ? 'Latest' : '—'}</span></div><p>A little look at what your money can do.</p>${rateRows()}<button class="text-link" data-route="/exchange">Find your exchange ${icon('arrow')}</button>${attribution()}</aside></div>
    <section class="gentle-banner"><span class="square-icon peach">${icon('book')}</span><div><strong>New here? You’re in good company.</strong><p>Let’s walk through your first steps, together.</p></div><button class="text-link" data-route="/help">A little guidance ${icon('arrow')}</button></section>`;
}

function rateRows() {
  if (!rates) return `<div class="inline-empty">${loading ? 'Finding the latest rates…' : escape(rateError || 'Rates will appear here when available.')}<button class="text-link" data-action="refresh">Refresh rates</button></div>`;
  return ['USD', 'EUR', 'GBP'].map((currency) => {
    const pair = rates.pairs.find((entry) => entry.from === currency && entry.to === 'NGN');
    if (!pair) return '';
    return `<div class="rate-row"><span>${flag(currency)}<strong>1 ${currency}</strong></span><strong>₦${escape(pair.clientRate)}<small>NGN</small></strong></div>`;
  }).join('');
}
function attribution() { return rates?.attribution ? `<a class="attribution" href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer">${escape(rates.attribution.text)}</a>` : preview ? '<span class="attribution">Illustrative rates for this preview.</span>' : ''; }

function transactionList(list) {
  if (historyError) return `<div class="empty-state">${icon('activity')}<h3>We couldn’t load your activity.</h3><p>${escape(historyError)}</p><button class="text-link" data-action="history-refresh">Try again</button></div>`;
  if (loading) return '<div class="list-skeleton"><span></span><span></span><span></span></div>';
  if (!list.length) return `<div class="empty-state">${icon('activity')}<h3>A fresh start looks good on you.</h3><p>Your first move will appear here. Start by adding money to your wallet.</p>${button('Add your first money', 'fund', 'secondary')}</div>`;
  return `<div class="transaction-list">${list.map((item) => {
    const conversion = item.type === 'CONVERSION';
    const withdrawal = item.type === 'WITHDRAWAL';
    const returned = item.type === 'REVERSAL' && item.reference.startsWith('withdrawal-reversal:');
    const credit = item.legs.find((leg) => leg.direction === 'CREDIT');
    const debit = item.legs.find((leg) => leg.direction === 'DEBIT');
    const amount = credit || debit || item.requested;
    const title = conversion ? `${debit?.currency || ''} to ${credit?.currency || ''}` : withdrawal ? 'Withdrawal to bank' : returned ? 'Withdrawal returned' : item.type === 'FUNDING' ? 'Money added' : item.type === 'PROMOTIONAL' ? 'Welcome credit' : item.type === 'REVERSAL' ? 'Payment reversed' : 'Balance adjustment';
    const sign = credit ? '+' : debit || withdrawal ? '−' : '';
    return `<button class="transaction-row" data-action="transaction" data-reference="${escape(item.reference)}"><span class="transaction-icon ${conversion || withdrawal ? 'blue' : 'green'}">${icon(conversion ? 'exchange' : withdrawal ? 'bank' : 'down')}</span><span class="transaction-label"><strong>${title}</strong><small>${readableDate(item.valueTime)}</small></span><span class="transaction-amount"><strong>${amount ? `${sign}${escape(amountVisible(amount.amount, amount.currency, amount.minorUnit))}` : '—'}</strong><small class="status-${item.status.toLowerCase()}">${stateLabel(item.status)}</small></span>${icon('chevron')}</button>`;
  }).join('')}</div>`;
}

function walletsPage() {
  return `${pageHeading('A home for every currency.', 'Know what you have. Make space for what’s next.', `<div class="heading-actions">${button(`${icon('bank')} Withdraw`, 'withdraw', 'secondary')}${button(`${icon('plus')} Fund my wallet`, 'fund')}</div>`)}${walletCards()}<section class="wallet-explanation"><span class="square-icon">${icon('wallet')}</span><h2>One account. More possibilities.</h2><p>Add naira to get started. When you exchange into a new currency, we’ll open its wallet for you automatically.</p><button class="button primary" data-route="/exchange">Explore an exchange ${icon('arrow')}</button></section><section class="activity-card"><div class="section-heading"><h2>Recent wallet activity</h2><a href="/activity" data-route="/activity">View all ${icon('arrow')}</a></div>${transactionList(items.slice(0, 3))}</section>`;
}

function exchangePage() {
  const currencies = [...new Set(rates?.pairs.flatMap((pair) => [pair.from, pair.to]) || ['NGN', 'USD', 'EUR', 'GBP'])];
  const currencyOptions = (selected) => currencies.map((currency) => `<option value="${currency}" ${currency === selected ? 'selected' : ''}>${currency} · ${names[currency] || currency}</option>`).join('');
  return `${pageHeading('A change of currency. A new possibility.', 'See your rate. Know what you’ll get. You’re in control.')}<div class="exchange-layout"><section class="exchange-card"><div class="section-heading"><h2>Make your exchange</h2><span class="subtle-badge">${preview ? 'Sample rates' : 'Review before you confirm'}</span></div><form data-form="exchange" id="exchange-form"><div class="form-error" role="alert" hidden></div><label class="amount-label">You exchange<div class="exchange-input"><input name="amount" inputmode="decimal" placeholder="0.00" value="10000" autocomplete="off" required aria-label="Amount to exchange"><select name="from" aria-label="Currency to exchange">${currencyOptions('NGN')}</select></div></label><div class="available-line" id="exchange-available"></div><div class="swap-divider"><button type="button" class="swap-button" data-action="swap" aria-label="Swap currencies">${icon('exchange')}</button></div><label class="amount-label">You receive <span class="hint">estimated</span><div class="exchange-input receive"><output id="exchange-estimate">—</output><select name="to" aria-label="Currency to receive">${currencyOptions('USD')}</select></div></label><div class="exchange-rate-line" id="exchange-rate"></div><p class="exchange-disclosure">The rate includes our exchange margin. Your final amounts are shown before you confirm.</p><button class="button primary wide" type="submit" ${!rates || rates.stale || loading ? 'disabled' : ''}>Review exchange ${icon('arrow')}</button>${rates?.stale ? '<p class="form-error">Rates are being refreshed. Please try again shortly.</p>' : !rates ? `<p class="form-error">${escape(rateError || 'Loading rates…')}</p>${button('Refresh rates', 'refresh', 'text')}` : ''}</form>${attribution()}</section><aside class="exchange-aside"><span class="eyebrow">A LITTLE CLARITY GOES A LONG WAY</span><h2>Know your next move.<br><em>Before you make it.</em></h2>${[['eye', 'Nothing left to guess', 'Review exactly what leaves one wallet and arrives in the other.'], ['clock', 'A moment to decide', 'Your quote is held for 30 seconds. Need more time? Get a fresh one.'], ['shield', 'Always your choice', 'Your money only moves when you confirm the exchange.']].map(([symbol, title, text]) => `<div class="explain-row"><span class="square-icon">${icon(symbol)}</span><div><h3>${title}</h3><p>${text}</p></div></div>`).join('')}<div class="exchange-decoration" aria-hidden="true">${flag('NGN')}<span>↔</span>${flag('USD')}</div></aside></div>`;
}

function activityPage() {
  const filtered = items.filter((item) => `${item.type} ${item.status} ${item.reference} ${item.legs.map((leg) => leg.currency).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  return `${pageHeading('Every move, in one place.', 'A clear view of where your money has been.', button(`${icon('arrow')} Refresh`, 'history-refresh', 'secondary'))}<section class="activity-card full-activity"><div class="activity-toolbar"><div class="tabs" role="group" aria-label="Activity type">${[['', 'All moves'], ['FUNDING', 'Money added'], ['CONVERSION', 'Exchanges'], ['WITHDRAWAL', 'Withdrawals']].map(([value, label]) => `<button class="${filter === value ? 'selected' : ''}" data-action="filter" data-filter="${value}" aria-pressed="${filter === value}">${label}</button>`).join('')}</div><input class="search-input" type="search" name="search" placeholder="Search this page" aria-label="Search loaded activity" value="${escape(search)}"></div><div id="activity-results">${!filtered.length && items.length ? '<div class="empty-state"><h3>No matching moves.</h3><p>Try a different currency or search term.</p></div>' : transactionList(filtered)}</div>${cursor ? `<div class="load-more">${button('Show more moves', 'more', 'secondary')}</div>` : ''}</section>`;
}

function accountPage() {
  return `${pageHeading('Your own little space.', 'The essentials, all in one place.')}<section class="profile-card"><div class="profile-top"><span class="avatar large">${escape(firstName()[0])}</span><div><h2>${escape(firstName())}</h2><p>${escape(user()?.email)}</p></div><span class="subtle-badge green">${icon('check')} ${preview ? 'Sample account' : 'Email verified'}</span></div><dl class="detail-list"><div><dt>Email address</dt><dd>${escape(user()?.email)}</dd></div><div><dt>Account status</dt><dd>${preview ? 'Preview' : 'Active'}</dd></div><div><dt>Session</dt><dd>This browser tab</dd></div></dl><p class="muted">${preview ? 'This is a sample profile. Create your own account to start your journey.' : 'For your privacy, logging out clears your session from this browser tab.'}</p>${button(preview ? 'Create my account' : 'Log out securely', preview ? 'signup' : 'logout', 'secondary')}</section>`;
}

function helpPage() {
  return `${pageHeading('A little guidance, whenever you need it.', 'You don’t need to be a money expert to feel at home here.')}<div class="help-grid">${[['01', 'Start with your email', 'Create your account, then enter the six-digit code from your email. That’s your wallet ready to go.', 'Create an account', 'signup'], ['02', 'Add a little money', 'Choose an amount in naira. Paystack opens a secure payment page, then we check that your money has arrived.', 'Fund my wallet', 'fund'], ['03', 'Explore another currency', 'Choose what to exchange and review your quote. Confirm within 30 seconds, or get a fresh quote when you’re ready.', 'Try an exchange', 'exchange']].map(([number, title, text, label, action]) => `<article class="help-card"><span class="step-number">${number}</span><h2>${title}</h2><p>${text}</p>${button(`${label} ${icon('arrow')}`, action, 'text')}</article>`).join('')}</div><section class="faq-section"><h2>A few things you might be wondering.</h2>${[['My payment says “in progress”. What now?', 'Sometimes a payment takes a moment to confirm. Check its progress from your overview or Activity. Don’t make another payment for the same request. If it stays pending, keep your payment reference and contact the person helping you try KoboFX.'], ['What happens if I close the payment page?', 'Your wallet only changes after payment is confirmed. Reopen KoboFX in this same browser tab and choose Check payment to see the latest status.'], ['Why did my exchange quote expire?', 'Rates can change. Each quote is held for 30 seconds so you can review it. If it expires, request a new quote and check the amounts again.'], ['Is the preview real money?', 'No. Preview mode is a separate sample wallet with illustrative rates. Adding or exchanging sample money never sends a payment request.'], ['How do withdrawals work?', 'Add a Nigerian bank account first: we check its name with your bank. Then choose Withdraw, enter the amount, tap Send code and enter the 6-digit code we email you. Each code works once, for 10 minutes. In this test version no real bank receives money: confirmed withdrawals land in your simulated bank, which you can see on the Withdraw page.']].map(([question, answer]) => `<details><summary>${question}${icon('plus')}</summary><p>${answer}</p></details>`).join('')}</section>`;
}

function withdrawPage() {
  const ngn = balances.find((balance) => balance.currency === 'NGN');
  const ready = (beneficiaries || []).filter((beneficiary) => beneficiary.status === 'READY');
  const wait = Math.ceil((codeCooldownUntil - Date.now()) / 1000);
  const form = !beneficiaries
    ? `<div class="inline-empty">${escape(beneficiaryError || 'Finding your bank accounts…')}${beneficiaryError ? button('Try again', 'withdraw-refresh', 'text') : ''}</div>`
    : !ready.length
      ? `<div class="empty-state">${icon('bank')}<h3>Add a bank account first.</h3><p>We check the account name with your bank before you can send money to it.</p>${button(`${icon('plus')} Add a bank account`, 'add-beneficiary', 'secondary')}</div>`
      : `<form data-form="withdraw" id="withdraw-form" novalidate><div class="form-error" role="alert" hidden></div>
        <label>Send to<select name="beneficiaryId" class="plain-select" required>${ready.map((beneficiary) => `<option value="${escape(beneficiary.beneficiaryId)}">${escape(beneficiary.accountName || '')} · ${escape(beneficiary.bankName || beneficiary.bankCode)} ${escape(beneficiary.accountNumberMasked)}</option>`).join('')}</select></label>
        <label>Amount<div class="fund-input"><span>₦</span><input name="amount" inputmode="decimal" placeholder="0.00" autocomplete="off" required aria-label="Amount to withdraw in naira"><span>NGN</span></div></label>
        <div class="available-line">Available: ${money(ngn?.available || '0', 'NGN')}</div>
        <label for="withdrawal-code" class="code-label">Withdrawal code</label>
        <div class="code-row"><input id="withdrawal-code" class="code-input" name="oneTimePassword" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="000000" required aria-describedby="code-help"><button type="button" class="button secondary" id="code-button" data-action="withdraw-code" ${wait > 0 ? 'disabled' : ''}>${wait > 0 ? `Resend in ${wait}s` : 'Send code'}</button></div>
        <small id="code-help" class="muted code-help">Tap “Send code” and we’ll email a 6-digit code to ${escape(maskEmail(user()?.email))}. It works once, for 10 minutes.</small>
        <button class="button primary wide" type="submit">Withdraw ${icon('arrow')}</button>
        <p class="secure-note">${icon('lock')} Test mode: no real bank receives money. Confirmed withdrawals land in your simulated bank.</p></form>`;
  return `${pageHeading('Send money to your bank.', 'Choose an account, enter the amount, and confirm with the code we email you.')}<div class="exchange-layout"><section class="exchange-card"><div class="section-heading"><h2>Withdraw naira</h2><span class="subtle-badge">${preview ? 'Sample withdrawal' : 'Protected by an emailed code'}</span></div>${form}</section><aside class="withdraw-aside">${bankAccountsCard()}${stashCard()}</aside></div>`;
}

function beneficiaryStatus(beneficiary) {
  if (beneficiary.status === 'READY') return ['completed', 'Ready'];
  if (beneficiary.status === 'FAILED') return ['failed', 'Couldn’t verify'];
  return ['pending', beneficiary.reviewRequired ? 'Being reviewed' : 'Verifying'];
}

function bankAccountsCard() {
  const list = !beneficiaries ? '<div class="list-skeleton"><span></span></div>' : !beneficiaries.length ? '<p class="muted">No bank accounts yet.</p>'
    : `<ul class="side-list">${beneficiaries.map((beneficiary) => { const [style, label] = beneficiaryStatus(beneficiary); return `<li><span class="square-icon">${icon('bank')}</span><span class="side-list-label"><strong>${escape(beneficiary.accountName || 'Checking the name…')}</strong><small>${escape(beneficiary.bankName || beneficiary.bankCode)} · ${escape(beneficiary.accountNumberMasked)}</small></span><span class="status-pill status-${style}">${label}</span></li>`; }).join('')}</ul>`;
  return `<section class="side-card"><div class="section-heading"><h2>My bank accounts</h2>${button(`${icon('plus')} Add`, 'add-beneficiary', 'text')}</div>${list}</section>`;
}

function stashCard() {
  const amount = stash?.balances.find((balance) => balance.currency === 'NGN');
  const receipts = stashItems.length ? `<ul class="side-list">${stashItems.map((receipt) => `<li><span class="side-list-label"><strong>${receipt.direction === 'IN' ? 'Received' : 'Returned to your wallet'}</strong><small>${readableDate(receipt.recordedAt)} · ${escape(receipt.destination.bankName)} ${escape(receipt.destination.accountNumberMasked)}</small></span><strong>${receipt.direction === 'IN' ? '+' : '−'}${escape(money(receipt.amount, receipt.currency, receipt.minorUnit))}</strong></li>`).join('')}</ul>` : '<p class="muted">Your confirmed withdrawals will appear here.</p>';
  return `<section class="side-card"><div class="section-heading"><h2>Your simulated bank</h2><span class="subtle-badge">Test mode</span></div><p class="muted">Where your withdrawals land. It isn’t part of your wallet and can’t be spent here.</p><strong class="stash-balance">${stash ? escape(money(amount?.amount || '0', 'NGN', amount?.minorUnit)) : stashError ? '—' : '…'}</strong>${receipts}</section>`;
}

function startCodeCooldown(seconds) {
  codeCooldownUntil = Date.now() + seconds * 1000; clearInterval(codeTimer);
  const tick = () => {
    const left = Math.ceil((codeCooldownUntil - Date.now()) / 1000); const target = document.querySelector('#code-button');
    if (left <= 0) { clearInterval(codeTimer); if (target) { target.disabled = false; target.textContent = 'Resend code'; } return; }
    if (target) { target.disabled = true; target.textContent = `Resend in ${left}s`; }
  };
  tick(); codeTimer = setInterval(tick, 1000);
}

async function loadBanks() {
  if (bankCache) return bankCache;
  const banks = []; let next = null;
  for (let page = 0; page < 20; page += 1) {
    const result = await request(`/wallet/withdrawal-banks?${new URLSearchParams({ currency: 'NGN', limit: '100', ...(next ? { cursor: next } : {}) })}`);
    banks.push(...result.items); next = result.nextCursor; if (!next) break;
  }
  bankCache = banks.sort((left, right) => left.bankName.localeCompare(right.bankName));
  return bankCache;
}

async function openAddBeneficiary() {
  if (!user()) { navigate('/signup'); return; }
  modal = 'beneficiary';
  showModal('Add a bank account.', `<p class="dialog-intro">We’ll check the account name with your bank. Nigerian (NUBAN) accounts only, in naira.</p><form data-form="beneficiary"><div class="form-error" role="alert" hidden></div><label>Bank<select name="bankCode" class="plain-select" required disabled><option value="">Loading banks…</option></select></label><label>Account number<input name="accountNumber" inputmode="numeric" pattern="[0-9]{10}" maxlength="10" placeholder="0123456789" autocomplete="off" required></label><button class="button primary wide" type="submit">Verify this account ${icon('arrow')}</button><p class="secure-note">${icon('lock')} Only the last four digits are ever shown back to you.</p></form>`);
  const select = document.querySelector('dialog [name="bankCode"]');
  try {
    const banks = await loadBanks(); if (!select?.isConnected) return;
    select.innerHTML = `<option value="">Choose your bank</option>${banks.map((bank) => `<option value="${escape(bank.bankCode)}">${escape(bank.bankName)}</option>`).join('')}`; select.disabled = false;
  } catch (error) { if (select?.isConnected) formError(select.form, error); }
}

async function pollBeneficiary(beneficiaryId) {
  const generation = ++pollGeneration;
  showModal('Checking with your bank.', `<div class="payment-progress"><span class="progress-orb">${icon('bank')}</span><p>We’re confirming the account name with your bank. This usually takes a few seconds.</p></div><div class="form-error" role="alert" hidden></div><div class="progress-line"><span></span></div>`);
  const poll = async () => {
    if (generation !== pollGeneration) return;
    try {
      const beneficiary = await request(`/wallet/withdrawal-beneficiaries/${encodeURIComponent(beneficiaryId)}`);
      if (generation !== pollGeneration) return;
      if (beneficiary.status === 'READY') {
        pollGeneration++; loadWithdrawals();
        showModal('Your bank account is ready.', `<div class="success-body"><span class="success-orb">${icon('check')}</span><span class="success-label">Verified by your bank</span><p><strong>${escape(beneficiary.accountName)}</strong><br>${escape(beneficiary.bankName)} · ${escape(beneficiary.accountNumberMasked)}</p></div><p class="muted">Check the name is yours before you withdraw.</p>${button(`Withdraw to this account ${icon('arrow')}`, 'withdraw-here', 'primary wide')}`); return;
      }
      if (beneficiary.status === 'FAILED') {
        pollGeneration++; loadWithdrawals();
        showModal('We couldn’t verify that account.', `<p class="dialog-intro">${beneficiary.failureCode === 'ACCOUNT_NOT_RESOLVED' ? 'Your bank didn’t recognise that account number. Check the number and the bank, then try again.' : 'This account couldn’t be set up for withdrawals. Please try again or use another account.'}</p>${button('Try another account', 'add-beneficiary', 'primary wide')}`); return;
      }
      setTimeout(poll, 3000);
    } catch (error) {
      if (generation !== pollGeneration) return;
      const notice = document.querySelector('dialog .form-error'); if (notice) { notice.textContent = `${error.message} We’ll keep checking.`; notice.hidden = false; }
      setTimeout(poll, 5000);
    }
  };
  await poll();
}

function showWithdrawalProgress(operation) {
  modal = 'withdrawal';
  showModal('On its way to your bank.', `<div class="payment-progress"><span class="progress-orb">${icon('clock')}</span><strong>${money(operation.amount, operation.currency)}</strong><p>Your money is set aside while Paystack sends it. It only leaves your wallet once Paystack confirms the transfer.</p></div><div class="form-error" role="alert" hidden></div><div class="progress-line"><span></span></div><p class="secure-note">You can close this window and check again from your overview.</p>`);
  pollWithdrawal(operation);
}

async function pollWithdrawal(operation) {
  const generation = ++pollGeneration;
  const finish = () => { pollGeneration++; sessionStorage.removeItem('kobofx.withdrawal'); loadData(); loadWithdrawals(); };
  const poll = async () => {
    if (generation !== pollGeneration) return;
    try {
      const result = await request(`/wallet/withdraw/${encodeURIComponent(operation.withdrawalId)}`);
      if (generation !== pollGeneration) return;
      const destination = `${result.destination.bankName} ${result.destination.accountNumberMasked}`;
      if (result.status === 'COMPLETED') { finish(); successModal('Sent to your bank.', `${money(result.amount, result.currency)} arrived at ${destination} (your simulated bank).`, 'Withdrawal complete', 'bank'); return; }
      if (result.status === 'FAILED') { finish(); showModal('This withdrawal didn’t go through.', `<p class="dialog-intro">Paystack couldn’t complete it, so nothing left your wallet: the money set aside is available again.</p>${button('Back to my wallet', 'done', 'primary wide')}`); return; }
      if (result.status === 'REVERSED') { finish(); showModal('Your bank returned this withdrawal.', `<p class="dialog-intro">${money(result.amount, result.currency)} is back in your wallet.</p>${button('Back to my wallet', 'done', 'primary wide')}`); return; }
      if (result.reviewRequired) {
        const notice = document.querySelector('dialog .form-error'); if (notice) { notice.textContent = 'This withdrawal needs a quick check by our team. Your money stays set aside meanwhile; there’s no need to try again.'; notice.hidden = false; }
      }
      setTimeout(poll, 4000);
    } catch (error) {
      if (generation !== pollGeneration) return;
      const notice = document.querySelector('dialog .form-error'); if (notice) { notice.textContent = `${error.message} You can check this withdrawal again.`; notice.hidden = false; }
    }
  };
  await poll();
}

function render() {
  document.title = 'KoboFX — Your money. More possibilities.';
  if (['/signup', '/login', '/verify'].includes(view)) root.innerHTML = authPage();
  else if (!user() || view === '/') root.innerHTML = landing();
  else root.innerHTML = dashboardShell();
  if (view === '/exchange') updateEstimate();
}

function updateEstimate() {
  const form = document.querySelector('#exchange-form'); if (!form) return;
  const data = new FormData(form); const from = data.get('from'), to = data.get('to');
  const pair = rates?.pairs.find((entry) => entry.from === from && entry.to === to);
  const balance = balances.find((entry) => entry.currency === from);
  document.querySelector('#exchange-available').textContent = `Available: ${money(balance?.available || '0', from)}${pair ? ` · Minimum ${money(pair.minimumSourceAmount, from)}` : ''}`;
  document.querySelector('#exchange-rate').textContent = pair ? `1 ${from} = ${pair.clientRate} ${to}` : 'Choose two different supported currencies.';
  try { document.querySelector('#exchange-estimate').textContent = pair ? decimalAmount(estimateTarget(toMinor(data.get('amount'), scaleOf(from, balances)), pair.clientRate, scaleOf(from, balances), scaleOf(to, balances)), scaleOf(to, balances)) : '—'; } catch { document.querySelector('#exchange-estimate').textContent = '—'; }
}

function showModal(title, content) {
  lastFocus = document.activeElement;
  document.querySelector('#modal-root').innerHTML = `<dialog aria-labelledby="dialog-title"><div class="dialog-header"><span class="eyebrow">YOUR NEXT MOVE</span><button class="icon-button" data-action="close" aria-label="Close dialog">${icon('close')}</button></div><h2 id="dialog-title">${title}</h2>${content}</dialog>`;
  const dialog = document.querySelector('dialog'); dialog.showModal();
  dialog.addEventListener('cancel', () => { modal = null; pollGeneration++; });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeModal(); } });
}
function closeModal() { document.querySelector('dialog')?.close(); document.querySelector('#modal-root').innerHTML = ''; modal = null; pollGeneration++; lastFocus?.focus?.(); }
function formError(form, error) { const element = form.querySelector('.form-error'); if (element) { element.textContent = error.message || error; element.hidden = false; } }
async function submitting(form, action) {
  const submit = form.querySelector('[type="submit"]'); if (submit.disabled) return;
  submit.disabled = true; submit.setAttribute('aria-busy', 'true'); const label = submit.innerHTML; submit.textContent = 'Just a moment…';
  form.querySelector('.form-error')?.setAttribute('hidden', '');
  try { await action(); } catch (error) { formError(form, error); }
  finally { if (submit.isConnected) { submit.innerHTML = label; submit.disabled = false; submit.removeAttribute('aria-busy'); } }
}

function openFunding() {
  if (!user()) { navigate('/signup'); return; }
  const pending = !preview && getStored('funding'); modal = 'funding';
  if (pending?.fundingId) { showFundingProgress(pending); return; }
  showModal('A little more in your wallet.', `<p class="dialog-intro">${preview ? 'Add sample money and explore what comes next.' : 'Choose an amount and complete your payment securely.'}</p><form data-form="fund"><div class="form-error" role="alert" hidden></div><label>Amount to add<div class="fund-input"><span>₦</span><input name="amount" inputmode="decimal" placeholder="0.00" ${pending ? `value="${decimalAmount(pending.body.amount, scaleOf('NGN', balances))}" readonly` : 'value="5000"'} required aria-label="Amount to add in naira"><span>NGN</span></div></label>${pending ? '<p class="muted">We’ll retry your original request safely. You won’t create a second payment.</p>' : `<div class="amount-pills">${['5000', '10000', '25000', '50000'].map((amount) => `<button type="button" data-action="amount" data-amount="${amount}">₦${amount.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}</button>`).join('')}</div>`}<div class="payment-method"><span class="square-icon">${icon('wallet')}</span><div><strong>${preview ? 'Sample payment' : 'Pay online'}</strong><small>${preview ? 'No card or real payment needed' : 'Complete payment on a secure checkout page'}</small></div>${icon('check')}</div><button class="button primary wide" type="submit">${preview ? 'Add sample money' : pending ? 'Retry safely' : 'Continue to payment'} ${icon('arrow')}</button><p class="secure-note">${icon('lock')} ${preview ? 'This only changes your sample wallet.' : 'Your card details stays secured.'}</p></form>`);
}

function showFundingProgress(operation, funding) {
  modal = 'funding';
  const ready = funding?.checkout && Date.parse(funding.checkout.expiresAt) > Date.now();
  showModal(ready ? 'Your payment page is ready.' : 'A little patience. We’re on it.', `<div class="payment-progress"><span class="progress-orb">${icon(ready ? 'wallet' : 'clock')}</span><strong>${money(operation.body.amount, operation.body.currency)}</strong><p>${ready ? 'Open the secure checkout below. After payment, we’ll bring you back to check your wallet.' : 'We’re checking your payment. Your balance changes only when it’s confirmed.'}</p></div><div class="form-error" role="alert" hidden></div>${ready ? button(`Continue to Paystack ${icon('diagonal')}`, 'checkout', 'primary wide') : '<div class="progress-line"><span></span></div>'}<p class="secure-note">You can close this window and check again from your overview.</p><button class="button secondary wide" data-action="funding-check">Check payment status</button>`);
  if (ready) modal = { type: 'funding', checkout: funding.checkout.authorizationUrl };
  pollFunding(operation);
}

async function pollFunding(operation) {
  const generation = ++pollGeneration;
  const poll = async () => {
    if (generation !== pollGeneration) return;
    try {
      const result = await request(`/wallet/fund/${encodeURIComponent(operation.fundingId)}`);
      if (generation !== pollGeneration) return;
      if (result.status === 'COMPLETED') {
        sessionStorage.removeItem('kobofx.funding'); pollGeneration++;
        successModal('A little more possibility.', `${money(result.amount, result.currency)} is now in your wallet.`, 'Money added', 'wallet'); loadData(); return;
      }
      if (['FAILED', 'REVERSED'].includes(result.status)) {
        pollGeneration++; sessionStorage.removeItem('kobofx.funding');
        showModal(result.status === 'REVERSED' ? 'This payment was reversed.' : 'This payment didn’t go through.', `<p class="dialog-intro">${result.status === 'REVERSED' ? 'The payment was returned. Check your activity for the balance change.' : 'This payment wasn’t credited to your wallet. You can try a new payment when you’re ready.'}</p>${button('Back to my wallet', 'done', 'primary wide')}`); loadData(); return;
      }
      if (result.failureCode?.startsWith('HELD:')) {
        pollGeneration++;
        showModal('Your payment needs a closer look.', `<p class="dialog-intro">We received a payment update that needs review. Please keep this reference and contact the person helping you try KoboFX. Don’t pay again for this request.</p><div class="reference-box">${escape(operation.fundingId)}</div>${button('Back to my wallet', 'done', 'primary wide')}`); return;
      }
      if (result.checkout && Date.parse(result.checkout.expiresAt) > Date.now() && !modal?.checkout) { showFundingProgress(operation, result); return; }
      setTimeout(poll, 4000);
    } catch (error) {
      if (generation !== pollGeneration) return;
      const notice = document.querySelector('dialog .form-error'); if (notice) { notice.textContent = `${error.message} You can check this same payment again.`; notice.hidden = false; }
    }
  };
  await poll();
}

function successModal(title, description, label = 'Completed', symbol = 'check') {
  modal = 'success';
  showModal(title, `<div class="success-body"><span class="success-orb">${icon(symbol)}</span><span class="success-label">${label}</span><p>${escape(description)}</p></div>${button(`Back to my overview ${icon('arrow')}`, 'done', 'primary wide')}`);
}

function reviewQuote(result) {
  quote = result; modal = 'quote';
  showModal('Let’s take one last look.', `<p class="dialog-intro">A clear picture of your next move.</p><div class="quote-summary"><div><span>You exchange</span><strong>${money(quote.sourceAmount, quote.from)}</strong>${flag(quote.from)}</div><span class="quote-arrow">${icon('down')}</span><div><span>You receive</span><strong>${money(quote.targetAmount, quote.to)}</strong>${flag(quote.to)}</div></div><dl class="detail-list"><div><dt>Exchange rate</dt><dd>1 ${quote.from} = ${escape(quote.clientRate)} ${quote.to}</dd></div><div><dt>Exchange margin</dt><dd>Included in your rate</dd></div><div><dt>Time to decide</dt><dd id="quote-countdown"></dd></div></dl><form data-form="trade"><div class="form-error" role="alert" hidden></div><button id="confirm-trade" class="button primary wide" type="submit">Confirm exchange ${icon('arrow')}</button></form><button class="button text wide" data-action="close">A little more time</button>`);
  updateQuoteClock();
}
function updateQuoteClock() {
  const countdown = document.querySelector('#quote-countdown'); if (!countdown || !quote) return;
  const seconds = Math.max(0, Math.ceil((Date.parse(quote.expiresAt) - Date.now()) / 1000));
  countdown.textContent = seconds ? `${seconds} seconds` : 'Quote expired';
  if (!seconds && !tradeAttempt) {
    const form = document.querySelector('[data-form="trade"]');
    form.innerHTML = '<p class="muted">No money moved. Get a fresh quote when you’re ready.</p>' + button('Get a fresh quote', 'new-quote', 'primary wide');
  } else if (seconds) setTimeout(updateQuoteClock, 250);
}

async function showTransaction(reference) {
  try {
    const item = await request(`/transactions/${encodeURIComponent(reference)}`);
    modal = 'transaction';
    showModal('The details of your move.', `<span class="status-pill status-${escape(item.status.toLowerCase())}">${stateLabel(item.status)}</span><div class="receipt-legs">${(item.legs.length ? item.legs : item.requested ? [item.requested] : []).map((leg) => `<div>${flag(leg.currency)}<span>${leg.direction === 'DEBIT' ? 'From your wallet' : leg.direction === 'CREDIT' ? 'To your wallet' : item.type === 'WITHDRAWAL' ? 'Set aside for this withdrawal' : 'Requested'}</span><strong>${money(leg.amount, leg.currency, leg.minorUnit)}</strong></div>`).join('')}</div><dl class="detail-list"><div><dt>Date</dt><dd>${readableDate(item.valueTime)}</dd></div><div><dt>Type</dt><dd>${item.type === 'CONVERSION' ? 'Currency exchange' : item.type === 'FUNDING' ? 'Money added' : item.type === 'WITHDRAWAL' ? 'Withdrawal to bank' : reference.startsWith('withdrawal-reversal:') ? 'Withdrawal returned' : 'Balance update'}</dd></div>${item.failureCode ? `<div><dt>Reason</dt><dd>${escape(item.failureCode)}</dd></div>` : ''}</dl><span class="field-caption">Reference</span><div class="reference-box">${escape(reference)}</div>${item.status === 'PENDING' && reference.startsWith('funding:') ? button('Check this payment', 'check-history-funding', 'primary wide', `data-reference="${escape(reference)}"`) : ''}${item.status === 'PENDING' && reference.startsWith('withdrawal:') ? button('Check this withdrawal', 'check-history-withdrawal', 'primary wide', `data-reference="${escape(reference)}"`) : ''}${button('All done', 'close', 'secondary wide')}`);
  } catch (error) { toast(error.message); }
}

document.addEventListener('submit', (event) => {
  const form = event.target; if (!form.dataset.form) return; event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  submitting(form, async () => {
    if (form.dataset.form === 'auth') {
      if (view === '/signup') {
        await api('/auth/register', { method: 'POST', body: { email: values.email, password: values.password }, anonymous: true });
        pendingRegistration = { email: values.email, password: values.password }; navigate('/verify');
      } else {
        const result = await api(view === '/verify' ? '/auth/verify' : '/auth/login', { method: 'POST', body: view === '/verify' ? { ...(pendingRegistration || { email: values.email, password: values.password }), oneTimePassword: values.code } : values, anonymous: true });
        pendingRegistration = null; preview = null; sessionStorage.removeItem('kobofx.preview'); setSession(result);
        navigate('/home'); await loadData();
        if (getStored('funding')) openFunding();
      }
    } else if (form.dataset.form === 'fund') {
      const operation = (!preview && getStored('funding')) || { key: crypto.randomUUID(), body: { amount: toMinor(values.amount, scaleOf('NGN', balances)), currency: 'NGN' } };
      if (!preview) sessionStorage.setItem('kobofx.funding', JSON.stringify(operation));
      let result;
      try { result = await request('/wallet/fund/paystack', { method: 'POST', body: operation.body, key: operation.key }); }
      catch (error) {
        if (error.status && error.status < 500 && ![408, 429].includes(error.status) && error.code !== 'REQUEST_IN_PROGRESS') {
          sessionStorage.removeItem('kobofx.funding');
          form.querySelector('[name="amount"]').readOnly = false;
        }
        throw error;
      }
      if (preview) { successModal('A little more possibility.', `${money(result.amount, result.currency)} in sample money is now in your wallet.`, 'Sample money added'); loadData(); }
      else { operation.fundingId = result.fundingId; sessionStorage.setItem('kobofx.funding', JSON.stringify(operation)); showFundingProgress(operation); }
    } else if (form.dataset.form === 'beneficiary') {
      if (!/^\d{10}$/.test(values.accountNumber || '')) throw new Error('Enter the 10-digit account number.');
      if (!values.bankCode) throw new Error('Choose your bank.');
      const result = await request('/wallet/withdrawal-beneficiaries', { method: 'POST', body: { bankCode: values.bankCode, accountNumber: values.accountNumber, currency: 'NGN' }, key: crypto.randomUUID() });
      if (result.status === 'READY') { loadWithdrawals(); closeModal(); toast('That account is already ready to use.'); return; }
      await pollBeneficiary(result.beneficiaryId);
    } else if (form.dataset.form === 'withdraw') {
      if (!values.beneficiaryId) throw new Error('Choose the bank account to send to.');
      let amount;
      try { amount = toMinor(values.amount, scaleOf('NGN', balances)); } catch { throw new Error('Enter an amount, like 5000 or 5000.50.'); }
      if (BigInt(amount) <= 0n) throw new Error('Enter an amount above zero.');
      if (!preview && BigInt(amount) > BigInt(balances.find((balance) => balance.currency === 'NGN')?.available || '0')) throw new Error('That’s more than your available naira. Enter a smaller amount.');
      if (!/^\d{6}$/.test(values.oneTimePassword || '')) throw new Error('Enter the 6-digit code from your email. Tap “Send code” if you don’t have one yet.');
      const body = { beneficiaryId: values.beneficiaryId, amount, currency: 'NGN', oneTimePassword: values.oneTimePassword };
      // Retrying the very same request (e.g. after a network error) reuses its key; anything else is a new withdrawal.
      if (!withdrawAttempt || JSON.stringify(withdrawAttempt.body) !== JSON.stringify(body)) withdrawAttempt = { key: crypto.randomUUID(), body };
      let result;
      try { result = await request('/wallet/withdraw/paystack', { method: 'POST', body, key: withdrawAttempt.key }); }
      catch (error) {
        if (error.status && error.status < 500 && ![408, 429].includes(error.status) && error.code !== 'REQUEST_IN_PROGRESS') withdrawAttempt = null;
        if (error.code === 'WITHDRAWAL_CODE_INVALID') { const field = form.querySelector('[name="oneTimePassword"]'); field.value = ''; field.focus(); }
        throw error;
      }
      withdrawAttempt = null;
      const operation = { withdrawalId: result.withdrawalId, amount: result.amount, currency: result.currency };
      form.reset();
      if (preview) { successModal('Sent to your bank.', `${money(result.amount, result.currency)} in sample money went to your sample bank.`, 'Sample withdrawal complete', 'bank'); loadData(); loadWithdrawals(); }
      else { sessionStorage.setItem('kobofx.withdrawal', JSON.stringify(operation)); showWithdrawalProgress(operation); loadData(); }
    } else if (form.dataset.form === 'exchange') {
      const stored = !preview && getStored('trade');
      if (stored) { tradeAttempt = stored; quote = stored.quote; reviewQuote(quote); toast('Please check your previous exchange before starting another.'); return; }
      const sourceAmount = toMinor(values.amount, scaleOf(values.from, balances));
      if (values.from === values.to) throw new Error('Choose a different currency to receive.');
      if (BigInt(sourceAmount) > BigInt(balances.find((balance) => balance.currency === values.from)?.available || '0')) throw new Error('Add money or enter a smaller amount to make this exchange.');
      tradeAttempt = null;
      const result = await request('/fx/quotes', { method: 'POST', body: { from: values.from, to: values.to, sourceAmount }, key: crypto.randomUUID() });
      reviewQuote(result);
    } else if (form.dataset.form === 'trade') {
      if (!tradeAttempt && Date.parse(quote.expiresAt) <= Date.now()) throw new Error('This quote has expired. Get a fresh quote.');
      tradeAttempt ||= { key: crypto.randomUUID(), quote };
      if (!preview) sessionStorage.setItem('kobofx.trade', JSON.stringify(tradeAttempt));
      try {
        await request('/wallet/trade', { method: 'POST', body: { quoteId: tradeAttempt.quote.quoteId }, key: tradeAttempt.key });
      } catch (error) {
        if (error.status && error.status < 500 && ![408, 429].includes(error.status) && error.code !== 'REQUEST_IN_PROGRESS') { sessionStorage.removeItem('kobofx.trade'); tradeAttempt = null; setTimeout(updateQuoteClock, 0); }
        throw error;
      }
      sessionStorage.removeItem('kobofx.trade'); tradeAttempt = null;
      successModal('A new currency. All yours.', `${money(quote.targetAmount, quote.to)} ${preview ? 'in sample money ' : ''}has arrived in your ${names[quote.to] || quote.to} wallet.`, preview ? 'Sample exchange complete' : 'Exchange complete'); loadData();
    }
  });
});

document.addEventListener('click', async (event) => {
  const link = event.target.closest('[data-route]');
  if (link) { event.preventDefault(); navigate(link.dataset.route); return; }
  const target = event.target.closest('[data-action]'); if (!target) return;
  const action = target.dataset.action;
  try {
    if (action === 'login' || action === 'signup') { preview = null; sessionStorage.removeItem('kobofx.preview'); navigate(`/${action}`); }
    else if (action === 'preview') { preview = createPreview(); sessionStorage.setItem('kobofx.preview', 'true'); navigate('/home'); loadData(); }
    else if (action === 'fund') openFunding();
    else if (action === 'exchange') navigate('/exchange');
    else if (action === 'withdraw') { closeModal(); navigate('/withdraw'); }
    else if (action === 'withdraw-refresh') loadWithdrawals();
    else if (action === 'add-beneficiary') await openAddBeneficiary();
    else if (action === 'withdraw-here') { closeModal(); navigate('/withdraw'); }
    else if (action === 'withdraw-code') {
      target.disabled = true;
      try {
        await request('/wallet/withdraw/one-time-password', { method: 'POST' });
        startCodeCooldown(60);
        toast(preview ? 'Preview: any 6 digits will do.' : `We’ve emailed a 6-digit code to ${maskEmail(user()?.email)}. It works for 10 minutes.`);
        document.querySelector('[name="oneTimePassword"]')?.focus();
      } catch (error) { if (error.code === 'RATE_LIMITED') startCodeCooldown(60); else target.disabled = false; throw error; }
    }
    else if (action === 'withdrawal-check') { const operation = getStored('withdrawal'); if (operation?.withdrawalId) showWithdrawalProgress(operation); }
    else if (action === 'check-history-withdrawal') {
      const withdrawalId = target.dataset.reference.slice('withdrawal:'.length);
      const withdrawal = await request(`/wallet/withdraw/${encodeURIComponent(withdrawalId)}`);
      showWithdrawalProgress({ withdrawalId, amount: withdrawal.amount, currency: withdrawal.currency });
    }
    else if (action === 'close') closeModal();
    else if (action === 'done') { closeModal(); navigate('/home'); }
    else if (action === 'refresh') loadData();
    else if (action === 'history-refresh') loadHistory();
    else if (action === 'more') { target.disabled = true; await loadHistory(true); if (target.isConnected) target.disabled = false; }
    else if (action === 'filter') { filter = target.dataset.filter; search = ''; await loadHistory(); }
    else if (action === 'balance-visibility') { hiddenBalance = !hiddenBalance; render(); }
    else if (action === 'password') { const field = target.parentElement.querySelector('input'); field.type = field.type === 'password' ? 'text' : 'password'; target.setAttribute('aria-label', field.type === 'password' ? 'Show password' : 'Hide password'); }
    else if (action === 'amount') document.querySelector('dialog [name="amount"]').value = target.dataset.amount;
    else if (action === 'swap') { const from = document.querySelector('[name="from"]'), to = document.querySelector('[name="to"]'); [from.value, to.value] = [to.value, from.value]; updateEstimate(); }
    else if (action === 'transaction') await showTransaction(target.dataset.reference);
    else if (action === 'funding-check') { const operation = getStored('funding'); if (operation?.fundingId) showFundingProgress(operation); }
    else if (action === 'checkout') {
      const checkout = new URL(modal.checkout);
      if (!['https:', 'http:'].includes(checkout.protocol) || (checkout.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(checkout.hostname))) throw new Error('This payment link is unavailable. Please check your payment again.');
      location.assign(checkout.href);
    } else if (action === 'check-history-funding') {
      const fundingId = target.dataset.reference.slice('funding:'.length);
      const funding = await request(`/wallet/fund/${encodeURIComponent(fundingId)}`);
      const operation = { fundingId, body: { amount: funding.amount, currency: funding.currency } };
      sessionStorage.setItem('kobofx.funding', JSON.stringify(operation)); showFundingProgress(operation, funding);
    } else if (action === 'new-quote') { closeModal(); document.querySelector('#exchange-form')?.requestSubmit(); }
    else if (action === 'wallet-detail') {
      const currency = target.dataset.currency; const balance = balances.find((entry) => entry.currency === currency);
      showModal(`Your ${names[currency] || currency} wallet.`, `<div class="wallet-detail">${flag(currency)}<strong>${money(balance?.available || '0', currency)}</strong><span>Available to you</span></div><dl class="detail-list"><div><dt>Total balance</dt><dd>${money(balance?.total || '0', currency)}</dd></div><div><dt>In use by pending moves</dt><dd>${money(balance?.reserved || '0', currency)}</dd></div></dl>${button(currency === 'NGN' ? 'Add money' : 'Exchange into this wallet', currency === 'NGN' ? 'fund' : 'exchange', 'primary wide')}${currency === 'NGN' ? button(`${icon('bank')} Withdraw to my bank`, 'withdraw', 'secondary wide') : ''}`);
    } else if (action === 'resend') {
      const email = pendingRegistration?.email || document.querySelector('[name="email"]')?.value;
      if (!email) throw new Error('Enter your email address first.');
      target.disabled = true;
      try { await api('/auth/resend-otp', { method: 'POST', body: { email }, anonymous: true }); toast('If your email is awaiting verification, a fresh code is on its way.'); } finally { setTimeout(() => { if (target.isConnected) target.disabled = false; }, 60000); }
    } else if (action === 'logout') {
      if (preview) { preview = null; sessionStorage.removeItem('kobofx.preview'); }
      else { try { await api('/auth/logout', { method: 'POST' }); } catch { toast('Signed out of this tab. The wallet service could not confirm session revocation.'); } setSession(null); }
      balances = []; rates = null; items = []; navigate('/');
    }
  } catch (error) { toast(error.message); }
});
document.addEventListener('input', (event) => {
  if (event.target.closest('#exchange-form')) updateEstimate();
  if (event.target.name === 'search') {
    search = event.target.value; const position = event.target.selectionStart; render();
    const field = document.querySelector('[name="search"]'); field.focus(); try { field.setSelectionRange(position, position); } catch {}
  }
});
document.addEventListener('change', (event) => { if (event.target.closest('#exchange-form')) updateEstimate(); });
window.addEventListener('popstate', () => { closeModal(); view = location.pathname; render(); });
window.addEventListener('session-ended', () => { navigate('/login'); toast('Your session has ended. Please sign in again.'); });

if (new URLSearchParams(location.search).get('preview') === '1') { preview = createPreview(); sessionStorage.setItem('kobofx.preview', 'true'); view = '/home'; history.replaceState({}, '', view); }
if (view === '/funding/return') {
  // A reference in the callback query is untrusted. Resume only our stored, user-scoped request.
  const operation = getStored('funding'); view = user() ? '/home' : '/login'; history.replaceState({}, '', view); render();
  if (user()) { loadData(); if (operation?.fundingId) showFundingProgress(operation); else toast('Check Activity for the latest payment status.'); }
} else { if (view === '/' && user()) { view = '/home'; history.replaceState({}, '', view); } render(); if (user()) { loadData(); if (view === '/withdraw') loadWithdrawals(); } }
