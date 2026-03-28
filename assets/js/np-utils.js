/**
 * NexusPay — Shared Frontend Utilities
 * Included on every page after config.js
 */

// ─── API Client ────────────────────────────────────────────────────────────
const VP = {
  /** Base API URL from config */
  get baseUrl() {
    return (window.NEXUSPAY_API_URL || '').replace(/\/$/, '');
  },

  /** Get stored auth token */
  get token() {
    return localStorage.getItem('vp_jwt');
  },

  /** Store auth token */
  set token(t) {
    if (t) localStorage.setItem('vp_jwt', t);
    else localStorage.removeItem('vp_jwt');
  },

  /** Get stored merchant info */
  get merchant() {
    try { return JSON.parse(localStorage.getItem('vp_merchant') || 'null'); }
    catch { return null; }
  },

  /** Store merchant info */
  set merchant(m) {
    if (m) localStorage.setItem('vp_merchant', JSON.stringify(m));
    else localStorage.removeItem('vp_merchant');
  },

  /** Test API key (from localStorage after login) */
  get testKey() { return localStorage.getItem('vp_test_key') || ''; },
  set testKey(k) { if (k) localStorage.setItem('vp_test_key', k); },

  /** Check if logged in */
  get isLoggedIn() {
    return !!(this.token && this.merchant);
  },

  /** Clear session and redirect to login */
  logout() {
    localStorage.clear(); // Clear all keys
    window.location.href = (window.location.pathname.includes('/dashboard/') ? '../' : './') + 'login.html';
  },

  /** Redirect to login if not authenticated */
  requireAuth() {
    if (!this.isLoggedIn) {
      window.location.href = (window.location.pathname.match(/\/(dashboard|pay)\//) ? '../' : './') + 'login.html?redirect=' + encodeURIComponent(window.location.pathname + window.location.search);
      return false;
    }
    return true;
  },

  /** Generic fetch with auth header */
  async request(method, path, body = null, useApiKey = false) {
    if (!this.baseUrl || this.baseUrl.includes('your-backend')) {
      throw new Error('API URL not configured. Edit frontend/config.js with your backend URL.');
    }
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (useApiKey) {
      headers['X-NexusPay-Key'] = this.testKey;
    } else if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    const opts = { method: method.toUpperCase(), headers };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);

    const res = await fetch(`${this.baseUrl}${path}`, opts);
    const data = await res.json();

    if (!data.success) {
      const err = new Error(data.error?.message || `HTTP ${res.status}`);
      err.code = data.error?.code || 'API_ERROR';
      err.status = res.status;
      err.details = data.error?.details || null;
      throw err;
    }
    return data.data;
  },

  get:    (path)        => VP.request('GET',    path, null,  false),
  post:   (path, body)  => VP.request('POST',   path, body,  false),
  put:    (path, body)  => VP.request('PUT',    path, body,  false),
  delete: (path)        => VP.request('DELETE', path, null,  false),
  apiGet:  (path)       => VP.request('GET',    path, null,  true),
  apiPost: (path, body) => VP.request('POST',   path, body,  true),

  /** Log out */
  logout() {
    localStorage.clear();
    window.location.href = (window.location.pathname.match(/\/(dashboard|pay)\//) ? '../' : './') + 'login.html';
  },
};

// ─── UI Helpers ────────────────────────────────────────────────────────────
const UI = {
  /** Show inline alert */
  alert(selector, type, msg) {
    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!el) return;
    el.className = `np-alert np-alert-${type}`;
    el.textContent = msg;
    el.style.display = 'block';
    if (type === 'success') setTimeout(() => { el.style.display = 'none'; }, 4000);
  },

  /** Dismiss alert */
  clearAlert(selector) {
    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (el) el.style.display = 'none';
  },

  /** Set button loading state */
  setLoading(btn, loading, originalText) {
    if (typeof btn === 'string') btn = document.querySelector(btn);
    if (!btn) return;
    if (loading) {
      btn.disabled = true;
      btn.dataset.originalText = btn.textContent;
      btn.textContent = originalText || 'Loading...';
    } else {
      btn.disabled = false;
      btn.textContent = btn.dataset.originalText || 'Submit';
    }
  },

  /** Format amount from paise to currency string */
  formatAmount(paise, currency = 'INR') {
    const symbols = { INR: '₹', USD: '$', EUR: '€', GBP: '£', AED: 'د.إ' };
    const multipliers = { INR: 100, USD: 100, EUR: 100, GBP: 100, AED: 100 };
    const symbol = symbols[currency] || currency + ' ';
    const amount = (paise / (multipliers[currency] || 100)).toFixed(2);
    return `${symbol}${parseFloat(amount).toLocaleString('en-IN')}`;
  },

  /** Format date */
  formatDate(isoString) {
    if (!isoString) return '—';
    return new Date(isoString).toLocaleString('en-IN', {
      dateStyle: 'medium', timeStyle: 'short',
    });
  },

  /** Status badge HTML */
  statusBadge(status) {
    const map = {
      captured: ['#d1fae5', '#065f46', '✓ Captured'],
      created:  ['#fef3c7', '#92400e', '⏳ Pending'],
      failed:   ['#fee2e2', '#991b1b', '✗ Failed'],
      refunded: ['#f3f4f6', '#374151', '↩ Refunded'],
      expired:  ['#f3f4f6', '#6b7280', '⊘ Expired'],
      active:   ['#d1fae5', '#065f46', '● Active'],
      suspended:['#fee2e2', '#991b1b', '● Suspended'],
    };
    const [bg, color, label] = map[status] || ['#f3f4f6', '#374151', status];
    return `<span style="background:${bg};color:${color};padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;">${label}</span>`;
  },

  /** Copy to clipboard with toast */
  async copy(text, label = 'Copied!') {
    try {
      await navigator.clipboard.writeText(text);
      this.toast(label);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      this.toast(label);
    }
  },

  /** Toast notification */
  toast(message, duration = 2500) {
    const el = document.createElement('div');
    el.className = 'np-toast';
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('np-toast-show'), 10);
    setTimeout(() => {
      el.classList.remove('np-toast-show');
      setTimeout(() => el.remove(), 300);
    }, duration);
  },

  /** Render empty state */
  empty(msg = 'No data yet') {
    return `<div style="text-align:center;padding:48px 20px;color:#9ca3af;">
      <div style="font-size:36px;margin-bottom:12px;">📭</div>
      <p style="font-size:14px;">${msg}</p>
    </div>`;
  },
};

// ─── Shared CSS injected at runtime ───────────────────────────────────────
(function injectSharedStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .np-alert{padding:12px 16px;border-radius:10px;font-size:14px;font-weight:600;display:none;margin-bottom:16px;}
    .np-alert-success{background:#d1fae5;color:#065f46;border:1px solid #a7f3d0;}
    .np-alert-error{background:#fee2e2;color:#991b1b;border:1px solid #fecaca;}
    .np-alert-warning{background:#fef3c7;color:#92400e;border:1px solid #fde68a;}
    .np-alert-info{background:#dbeafe;color:#1e40af;border:1px solid #bfdbfe;}
    .np-toast{position:fixed;bottom:24px;right:24px;background:#1f2937;color:#f9fafb;padding:12px 20px;border-radius:10px;font-size:14px;font-weight:600;z-index:9999;opacity:0;transform:translateY(8px);transition:all 0.25s;box-shadow:0 8px 24px rgba(0,0,0,0.3);}
    .np-toast-show{opacity:1;transform:translateY(0);}
    .np-spinner{display:inline-block;width:18px;height:18px;border:2.5px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:np-spin 0.7s linear infinite;}
    @keyframes np-spin{to{transform:rotate(360deg);}}
  `;
  document.head.appendChild(style);
})();
