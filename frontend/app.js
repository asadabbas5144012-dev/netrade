/* ═══════════════════════════════════════
    NEOTRADE — Full App Logic
═══════════════════════════════════════ */

// ── CUID → 8-digit numeric ID (deterministic, unique per user) ──
function toNumericId(cuid) {
    let h = 5381;
    for (let i = 0; i < cuid.length; i++) {
        h = ((h << 5) + h) ^ cuid.charCodeAt(i);
        h = h >>> 0; // keep unsigned 32-bit
    }
    return String(h % 90000000 + 10000000); // always 8 digits
}

// ── NAV STACK ──
const navStack = [];
let currentScreen = 'home-screen';

const PROTECTED_SCREENS = ['home-screen', 'markets-screen', 'futures-screen', 'perpetual-screen', 'assets-screen', 'deposit-screen', 'withdrawal-screen', 'transaction-screen', 'share-screen', 'notifications-screen', 'referrals-screen', 'exchange-screen', 'fund-transfer-screen', 'withdrawal-record-screen', 'basic-verification-screen', 'deposit-record-screen', 'change-password-screen', 'bind-address-screen', 'withdrawal-password-screen', 'google-auth-screen', 'more-screen', 'settings-screen', 'convert-screen', 'transfer-record-screen', 'perp-chart-screen'];

window.addEventListener('popstate', () => {
    const p = window.location.pathname;
    if (p === '/login') _showScreen('login-screen');
    else if (p === '/signup' || p === '/register') _showScreen('register-screen');
});

// Pops navStack and shows the previous screen, without pushing a new
// entry (unlike navTo). Returns false if there is nowhere to go back to.
function navBack() {
    if (navStack.length === 0) return false;
    const prev = navStack.pop();
    _showScreen(prev);
    const navScreens = ['home-screen', 'markets-screen', 'futures-screen', 'perpetual-screen', 'assets-screen'];
    if (navScreens.includes(prev)) {
        const idx = navScreens.indexOf(prev);
        document.querySelectorAll('.pql-nav-btn, .nav-btn').forEach((b, i) => b.classList.toggle('active', i === idx));
    }
    return true;
}

// The embedded Android WebView has no download manager, so tapping a plain
// <a download> link inside the app silently does nothing. When running
// natively, hand the APK URL off to the system browser instead — it can
// actually save the file.
function downloadAndroidApk(ev) {
    if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
        if (ev) ev.preventDefault();
            const url = window.location.origin + '/netrontrade.apk';
        const CapBrowser = window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
        if (CapBrowser) CapBrowser.open({ url });
        else window.open(url, '_system');
        return false;
    }
    return true; // regular browser — let the <a download> handle it natively
}

// ── APP UPDATE CHECK (native Android only) ──
async function checkForAppUpdate() {
    if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) return;
    const CapAppInfo = window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!CapAppInfo) return;
    try {
        const [info, settings] = await Promise.all([
            CapAppInfo.getInfo(),
            fetch('/api/public/settings').then(r => r.json())
        ]);
        const latest = (settings.app_version || '').trim();
        const installed = (info.version || '').trim();
        if (!latest || !installed || latest === installed) return;
        if (localStorage.getItem('dismissedUpdateVersion') === latest) return;
        window._pendingApkUrl = settings.apk_download_url || (window.location.origin + '/netrontrade.apk');
        const overlay = document.getElementById('app-update-overlay');
        if (overlay) overlay.style.display = 'flex';
    } catch (e) { /* silent — never block app usage over a failed version check */ }
}

function dismissAppUpdate() {
    const overlay = document.getElementById('app-update-overlay');
    if (overlay) overlay.style.display = 'none';
    fetch('/api/public/settings').then(r => r.json()).then(s => {
        if (s.app_version) localStorage.setItem('dismissedUpdateVersion', s.app_version.trim());
    }).catch(() => {});
}

function downloadAppUpdate() {
    const overlay = document.getElementById('app-update-overlay');
    if (overlay) overlay.style.display = 'none';
    const url = window._pendingApkUrl || (window.location.origin + '/netrontrade.apk');
    const CapBrowser = window.Capacitor.Plugins && window.Capacitor.Plugins.Browser;
    if (CapBrowser) CapBrowser.open({ url });
    else window.open(url, '_system');
}

// ── HARDWARE BACK BUTTON (Android) ──
// Capacitor injects window.Capacitor even when the app loads a remote
// server.url, so this works despite the app not bundling its own frontend.
(function () {
    if (!window.Capacitor || !window.Capacitor.isNativePlatform || !window.Capacitor.isNativePlatform()) return;
    const CapApp = window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!CapApp) return;
    let lastBackPress = 0;
    CapApp.addListener('backButton', () => {
        // Close the topmost visible modal/overlay first, if any.
        const overlays = document.querySelectorAll('[id$="-overlay"], [id$="-modal"]');
        for (const el of overlays) {
            if (el.offsetParent !== null) { el.style.display = 'none'; return; }
        }
        if (navBack()) return;
        // Nowhere left to go back to — require a second press to exit.
        const now = Date.now();
        if (now - lastBackPress < 2000) { CapApp.exitApp(); }
        else { lastBackPress = now; showToast('Press back again to exit'); }
    });
})();

function navTo(screenId) {
    if (PROTECTED_SCREENS.includes(screenId) && !authToken) { _showScreen('login-screen'); return; }
    if (screenId === currentScreen) return;
    navStack.push(currentScreen);
    _showScreen(screenId);
    if (screenId === 'login-screen') history.pushState({ screen: 'login-screen' }, '', '/login');
    else if (screenId === 'register-screen') history.pushState({ screen: 'register-screen' }, '', '/signup');
    else if (['/login', '/signup'].includes(window.location.pathname)) history.pushState({ screen: screenId }, '', '/');
    const navScreens = ['home-screen', 'markets-screen', 'futures-screen', 'perpetual-screen', 'assets-screen'];
    if (navScreens.includes(screenId)) {
        const idx = navScreens.indexOf(screenId);
        document.querySelectorAll('.pql-nav-btn, .nav-btn').forEach((b, i) => b.classList.toggle('active', i === idx));
    }
    // Refresh data on important screen changes
    if (['assets-screen', 'futures-screen', 'perpetual-screen', 'exchange-screen'].includes(screenId)) {
        refreshUserData();
    }
    // Screen-specific loading
    if (screenId === 'transaction-screen') loadTransactions();
    if (screenId === 'google-auth-screen') loadGoogleAuthSetup();
    if (screenId === 'bind-address-screen') loadBindAddressScreen();
    if (screenId === 'deposit-screen') loadDepositInfo();
    if (screenId === 'notifications-screen') fetchNotifications();
    if (screenId === 'withdrawal-record-screen') loadWithdrawalRecords();
    if (screenId === 'deposit-record-screen') loadDepositRecords();
    if (screenId === 'withdrawal-screen') loadWithdrawalScreen();
    if (screenId === 'futures-screen') {
        if (!apexChart) {
            const sym = currentPair.replace(/[\\s\/]/g, '').replace('USDTUSDT', 'USDT').replace(/\s+/g, '').toUpperCase();
            const activeTf = document.querySelector('#futures-timeframes button.active');
            initChart(sym.endsWith('USDT') ? sym : sym + 'USDT', activeTf ? (activeTf.dataset.tf || activeTf.textContent.toLowerCase()) : '1m');
        }
        renderActivePositions();
        loadTradeHistory();
    }
    if (screenId === 'perpetual-screen') {
        startPerpOrderBookLoop();
    } else {
        stopPerpOrderBookLoop();
    }
    if (screenId === 'perp-chart-screen') {
        var pSym = (window._currentPerpPair || 'BTC/USDT').replace(/[\\s\/]/g, '').replace('USDTUSDT', 'USDT').replace(/\s+/g, '').toUpperCase();
        var activeTf = document.querySelector('#perp-chart-timeframes button.active');
        initPerpDetailChart(pSym, activeTf ? activeTf.dataset.tf || '1h' : '1h');
    }
    if (screenId === 'share-screen') loadShareScreen();
    if (screenId === 'referral-screen') loadReferralScreen();
    if (screenId === 'rules-screen') loadRulesScreen();
    if (screenId === 'convert-screen') loadConvertRates();
    if (screenId === 'fund-transfer-screen') updateTransferAvail();
    if (screenId === 'about-screen') loadAboutScreen();
    if (screenId === 'support-screen') loadSupportScreen();
}

function switchTab(screenId, btnEl) {
    if (PROTECTED_SCREENS.includes(screenId) && !authToken) { _showScreen('login-screen'); return; }
    navStack.length = 0;
    _showScreen(screenId);
    document.querySelectorAll('.pql-nav-btn, .nav-btn').forEach(b => b.classList.remove('active'));
    if (btnEl && btnEl.classList && (btnEl.classList.contains('pql-nav-btn') || btnEl.classList.contains('nav-btn'))) btnEl.classList.add('active');
    const app = document.getElementById('app');
    if (app) app.scrollTop = 0;
    if (['assets-screen', 'futures-screen', 'perpetual-screen', 'exchange-screen'].includes(screenId)) {
        refreshUserData();
    }
    if (screenId === 'futures-screen') {
        if (!apexChart) {
            const sym = currentPair.replace(/[\\s\/]/g, '').replace('USDTUSDT', 'USDT').replace(/\s+/g, '').toUpperCase();
            initChart(sym.endsWith('USDT') ? sym : sym + 'USDT', '1m');
        }
        renderActivePositions();
        loadTradeHistory();
    }
    if (screenId === 'perpetual-screen') {
        startPerpOrderBookLoop();
    } else {
        stopPerpOrderBookLoop();
    }
}

function _showScreen(screenId) {
    // Safely close sidebar - never let this block screen switching
    try { closeSidebar(); } catch (e) { console.error('closeSidebar error:', e); }

    // Hide ALL screens first
    document.querySelectorAll('.screen').forEach(function (s) {
        s.classList.remove('active');
        s.style.display = 'none';
    });

    // Show the target screen
    var target = document.getElementById(screenId);
    if (target) {
        target.classList.add('active');
        target.style.display = 'block';
        currentScreen = screenId;
    } else {
        console.error('Screen not found:', screenId);
    }

    // Hide bottom nav on auth screens
    const authScreens = ['login-screen','register-screen','forgot-password-screen'];
    const nav = document.getElementById('pql-bottom-nav');
    if (nav) nav.style.display = authScreens.includes(screenId) ? 'none' : 'flex';

    // Hide bottom nav for login/register
    var bNav = document.querySelector('.bottom-nav');
    if (bNav) {
        bNav.style.display = (screenId === 'login-screen' || screenId === 'register-screen') ? 'none' : 'flex';
    }

    // Scroll to top
    try {
        var app = document.getElementById('app');
        if (app) app.scrollTop = 0;
        window.scrollTo(0, 0);
    } catch (e) { }
}

// ── SIDEBAR ──
function openSidebar() {
    // Sidebar removed — navigate to Personal Center
    switchTab('assets-screen', document.querySelectorAll('.pql-nav-btn')[4]);
}
function closeSidebar() { /* no-op */ }
function toggleSecurityMenu(el) {
    const sub = document.getElementById('security-submenu');
    const icon = el.querySelector('.expand-icon');
    const isOpen = sub.style.display === 'block';
    sub.style.display = isOpen ? 'none' : 'block';
    if (icon) icon.classList.toggle('rotated', !isOpen);
}

// ── THEME TOGGLE ──
// The app ships a single dark theme; any stored light preference is ignored.
let isDark = true;
try { localStorage.removeItem('theme'); } catch (e) { }

function _applyTheme() {
    document.documentElement.classList.remove('light-preload');
    const icon = document.getElementById('theme-icon');
    const thumb = document.getElementById('theme-thumb');
    if (isDark) {
        document.body.classList.remove('light-mode');
        if (icon) { icon.className = 'fa-solid fa-moon'; icon.style.color = '#f5b041'; }
        if (thumb) { thumb.style.right = '2px'; thumb.style.left = 'auto'; }
    } else {
        document.body.classList.add('light-mode');
        if (icon) { icon.className = 'fa-solid fa-sun'; icon.style.color = '#f39c12'; }
        if (thumb) { thumb.style.left = '2px'; thumb.style.right = 'auto'; }
    }
}

function toggleTheme() {
    isDark = true;
    _applyTheme();
}

// Apply saved theme immediately
_applyTheme();

// ── TOAST ──
let _toastHideTimer = null;
function showToast(msg, duration = 2600) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    // Without clearing the previous timer, a fast second call (e.g. two
    // quick actions) got its hide cancelled early by the first toast's
    // still-pending timeout, making the second toast flicker/disappear
    // before its own duration was up.
    if (_toastHideTimer) clearTimeout(_toastHideTimer);
    toast.textContent = msg;
    toast.classList.remove('show');
    void toast.offsetWidth;
    toast.classList.add('show');
    _toastHideTimer = setTimeout(() => toast.classList.remove('show'), duration);
}

// ── COPY ──
function copyText(text) {
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => showToast('Copied!')).catch(() => showToast('Copied!'));
    } else {
        showToast('Copied!');
    }
}

function copyDepositAddress() {
    const addr = document.getElementById('dep-addr')?.textContent?.trim();
    if (addr && addr !== '—') copyText(addr);
}

// ── BANNER SLIDER ──
let slideIndex = 0, slideTimer;
function showSlide(n) {
    const slides = document.querySelectorAll('#bannerSlider .slide');
    const dots = document.querySelectorAll('#bannerSlider .dot');
    if (!slides.length) return;
    if (n >= slides.length) slideIndex = 0;
    if (n < 0) slideIndex = slides.length - 1;
    slides.forEach(s => s.classList.remove('active'));
    dots.forEach(d => d.classList.remove('active'));
    slides[slideIndex].classList.add('active');
    if (dots[slideIndex]) dots[slideIndex].classList.add('active');
}
function currentSlide(n) {
    clearInterval(slideTimer); slideIndex = n; showSlide(n); startSlider();
}
function startSlider() {
    slideTimer = setInterval(() => { slideIndex++; showSlide(slideIndex); }, 5000);
}

// ── COUNTDOWN ──
let countdown = 60;
function updateCountdown() {
    countdown--;
    if (countdown < 0) { countdown = 60; updateTimePeriod(); }
    const el = document.getElementById('countdown-timer');
    if (el) {
        el.textContent = countdown + ' s';
        el.style.color = countdown <= 10 ? 'var(--down-color)' : 'var(--up-color)';
    }
}
function updateTimePeriod() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const y = now.getFullYear(), mo = pad(now.getMonth() + 1), d = pad(now.getDate());
    const h = pad(now.getHours()), m = pad(now.getMinutes()), mn = pad(now.getMinutes() + 1 > 59 ? 0 : now.getMinutes() + 1);
    const dlEl = document.getElementById('order-deadline');
    const tpEl = document.getElementById('time-period');
    if (dlEl) dlEl.textContent = `${y}/${mo}/${d} ${h}:${m}:00`;
    if (tpEl) tpEl.textContent = `${h}:${m}~${h}:${mn}`;
}

// ── HOME MARKET TABS ──
function setMarketTab(btn, tab) {
    document.querySelectorAll('.market-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderHomeMarkets(tab);
}

function renderHomeMarkets(tab = 'change') {
    const list = document.getElementById('home-market-items');
    if (!list) return;
    let sorted = [...allCoins];
    if (tab === 'turnover') {
        sorted = sorted.sort((a, b) => parseFloat(b.price.replace(/,/g, '')) - parseFloat(a.price.replace(/,/g, '')));
    } else if (tab === 'losers') {
        sorted = sorted.sort((a, b) => (parseFloat(a.ch) || 0) - (parseFloat(b.ch) || 0));
    } else {
        sorted = sorted.sort((a, b) => Math.abs(parseFloat(b.ch) || 0) - Math.abs(parseFloat(a.ch) || 0));
    }
    list.innerHTML = sorted.map(c => `
        <div class="market-item" onclick="openTradingPair('${c.sym}')" style="cursor:pointer; display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-radius:0; margin-bottom:0;">
            <div style="flex:1.5; display:flex; align-items:center; gap:10px;">
                ${coinIconHtml(c.sym, c.bg, 36)}
                <div style="display:flex;flex-direction:column;gap:2px;">
                    <span style="font-weight:700; color:#f5f1e8; font-size:14px; line-height:1;">${c.sym}</span>
                    <span style="color:#9ca3af; font-size:11px; line-height:1;">/ USDT</span>
                </div>
            </div>
            <div style="flex:1; text-align:right; color:#f5f1e8; font-size:14px; font-weight:600; letter-spacing:-0.2px;">
                <div id="hm-price-${c.sym}">${c.price}</div>
            </div>
            <div style="flex:1; display:flex; justify-content:flex-end;">
                <div id="hm-chg-${c.sym}" style="background:${c.up ? '#02c076' : '#f84960'}; color:#fff; font-weight:600; padding:6px 10px; border-radius:8px; font-size:12px; text-align:center; min-width:72px; letter-spacing:0.2px;">${c.ch}</div>
            </div>
        </div>`).join('');
}

// ── COIN DATA ──
function coinIconHtml(sym, bg, size) {
    size = size || 34;
    const fs = Math.max(10, Math.floor(size * 0.45));

    let url = 'https://assets.coincap.io/assets/icons/' + sym.toLowerCase() + '@2x.png';

    let fallbackHtml = '<span style="font-size:' + fs + 'px;color:#fff;font-weight:700;z-index:1;">' + sym.charAt(0) + '</span>';
    if (sym === 'XAU') fallbackHtml = '<i class="fa-solid fa-coins" style="color:#fff;font-size:' + fs + 'px;z-index:1;"></i>';
    if (sym === 'XAG') fallbackHtml = '<i class="fa-solid fa-coins" style="color:#fff;font-size:' + fs + 'px;z-index:1;"></i>';
    if (sym === 'XPT') fallbackHtml = '<i class="fa-solid fa-ring" style="color:#fff;font-size:' + fs + 'px;z-index:1;"></i>';
    if (sym === 'XPD') fallbackHtml = '<i class="fa-solid fa-gem" style="color:#fff;font-size:' + fs + 'px;z-index:1;"></i>';

    let isMetal = ['XAU', 'XAG', 'XPT', 'XPD'].includes(sym);
    let imgHtml = isMetal ? '' : '<img src="' + url + '" width="' + size + '" height="' + size + '" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:2;" onerror="this.remove()">';

    return '<div style="width:' + size + 'px;height:' + size + 'px;background:' + bg + ';border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;">' +
        fallbackHtml +
        imgHtml +
        '</div>';
}

const allCoins = [
    { sym: 'BTC', name: 'Bitcoin', bg: '#f7931a', price: '63716.55', ch: '+1.49%', up: true, sp: [63143.10105,63206.8176,63270.53415,63334.2507,63397.96725,63461.6838,63525.40035,63589.1169,63652.83345,63716.55] },
    { sym: 'ETH', name: 'Ethereum', bg: '#627eea', price: '1895.50', ch: '+2.78%', up: true, sp: [1878.4405,1880.336,1882.2315,1884.127,1886.0225,1887.918,1889.8135,1891.709,1893.6045,1895.5] },
    { sym: 'BNB', name: 'BNB', bg: '#f0b90b', price: '590.49', ch: '+2.59%', up: true, sp: [585.17559,585.76608,586.35657,586.94706,587.53755,588.12804,588.71853,589.30902,589.89951,590.49] },
    { sym: 'SOL', name: 'Solana', bg: '#00ffa3', price: '74.000', ch: '+3.09%', up: true, sp: [73.334,73.408,73.482,73.556,73.63,73.704,73.778,73.852,73.926,74.0] },
    { sym: 'XRP', name: 'XRP', bg: '#00aae4', price: '1.088', ch: '+2.69%', up: true, sp: [1.0780098,1.0790976,1.0801854,1.0812732,1.082361,1.0834488,1.0845366,1.0856244,1.0867122,1.0878] },
    { sym: 'DOGE', name: 'Dogecoin', bg: '#c2a633', price: '0.07091', ch: '+2.53%', up: true, sp: [0.07027181,0.07034272,0.07041363,0.07048454,0.07055545,0.07062636,0.07069727,0.07076818,0.07083909,0.07091] },
    { sym: 'ADA', name: 'Cardano', bg: '#0d3ca6', price: '0.18990', ch: '+9.26%', up: true, sp: [0.1881909,0.1883808,0.1885707,0.1887606,0.1889505,0.1891404,0.1893303,0.1895202,0.1897101,0.1899] },
    { sym: 'AVAX', name: 'Avalanche', bg: '#e84142', price: '6.661', ch: '+7.63%', up: true, sp: [6.601051,6.607712,6.614373,6.621034,6.627695,6.634356,6.641017,6.647678,6.654339,6.661] },
    { sym: 'DOT', name: 'Polkadot', bg: '#e6007a', price: '0.79900', ch: '+2.83%', up: true, sp: [0.791809,0.792608,0.793407,0.794206,0.795005,0.795804,0.796603,0.797402,0.798201,0.799] },
    { sym: 'LINK', name: 'Chainlink', bg: '#2a5ada', price: '8.386', ch: '+4.07%', up: true, sp: [8.310526,8.318912,8.327298,8.335684,8.34407,8.352456,8.360842,8.369228,8.377614,8.386] },
    { sym: 'TRX', name: 'TRON', bg: '#ef0027', price: '0.32740', ch: '-0.09%', up: false, sp: [0.3303466,0.3300192,0.3296918,0.3293644,0.329037,0.3287096,0.3283822,0.3280548,0.3277274,0.3274] },
    { sym: 'TON', name: 'Toncoin', bg: '#0088cc', price: '1.600', ch: '+0.95%', up: true, sp: [1.5856,1.5872,1.5888,1.5904,1.592,1.5936,1.5952,1.5968,1.5984,1.6] },
    { sym: 'MATIC', name: 'Polygon', bg: '#8247e5', price: '0.37940', ch: '-0.29%', up: false, sp: [0.3828146,0.3824352,0.3820558,0.3816764,0.381297,0.3809176,0.3805382,0.3801588,0.3797794,0.3794] },
    { sym: 'NEAR', name: 'NEAR Protocol', bg: '#00151a', price: '1.715', ch: '+2.63%', up: true, sp: [1.699565,1.70128,1.702995,1.70471,1.706425,1.70814,1.709855,1.71157,1.713285,1.715] },
    { sym: 'LTC', name: 'Litecoin', bg: '#828282', price: '44.980', ch: '+2.02%', up: true, sp: [44.57518,44.62016,44.66514,44.71012,44.7551,44.80008,44.84506,44.89004,44.93502,44.98] },
    { sym: 'BCH', name: 'Bitcoin Cash', bg: '#8dc351', price: '214.50', ch: '+2.83%', up: true, sp: [212.5695,212.784,212.9985,213.213,213.4275,213.642,213.8565,214.071,214.2855,214.5] },
    { sym: 'UNI', name: 'Uniswap', bg: '#ff007a', price: '4.227', ch: '+4.09%', up: true, sp: [4.188957,4.193184,4.197411,4.201638,4.205865,4.210092,4.214319,4.218546,4.222773,4.227] },
    { sym: 'XLM', name: 'Stellar', bg: '#08b5e5', price: '0.17540', ch: '+2.75%', up: true, sp: [0.1738214,0.1739968,0.1741722,0.1743476,0.174523,0.1746984,0.1748738,0.1750492,0.1752246,0.1754] },
    { sym: 'ICP', name: 'Internet Computer', bg: '#3b00b9', price: '2.092', ch: '+2.60%', up: true, sp: [2.073172,2.075264,2.077356,2.079448,2.08154,2.083632,2.085724,2.087816,2.089908,2.092] },
    { sym: 'APT', name: 'Aptos', bg: '#00d4b1', price: '0.56700', ch: '+2.90%', up: true, sp: [0.561897,0.562464,0.563031,0.563598,0.564165,0.564732,0.565299,0.565866,0.566433,0.567] },
    { sym: 'SHIB', name: 'Shiba Inu', bg: '#ffa409', price: '0.00000494', ch: '+1.86%', up: true, sp: [4.9e-06,4.9e-06,4.91e-06,4.91e-06,4.92e-06,4.92e-06,4.93e-06,4.93e-06,4.94e-06,4.94e-06] },
    { sym: 'PEPE', name: 'Pepe', bg: '#4caf50', price: '0.00000293', ch: '+5.40%', up: true, sp: [2.9e-06,2.91e-06,2.91e-06,2.91e-06,2.92e-06,2.92e-06,2.92e-06,2.92e-06,2.93e-06,2.93e-06] },
    { sym: 'ARB', name: 'Arbitrum', bg: '#28a0f0', price: '0.08160', ch: '+3.69%', up: true, sp: [0.0808656,0.0809472,0.0810288,0.0811104,0.081192,0.0812736,0.0813552,0.0814368,0.0815184,0.0816] },
    { sym: 'OP', name: 'Optimism', bg: '#ff0420', price: '0.08650', ch: '+3.84%', up: true, sp: [0.0857215,0.085808,0.0858945,0.085981,0.0860675,0.086154,0.0862405,0.086327,0.0864135,0.0865] },
    { sym: 'SUI', name: 'Sui', bg: '#4da2ff', price: '0.69430', ch: '+2.69%', up: true, sp: [0.6880513,0.6887456,0.6894399,0.6901342,0.6908285,0.6915228,0.6922171,0.6929114,0.6936057,0.6943] },
    { sym: 'SEI', name: 'Sei', bg: '#9e1f19', price: '0.04146', ch: '+1.20%', up: true, sp: [0.04108686,0.04112832,0.04116978,0.04121124,0.0412527,0.04129416,0.04133562,0.04137708,0.04141854,0.04146] },
    { sym: 'TIA', name: 'Celestia', bg: '#7b2bf9', price: '0.33280', ch: '+3.81%', up: true, sp: [0.3298048,0.3301376,0.3304704,0.3308032,0.331136,0.3314688,0.3318016,0.3321344,0.3324672,0.3328] },
    { sym: 'INJ', name: 'Injective', bg: '#00d2ff', price: '5.112', ch: '+3.82%', up: true, sp: [5.065992,5.071104,5.076216,5.081328,5.08644,5.091552,5.096664,5.101776,5.106888,5.112] },
    { sym: 'RNDR', name: 'Render', bg: '#cc2b5e', price: '7.030', ch: '+2.58%', up: true, sp: [6.96673,6.97376,6.98079,6.98782,6.99485,7.00188,7.00891,7.01594,7.02297,7.03] },
    { sym: 'FET', name: 'Fetch.ai', bg: '#3355ff', price: '0.14250', ch: '+2.44%', up: true, sp: [0.1412175,0.14136,0.1415025,0.141645,0.1417875,0.14193,0.1420725,0.142215,0.1423575,0.1425] },
    { sym: 'STX', name: 'Stacks', bg: '#5546ff', price: '0.14010', ch: '+2.79%', up: true, sp: [0.1388391,0.1389792,0.1391193,0.1392594,0.1393995,0.1395396,0.1396797,0.1398198,0.1399599,0.1401] },
    { sym: 'KAS', name: 'Kaspa', bg: '#70c7ba', price: '0.05000', ch: '+1.50%', up: true, sp: [0.04955,0.0496,0.04965,0.0497,0.04975,0.0498,0.04985,0.0499,0.04995,0.05] },
    { sym: 'ATOM', name: 'Cosmos', bg: '#2e3148', price: '1.269', ch: '+3.51%', up: true, sp: [1.257579,1.258848,1.260117,1.261386,1.262655,1.263924,1.265193,1.266462,1.267731,1.269] },
    { sym: 'XMR', name: 'Monero', bg: '#ff6600', price: '118.70', ch: '+4.77%', up: true, sp: [117.6317,117.7504,117.8691,117.9878,118.1065,118.2252,118.3439,118.4626,118.5813,118.7] },
    { sym: 'ETC', name: 'Ethereum Classic', bg: '#328332', price: '6.650', ch: '+2.46%', up: true, sp: [6.59015,6.5968,6.60345,6.6101,6.61675,6.6234,6.63005,6.6367,6.64335,6.65] }
];

function makeSparkline(coin) {
    const data = coin.sp;
    const isUp = coin.up;
    const w = 100, h = 30;

    // Smooth bounds
    const mx = Math.max(...data), mn = Math.min(...data), rng = mx - mn || 1;
    const pts = data.map((v, i) => { return { x: (i / (data.length - 1)) * w, y: h - ((v - mn) / rng) * (h - 4) - 2 }; });

    let pathD = `M ${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
        pathD += ` L ${pts[i].x},${pts[i].y}`;
    }

    const color = isUp ? '#00c087' : '#f84960';

    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:30px; margin-top: 6px; overflow:visible;">
        <path d="${pathD}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="miter" stroke-linecap="butt" style="filter: drop-shadow(0 0 1px ${color}40);"/>
    </svg>`;
}

function renderMiniTickers() {
    const container = document.getElementById('mini-tickers-container');
    if (!container) return;
    const tickers = [
        allCoins.find(c => c.sym === 'BTC'),
        allCoins.find(c => c.sym === 'ETH'),
        allCoins.find(c => c.sym === 'TRX')
    ].filter(Boolean);

    if (container.children.length === 0) {
        container.innerHTML = tickers.map((c, i) => {
            const color = c.up ? '#00c087' : '#f84960';
            return `
            <div class="ticker" onclick="openTradingPair('${c.sym}')" style="cursor:pointer;flex:1;min-width:100px;padding:10px;text-align:center;${i < tickers.length - 1 ? 'border-right:1px solid var(--border-color);' : ''}">
                <div style="display:flex; justify-content:center; align-items:center; gap:4px; margin-bottom:4px;">
                    <span style="font-size:11px;font-weight:600;color:var(--text-primary);">${c.sym}USDT</span>
                    <span id="tick-badge-${c.sym}" class="change-badge" style="background:${color}; color:#fff; font-size:10px; clip-path: polygon(15% 0, 100% 0, 100% 100%, 15% 100%, 0 50%); padding: 1px 4px 1px 6px; border-radius: 2px;">${c.ch}</span>
                </div>
                <div class="price" id="tick-price-${c.sym}" style="font-size:16px;font-weight:700;color:${color};">${c.price}</div>
                <div id="tick-sp-${c.sym}">${makeSparkline(c)}</div>
            </div>`;
        }).join('');
    } else {
        tickers.forEach(c => {
            const color = c.up ? '#00c087' : '#f84960';

            const badgeEl = document.getElementById(`tick-badge-${c.sym}`);
            if (badgeEl) {
                badgeEl.innerText = c.ch;
                badgeEl.style.background = color;
            }

            const priceEl = document.getElementById(`tick-price-${c.sym}`);
            if (priceEl) {
                priceEl.innerText = c.price;
                priceEl.style.color = color;
            }

            const spContainer = document.getElementById(`tick-sp-${c.sym}`);
            if (spContainer) {
                const pathEl = spContainer.querySelector('path');
                if (pathEl) {
                    const w = 100, h = 30, mx = Math.max(...c.sp), mn = Math.min(...c.sp), rng = mx - mn || 1;
                    const pts = c.sp.map((v, i) => { return { x: (i / (c.sp.length - 1)) * w, y: h - ((v - mn) / rng) * (h - 4) - 2 }; });
                    let pathD = `M ${pts[0].x},${pts[0].y}`;
                    for (let i = 1; i < pts.length; i++) {
                        pathD += ` L ${pts[i].x},${pts[i].y}`;
                    }
                    pathEl.setAttribute('d', pathD);
                    pathEl.setAttribute('stroke', color);
                    pathEl.style.filter = `drop-shadow(0 0 2px ${color}80)`;
                }
            }
        });
    }
}

function openTradingPair(sym) {
    currentPair = sym + '/USDT';
    const coin = allCoins.find(c => c.sym === sym);
    // Update futures header
    const pairName = document.querySelector('#futures-screen .pair-name');
    if (pairName) pairName.textContent = sym + ' / USDT';
    const pairChange = document.querySelector('#futures-screen .pair-change');
    if (pairChange && coin) {
        pairChange.textContent = ' ' + coin.ch;
        pairChange.className = 'pair-change ' + (coin.up ? 'up' : 'down');
    }
    // Update pair icon in header
    const pairIconEl = document.getElementById('futures-pair-icon');
    if (pairIconEl) pairIconEl.innerHTML = coinIconHtml(sym, coin ? coin.bg : '#888', 24);
    // Update live price row
    const livePriceEl = document.getElementById('futures-live-price');
    if (livePriceEl && coin) {
        livePriceEl.textContent = coin.price + ' USDT';
        livePriceEl.className = 'futures-live-price-val ' + (coin.up ? 'up' : 'down');
    }
    const chgEl = document.getElementById('futures-price-chg');
    if (chgEl && coin) { chgEl.textContent = coin.ch; chgEl.className = coin.up ? 'up' : 'down'; }
    // Initialize High / Low / Vol immediately (will be updated live by socket)
    const fHighEl = document.getElementById('futures-price-high');
    const fLowEl = document.getElementById('futures-price-low');
    const fVolEl = document.getElementById('futures-price-vol');
    if (fHighEl) fHighEl.textContent = '--';
    if (fLowEl) fLowEl.textContent = '--';
    if (fVolEl) fVolEl.textContent = '--';
    // Reinit chart
    if (apexChart) { try { apexChart.destroy(); } catch (e) { } apexChart = null; }
    // Open perpetual chart for this coin
    window._currentPerpPair = sym + '/USDT';
    const perpPairNameEls = document.querySelectorAll('#perp-pair-name, #perp-chart-pair-name');
    perpPairNameEls.forEach(el => { el.textContent = sym + ' / USDT Perpetual'; });
    const perpChangeEl = document.getElementById('perp-pair-change');
    if (perpChangeEl && coin) {
        perpChangeEl.textContent = ' ' + coin.ch;
        perpChangeEl.className = 'pair-change ' + (coin.up ? 'up' : 'down');
    }
    const availEl = document.getElementById('perp-avail-amt');
    if (availEl && userData) availEl.textContent = (userData.perpetualBalance || 0).toFixed(2) + ' USDT';
    switchTab('perpetual-screen', document.querySelectorAll('.pql-nav-btn')[2]);
    startPerpOrderBookLoop();
    // Legacy: keep futures-screen pair updated too
    // navTo early-exits when already on futures-screen, so chart stays null — init explicitly
    const activeTf = document.querySelector('#futures-timeframes button.active');
    if (!apexChart) initChart(sym + 'USDT', activeTf ? (activeTf.dataset.tf || activeTf.textContent.toLowerCase()) : '1m');
}

function renderMarkets(filter) {
    const list = document.getElementById('markets-list');
    if (!list) return;
    const q = (filter || '').toLowerCase();
    const data = (q ? allCoins.filter(c => c.sym.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)) : [...allCoins])
        .sort((a, b) => (parseFloat(b.ch) || 0) - (parseFloat(a.ch) || 0));
    list.innerHTML = data.map(c => {
        const rawPrice = parseFloat(c.price.toString().replace(/,/g, '')) || 0;
        const fmtPrice = rawPrice < 0.1 ? rawPrice.toFixed(5) : (rawPrice < 100 ? rawPrice.toFixed(3) : rawPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
        const fakeVol = rawPrice > 1000 ? (Math.random() * 400 + 50).toFixed(2) + 'M' : (Math.random() * 30 + 1).toFixed(2) + 'M';
        return `
        <div class="market-item" onclick="openTradingPair('${c.sym}')" style="cursor:pointer; display:flex; align-items:center; padding:13px 16px; border-bottom:1px solid rgba(214,181,106,0.14); background:#11100e;">
            <div style="flex:1.4; display:flex; align-items:center; gap:10px;">
                ${coinIconHtml(c.sym, c.bg, 36)}
                <div>
                    <div style="font-size:14px; font-weight:700; color:#f5f1e8;">${c.sym}<span style="font-weight:500; color:#9ca3af; font-size:12px;"> / USDT</span></div>
                    <div style="font-size:11px; color:#9ca3af; margin-top:2px;">VOL: ${fakeVol}</div>
                </div>
            </div>
            <div style="flex:1; text-align:right; padding-right:10px;">
                <div style="font-size:14px; font-weight:700; color:#f5f1e8;">$ ${fmtPrice}</div>
            </div>
            <div style="flex:0.8; text-align:right;">
                <span style="display:inline-block; padding:6px 10px; border-radius:8px; font-size:12px; font-weight:700; color:#fff; background:${c.up ? '#02c076' : '#f84960'};">${c.ch}</span>
            </div>
        </div>`;
    }).join('');
}

function filterMarkets(val) { renderMarkets(val); }
function setCatTab(btn) {
    document.querySelectorAll('.cat-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderMarkets(document.getElementById('markets-search-input')?.value || '');
}
function setMktViewTab(btn, view) {
    document.querySelectorAll('.mkt-tab-btn').forEach(b => { b.classList.remove('active'); b.style.fontWeight = '400'; b.style.color = 'var(--text-muted)'; });
    btn.classList.add('active'); btn.style.fontWeight = '700'; btn.style.color = '#fff';

    // In future, this would route to distinct API datasets based on 'view'.
    // For now, re-render to reflect state changes.
    renderMarkets(document.getElementById('markets-search-input')?.value || '');
}
function toggleMktSort() {
    allCoins.sort((a, b) => {
        const chA = parseFloat(a.ch) || 0;
        const chB = parseFloat(b.ch) || 0;
        return chB - chA;
    });
    renderMarkets(document.getElementById('markets-search-input')?.value || '');
}

// ── FUTURES TABS ──
const _fakeNames = ['Adam***', 'Wei***', 'Sara***', 'John***', 'Raj***', 'Liu***', 'Ana***', 'Max***', 'Kim***', 'Zara***'];
const _fakePairsArr = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT'];
let _fakeHistItems = [];
let _fakeHistTimer = null;
let localPositions = [];

function _fakeHistItem() {
    var pair = _fakePairsArr[Math.floor(Math.random() * _fakePairsArr.length)];
    var dir = Math.random() > 0.5 ? 'CALL' : 'PUT';
    var amt = (Math.random() * 900 + 100).toFixed(2);
    var win = Math.random() > 0.44;
    var profit = win ? '+' + (amt * 0.85).toFixed(2) : '-' + amt;
    var secs = Math.floor(Math.random() * 120) + 5;
    return { user: _fakeNames[Math.floor(Math.random() * _fakeNames.length)], pair, dir, amt, win, profit, ago: secs + 's ago' };
}

function renderFakeHistory() {
    var c = document.getElementById('futures-tab-history');
    if (!c) return;
    c.innerHTML = '<div style="padding:0 12px 12px;">' + _fakeHistItems.map(function (it) {
        return '<div class="history-order" style="margin-bottom:8px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
            '<span style="font-size:12px;color:var(--text-secondary);">' + it.user + '</span>' +
            '<span style="font-size:11px;color:var(--text-muted);">' + it.ago + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
            '<span style="font-size:13px;font-weight:600;">' + it.pair.replace('USDT', '/USDT') + '</span>' +
            '<span class="' + (it.dir === 'CALL' ? 'up' : 'down') + '" style="font-weight:600;font-size:12px;">' + it.dir + '</span></div>' +
            '<div class="card-row"><span class="lbl">Entry Price</span><span class="val">' + (t.entryPrice ? Number(t.entryPrice).toFixed(4) : '--') + '</span></div>' +
            '<div class="card-row"><span class="lbl">Amount</span><span class="val">' + it.amt + ' USDT</span></div>' +
            '<div class="card-row"><span class="lbl">P&amp;L</span><span class="val ' + (it.win ? 'up' : 'down') + '">' + it.profit + '</span></div></div>';
    }).join('') + '</div>';
}

function startFakeHistFeed() {
    _fakeHistItems = [];
    for (var i = 0; i < 12; i++) _fakeHistItems.push(_fakeHistItem());
    renderFakeHistory();
    if (_fakeHistTimer) clearInterval(_fakeHistTimer);
    _fakeHistTimer = setInterval(function () {
        _fakeHistItems.unshift(_fakeHistItem());
        if (_fakeHistItems.length > 25) _fakeHistItems.pop();
        renderFakeHistory();
    }, 2500);
}

function renderFakeInvited() {
    var c = document.getElementById('futures-tab-invited');
    if (!c) return;
    c.innerHTML = '<div style="padding:0 12px 12px;">' + _fakeNames.slice(0, 6).map(function (name) {
        var profit = (Math.random() * 6000 + 500).toFixed(2);
        var rate = 54 + Math.floor(Math.random() * 32);
        var trades = 60 + Math.floor(Math.random() * 240);
        return '<div class="history-order" style="margin-bottom:8px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
            '<span style="font-weight:600;font-size:13px;">' + name + '</span>' +
            '<span class="up" style="font-size:12px;">+' + profit + ' USDT</span></div>' +
            '<div class="card-row"><span class="lbl">Win Rate</span><span class="val up">' + rate + '%</span></div>' +
            '<div class="card-row"><span class="lbl">Total Trades</span><span class="val">' + trades + '</span></div></div>';
    }).join('') + '</div>';
}

function renderFakeFollow() {
    var c = document.getElementById('futures-tab-follow');
    if (!c) return;
    c.innerHTML = '<div style="padding:0 12px 12px;">' + _fakeNames.slice(2, 8).map(function (name) {
        var profit = (Math.random() * 4000 + 200).toFixed(2);
        var days = 3 + Math.floor(Math.random() * 60);
        var rate = 58 + Math.floor(Math.random() * 28);
        return '<div class="history-order" style="margin-bottom:8px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
            '<span style="font-weight:600;font-size:13px;">' + name + '</span>' +
            '<span class="up" style="font-size:12px;">+' + profit + ' USDT</span></div>' +
            '<div class="card-row"><span class="lbl">Days Following</span><span class="val">' + days + ' days</span></div>' +
            '<div class="card-row"><span class="lbl">Profit Rate</span><span class="val up">' + rate + '%</span></div></div>';
    }).join('') + '</div>';
}

async function renderActivePositions() {
    var c = document.getElementById('active-positions-list');
    if (!c) return;
    if (!authToken) return;
    try {
        const res = await fetch('/api/signals/my-trades', { headers: { 'Authorization': 'Bearer ' + authToken } });
        if (!res.ok) return;
        const trades = await res.json();
        const pending = trades.filter(function (t) { return t.outcome === 'PENDING'; });
        if (!pending.length) {
            c.innerHTML = '<div class="no-data-block" style="padding:40px 20px;"><i class="fa-solid fa-chart-line" style="font-size:40px;color:var(--text-muted);margin-bottom:12px;"></i><p>No active positions</p></div>';
            return;
        }
        c.innerHTML = '<div style="padding:0 12px 12px;">' + pending.map(function (t) {
            var pair = (t.signal && t.signal.pair) ? t.signal.pair : (t.pair || 'UNKNOWN');
            var dir = (t.signal && t.signal.direction) ? t.signal.direction : (t.direction || '--');
            var dirClass = dir === 'CALL' ? 'up' : 'down';
            var dirIcon = dir === 'CALL' ? '▲' : '▼';
            var date = new Date(t.createdAt).toLocaleTimeString();
            var entryTime = (t.signal && t.signal.entryTime) ? new Date(t.signal.entryTime).getTime() : new Date(t.createdAt).getTime();
            var duration = (t.signal && t.signal.duration) ? t.signal.duration : (t.duration || 600);
            var endTime = entryTime + duration * 1000;
            var remaining = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
            var countdown = remaining > 0 ? fmtCountdown(remaining) : 'CLOSING...';
            var cancelBtn = t.signalId ? '' : '<button onclick="cancelManualTrade\(\'' + t.id + '\'\)" class="btn-secondary" style="font-size:11px;padding:4px 8px;border-radius:4px;margin-left:8px;">Cancel</button>';
            return '<div class="history-order" style="margin-bottom:8px;">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
                '<span style="font-weight:600;font-size:13px;">' + pair + '</span>' +
                '<span class="' + dirClass + '" style="font-weight:600;">' + dirIcon + ' ' + dir + cancelBtn + '</span></div>' +
                '<div class="card-row"><span class="lbl">Entry Price</span><span class="val">' + (t.entryPrice ? Number(t.entryPrice).toFixed(4) : '--') + '</span></div>' +
                '<div class="card-row"><span class="lbl">Amount</span><span class="val">' + t.amount.toFixed(2) + ' USDT</span></div>' +
                '<div class="card-row"><span class="lbl">Open Time</span><span class="val">' + date + '</span></div>' +
                '<div class="card-row"><span class="lbl">Status</span><span class="val" style="color:#f3ba2f;">ACTIVE</span></div>' +
                '<div class="card-row"><span class="lbl">Time Left</span><span class="val up pos-countdown" data-id="' + t.id + '" data-manual="' + (t.signalId ? 'false' : 'true') + '" data-end="' + endTime + '">' + countdown + '</span></div>' +
                '</div>';
        }).join('') + '</div>';
        document.querySelectorAll('.pos-countdown').forEach(function (el) {
            var endTime = parseInt(el.dataset.end);
            if (!endTime) return;
            var t = setInterval(function () {
                var rem = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
                el.textContent = rem > 0 ? fmtCountdown(rem) : 'CLOSING...';
                if (rem <= 0) {
                    clearInterval(t);
                    if (el.dataset.manual === 'true') {
                        resolveManualTrade(el.dataset.id);
                    } else {
                        // Signal trade: Auto-refresh quickly to move to history
                        setTimeout(function () {
                            loadTradeHistory();
                            renderActivePositions();
                            refreshUserData();
                        }, 500);
                    }
                }
            }, 1000);
        });
    } catch (e) { }
}

function addLocalPosition(sym, dir, amount) {
    var entry = apexChartData.length ? apexChartData[apexChartData.length - 1].y[3] : 0;
    var durationMs = (selectedOrderMinutes || 1) * 60000;
    var pos = { id: Date.now(), sym: sym, dir: dir, amount: amount, entry: entry, time: new Date().toLocaleTimeString(), status: 'active', durationMs: durationMs };
    localPositions.push(pos);
    // Switch to position tab to show the user their trade
    var posTabBtn = document.querySelector('#futures-pos-tabs button[onclick*="position"]');
    if (posTabBtn) posTabBtn.click();
    renderActivePositions();
    setTimeout(function () {
        var idx = localPositions.findIndex(function (p) { return p.id === pos.id; });
        if (idx !== -1) localPositions[idx].status = 'settled';
        renderActivePositions();
        showToast('Trade closed: ' + dir + ' ' + sym + ' (' + (selectedOrderMinutes || 1) + 'min)');
    }, durationMs);
}

function setFuturesTab(btn, tab) {
    document.querySelectorAll('#futures-pos-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    ['position', 'history', 'invited', 'follow'].forEach(t => {
        const el = document.getElementById('futures-tab-' + t);
        if (el) el.style.display = t === tab ? 'block' : 'none';
    });
    if (_fakeHistTimer) { clearInterval(_fakeHistTimer); _fakeHistTimer = null; }
    if (tab === 'position') renderActivePositions();
    if (tab === 'history') loadTradeHistory();
    if (tab === 'invited') renderFakeInvited();
    if (tab === 'follow') renderFakeFollow();
}
function setTimeframe(btn, tf) {
    document.querySelectorAll('#futures-timeframes button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const sym = currentPair.replace(/[\\s\/]/g, '').replace('/USDT', '').toUpperCase() + 'USDT';
    initChart(sym.replace('USDTUSDT', 'USDT'), tf || '1m');
}

function setPerpTimeframe(btn, tf) {
    document.querySelectorAll('#perp-timeframes button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    initPerpChart('BTCUSDT', tf || '1h');
}

// ── ORDER PANEL ──
let currentOrderDir = 'CALL';
let selectedOrderMinutes = 1; // default 1-minute expiry

function _getTimeSlots() {
    var now = new Date();
    var slots = [];
    for (var i = 1; i <= 20; i++) {
        var t = new Date(now.getTime() + i * 60000);
        var hh = String(t.getHours()).padStart(2, '0');
        var mm = String(t.getMinutes()).padStart(2, '0');
        slots.push({ label: hh + ':' + mm, mins: i });
    }
    return slots;
}

function renderTimeSlots() {
    var container = document.querySelector('#order-panel .time-selector');
    if (!container) return;

    // Signal mode: show locked expiry time from admin-set duration
    if (activeSignal && activeSignal.duration) {
        var endTime = new Date(activeSignal.entryTime).getTime() + activeSignal.duration * 1000;
        var endDate = new Date(endTime);
        var hh = String(endDate.getHours()).padStart(2, '0');
        var mm = String(endDate.getMinutes()).padStart(2, '0');
        container.innerHTML = '<div class="time-slot active-time" style="cursor:default;">' + hh + ':' + mm + '</div>';
        return;
    }

    var slots = _getTimeSlots();
    container.innerHTML = slots.map(function (s) {
        var active = s.mins === selectedOrderMinutes ? ' active-time' : '';
        return '<div class="time-slot' + active + '" onclick="selectOrderTime(' + s.mins + ')">' + s.label + '</div>';
    }).join('');
}

function selectOrderTime(mins) {
    selectedOrderMinutes = mins;
    renderTimeSlots();
}

function openOrderPanel(dir) {
    currentOrderDir = dir;
    const btn = document.getElementById('order-action-btn');
    if (btn) { btn.textContent = dir; btn.style.background = dir === 'CALL' ? 'var(--up-color)' : 'var(--down-color)'; }
    const availSpan = document.querySelector('#order-panel .order-minmax .up');
    if (availSpan && userData) availSpan.textContent = (userData.perpetualBalance || 0).toFixed(2);

    // Set pair title in panel header
    const pairTitle = document.querySelector('#order-panel .order-pair-title');
    if (pairTitle) {
        pairTitle.textContent = activeSignal ? activeSignal.pair.replace('/', ' / ') : (currentPair || 'BTC / USDT');
    }

    // Signal mode: use admin-set duration, else default to 1 min
    selectedOrderMinutes = (activeSignal && activeSignal.duration) ? Math.max(1, Math.round(activeSignal.duration / 60)) : 1;
    renderTimeSlots();
    document.getElementById('order-panel').style.display = 'block';
    document.getElementById('order-panel-overlay').style.display = 'block';
}
function closeOrderPanel() {
    document.getElementById('order-panel').style.display = 'none';
    document.getElementById('order-panel-overlay').style.display = 'none';
    activeSignal = null;
}
function setOrderPct(pct) {
    const el = document.getElementById('order-amount');
    const balance = userData?.perpetualBalance || 0;
    if (el) {
        // Use Math.floor to truncate to 2 decimals instead of rounding up
        el.value = (Math.floor((balance * pct / 100) * 100) / 100).toFixed(2);
    }
}
function showPairPicker() {
    var list = document.getElementById('futures-pair-list');
    if (list) {
        list.innerHTML = allCoins.map(function (c) {
            var isActive = currentPair === c.sym + '/USDT';
            return '<div class="perp-pair-item' + (isActive ? ' selected' : '') + '" onclick="selectFuturesPair(\'' + c.sym + '\')">' + c.sym + ' / USDT</div>';
        }).join('');
    }
    var overlay = document.getElementById('futures-pair-picker-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeFuturesPairPicker() {
    var overlay = document.getElementById('futures-pair-picker-overlay');
    if (overlay) overlay.style.display = 'none';
}

function selectFuturesPair(sym) {
    closeFuturesPairPicker();
    openTradingPair(sym);
}

// ── PERPETUAL ──
function setPerpTab(btn, tab) {
    document.querySelectorAll('.perp-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const ab = document.getElementById('perp-action-btn');
    if (ab) { ab.textContent = tab === 'long' ? 'Open Long' : 'Open Short'; ab.style.background = tab === 'long' ? 'var(--up-color)' : 'var(--down-color)'; }
}
function setLeverage(btn) {
    document.querySelectorAll('.leverage-btns button').forEach(b => b.classList.remove('active-lev'));
    btn.classList.add('active-lev');
}
function adjPrice(d) { const el = document.getElementById('perp-price'); if (el) el.value = (parseFloat(el.value || 0) + d * 10).toFixed(2); }
function adjAmount(d) { const el = document.getElementById('perp-amount'); if (el) el.value = Math.max(0, parseFloat(el.value || 0) + d * 0.001).toFixed(3); }
function setPerpPct(pct) { showToast(pct + '% selected'); }

// ── ASSETS ──
let assetsVisible = true;
let _spotBal = null, _perpBal = null;
function toggleAssetsVisibility() {
    assetsVisible = !assetsVisible;
    const bal = document.getElementById('assets-balance-val');
    const b = userData?.balance ?? 0;
    const p = userData?.profitBalance ?? 0;

    if (bal) bal.innerHTML = assetsVisible
        ? `${b.toFixed(2)} <i class="fa-solid fa-caret-down" style="font-size:14px;margin-left:4px;"></i>`
        : '****** <i class="fa-solid fa-caret-down" style="font-size:14px;margin-left:4px;"></i>';

    const pVal = userData?.todayPnl !== undefined ? userData.todayPnl : (userData?.profitBalance ?? 0);
    const pStr = pVal > 0 ? `+${pVal.toFixed(2)}` : pVal.toFixed(2);
    const pColor = pVal > 0 ? 'var(--up-color)' : (pVal < 0 ? 'var(--down-color)' : '#fff');

    const pnlEls = ['assets-pnl-val', 'exchange-pnl-val', 'trade-pnl-val'];
    pnlEls.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = assetsVisible ? pStr : '****';
            el.style.color = assetsVisible ? (id === 'assets-pnl-val' ? '#fff' : pColor) : '#fff';
        }
    });
}
async function refreshPnl() {
    await refreshUserData();
    showToast('PnL refreshed!');
}

// ── CONVERT ──
function openConvertModal() { navTo('convert-screen'); loadConvertRates(); }
function closeConvertModal() { navTo('home-screen'); }

// ── FUND TRANSFER ──
function toggleDropdown(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = el.style.display === 'block' ? 'none' : 'block';
}
function selectDropdown(id, val) {
    const menu = document.getElementById(id);
    if (!menu) return;
    const sel = menu.previousElementSibling;
    if (sel) sel.querySelector('span').textContent = val;
    menu.style.display = 'none';
}
function selectTransferWallet(side, wallet) {
    const labelId = side === 'from' ? 'from-wallet-label' : 'to-wallet-label';
    const dropId = side === 'from' ? 'from-dropdown' : 'to-dropdown';
    const el = document.getElementById(labelId);
    if (el) el.textContent = wallet;
    const menu = document.getElementById(dropId);
    if (menu) menu.style.display = 'none';
    updateTransferAvail();
}

function _getSubBal(name) {
    if (name === 'Exchange') return _spotBal !== null ? _spotBal : (userData ? userData.balance : 0);
    if (name === 'Perpetual') return _perpBal !== null ? _perpBal : (userData ? (userData.perpetualBalance || 0) : 0);
    return 0;
}
function _setSubBal(name, val) {
    if (name === 'Exchange') _spotBal = val;
    else if (name === 'Perpetual') _perpBal = val;
}

function updateTransferAvail() {
    const from = document.getElementById('from-wallet-label')?.textContent || 'Exchange';
    const el = document.getElementById('transfer-avail-bal');
    if (el) el.textContent = _getSubBal(from).toFixed(2);
}

function setTransferAll() {
    const from = document.getElementById('from-wallet-label')?.textContent || 'Exchange';
    const inp = document.getElementById('transfer-amount');
    if (inp) inp.value = _getSubBal(from).toFixed(2);
}

function openCurrencyPicker() {
    const o = document.getElementById('currency-picker-overlay');
    if (o) o.style.display = 'block';
}
function closeCurrencyPicker() {
    const o = document.getElementById('currency-picker-overlay');
    if (o) o.style.display = 'none';
}
function selectCurrency(currency) {
    const lbl = document.getElementById('selected-currency-label');
    if (lbl) lbl.textContent = currency;
    closeCurrencyPicker();
}

async function doTransfer() {
    if (!authToken) { showToast('Please login first'); return; }
    const from = document.getElementById('from-wallet-label')?.textContent || '';
    const to = document.getElementById('to-wallet-label')?.textContent || '';
    if (from === to) { showToast('From and To cannot be the same'); return; }
    const amount = parseFloat(document.getElementById('transfer-amount')?.value);
    if (!amount || amount <= 0) { showToast('Please enter a valid amount'); return; }
    const fromBal = _getSubBal(from);
    if (amount > fromBal) { showToast('Insufficient ' + from + ' balance'); return; }
    const btn = document.querySelector('#fund-transfer-screen .btn-green-full');
    if (btn) { btn.disabled = true; btn.textContent = 'Processing...'; }
    try {
        const resp = await fetch('/api/wallet/transfer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
            body: JSON.stringify({ fromWallet: from, toWallet: to, amount })
        });
        const data = await resp.json();
        if (resp.ok) {
            // Refresh balances from server after successful transfer
            try {
                const balResp = await fetch('/api/wallet/balance', { headers: { 'Authorization': 'Bearer ' + authToken } });
                const balData = await balResp.json();
                if (balResp.ok) {
                    _spotBal = balData.balance ?? _spotBal;
                    _perpBal = balData.perpetualBalance ?? _perpBal;
                }
            } catch (e2) {
                _setSubBal(from, fromBal - amount);
                _setSubBal(to, _getSubBal(to) + amount);
            }
            const spotEl = document.getElementById('acct-exchange-bal');
            const perpEl = document.getElementById('acct-perpetual-bal');
            if (spotEl) spotEl.textContent = (_spotBal || 0).toFixed(2);
            if (perpEl) perpEl.textContent = (_perpBal || 0).toFixed(2);
            document.getElementById('transfer-amount').value = '';
            updateTransferAvail();
            showToast('Transfer successful! ' + amount.toFixed(2) + ' USDT moved to ' + to);
        } else {
            showToast(data.error || 'Transfer failed. Please try again.');
        }
    } catch (e) {
        _setSubBal(from, fromBal - amount);
        _setSubBal(to, _getSubBal(to) + amount);
        const spotEl = document.getElementById('acct-exchange-bal');
        const perpEl = document.getElementById('acct-perpetual-bal');
        if (spotEl) spotEl.textContent = (_spotBal || 0).toFixed(2);
        if (perpEl) perpEl.textContent = (_perpBal || 0).toFixed(2);
        document.getElementById('transfer-amount').value = '';
        updateTransferAvail();
        showToast('Transfer successful! ' + amount.toFixed(2) + ' USDT moved to ' + to);
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm'; }
}

// ── LOGIN/REGISTER TAB SWITCHES ──
function setLoginTab(btn, tab) {
    document.querySelectorAll('.login-type-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const emailGroup = document.getElementById('login-email-group');
    if (emailGroup) emailGroup.style.display = 'block';
}

function setRegTab(btn, tab) {
    document.querySelectorAll('#register-screen .login-type-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    showToast(tab === 'mobile' ? 'Mobile registration coming soon' : '');
}

// ── OTP TIMER ──
let currentCaptchaStr = '';

function drawCaptcha() {
    const canvas = document.getElementById('captcha-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const chars = '23456789abcdefghkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
    currentCaptchaStr = '';
    for (let i = 0; i < 4; i++) {
        currentCaptchaStr += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Draw dots
    for (let i = 0; i < 50; i++) {
        ctx.fillStyle = `hsl(${Math.random() * 360}, 50%, 50%)`;
        ctx.beginPath();
        ctx.arc(Math.random() * canvas.width, Math.random() * canvas.height, Math.random() * 2, 0, Math.PI * 2);
        ctx.fill();
    }

    // Draw text
    for (let i = 0; i < 4; i++) {
        ctx.font = 'bold 24px "Times New Roman", serif';
        ctx.fillStyle = `hsl(${Math.random() * 360}, 60%, 40%)`;
        ctx.save();
        ctx.translate(20 + i * 22, 28);
        ctx.rotate((Math.random() - 0.5) * 0.4);
        ctx.fillText(currentCaptchaStr[i], 0, 0);
        ctx.restore();
    }
}

function closeCaptcha() {
    document.getElementById('captcha-overlay').style.display = 'none';
}

async function showCaptchaModal() {
    const email = document.getElementById('reg-email')?.value?.trim();
    if (!email || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/i.test(email)) {
        showToast('Please enter a valid email first');
        return;
    }
    const btn = document.getElementById('otp-btn');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try {
        const res = await fetch('/api/auth/send-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const txt = await res.text();
        let data;
        try {
            data = JSON.parse(txt);
        } catch (err) {
            showToast('Server Error: ' + (txt.slice(0, 100) || res.statusText));
            btn.disabled = false;
            return;
        }
        if (data.error) { showToast(data.error); btn.disabled = false; return; }
        showToast('Verification code sent successfully!');
    } catch (e) { showToast('Failed to send code: ' + e.message); btn.disabled = false; return; }
    let seconds = 60;
    btn.textContent = seconds + 's';
    const interval = setInterval(() => {
        seconds--;
        btn.textContent = seconds + 's';
        if (seconds <= 0) { clearInterval(interval); btn.disabled = false; btn.textContent = 'Send'; }
    }, 1000);
}

// ── PASTE ADDRESS ──
function pasteAddress() {
    if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then(text => {
            const el = document.getElementById('withdrawal-addr');
            if (el) { el.value = text; showToast('Address pasted'); }
        }).catch(() => showToast('Paste from clipboard denied'));
    } else {
        showToast('Tap and hold the field to paste');
    }
}

// ── CLOSE WRONG PASS POPUP ──
function closeWrongPass() {
    const el = document.getElementById('wrong-pass-overlay');
    if (el) el.style.display = 'none';
}
function showBalanceCriteria() {
    const el = document.getElementById('balance-criteria-overlay');
    if (el) el.style.display = 'flex';
}
function closeBalanceCriteria() {
    const el = document.getElementById('balance-criteria-overlay');
    if (el) el.style.display = 'none';
}

// ── SET USER PROFILE (called on DOMContentLoaded) ──
function setUserProfile() {
    if (userData) {
        updateUIWithUserData();
    }
}

// ── CHART ──
let apexChart = null;
let apexChartData = [];
let apexChartRaw = [];
let apexPerpChart = null;
let apexPerpData = [];
let apexPerpRaw = [];
let chartState = { sym: 'BTCUSDT', tf: '1m', type: 'candle', vol: true, ma7: true, ma25: true };
let perpState = { sym: 'BTCUSDT', tf: '1h', type: 'candle', vol: true, ma7: true, ma25: true };

function _updateRealtimeChart(chartObj, state, kDataRaw) {
    if (!chartObj || !kDataRaw) return;
    try {
        chartObj.updateData({
            timestamp: kDataRaw[0],
            open: +kDataRaw[1],
            high: +kDataRaw[2],
            low: +kDataRaw[3],
            close: +kDataRaw[4],
            volume: +kDataRaw[5]
        });
    } catch (e) { console.error('KLine update error:', e); }
}

function _rebuildChart(candleData, rawKlines, state, containerId, height) {
    var c = document.getElementById(containerId);
    if (!c || !candleData.length) return null;
    try { klinecharts.dispose(containerId); } catch (e) { }
    c.innerHTML = '';
    c.style.width = '100%';
    c.style.height = height + 'px';

    var isLight = document.body.classList.contains('light-mode');
    var bg = 'transparent';
    var text = isLight ? '#6b7280' : '#848e9c';
    var grid = isLight ? '#e5e7eb' : '#1f2530';
    var up = '#02c076';
    var down = '#f84960';

    var chart;
    try {
        chart = klinecharts.init(containerId, {
            styles: {
                grid: { horizontal: { color: grid, style: 'dashed' }, vertical: { color: grid, style: 'dashed' } },
                candle: {
                    bar: { upColor: up, downColor: down, noChangeColor: up, upBorderColor: up, downBorderColor: down, noChangeBorderColor: up, upWickColor: up, downWickColor: down, noChangeWickColor: up },
                    area: { lineColor: up, backgroundColor: [{ offset: 0, color: 'rgba(2,192,118,0.4)' }, { offset: 1, color: 'rgba(2,192,118,0)' }] },
                    type: state.type === 'line' || state.type === 'area' ? 'area' : 'candle_solid',
                    tooltip: { showRule: 'none' }
                },
                xAxis: { axisLine: { color: grid }, tickLine: { color: grid }, tickText: { color: text } },
                yAxis: { axisLine: { color: grid }, tickLine: { color: grid }, tickText: { color: text } },
                separator: { color: grid },
                crosshair: { horizontal: { line: { color: '#848e9c' } }, vertical: { line: { color: '#848e9c' } } },
                indicator: { tooltip: { showRule: 'none' } }
            }
        });

        var pPrecision = 2;
        if (candleData.length && candleData[0].y[3] < 10) pPrecision = 4;
        if (candleData.length && candleData[0].y[3] < 1) pPrecision = 6;
        chart.setPriceVolumePrecision(pPrecision, 2);

        var kData = candleData.map(function (d, i) {
            return {
                timestamp: d.x,
                open: d.y[0],
                high: d.y[1],
                low: d.y[2],
                close: d.y[3],
                volume: rawKlines && rawKlines[i] ? +rawKlines[i][5] : 0
            };
        });

        chart.applyNewData(kData);

        if (state.vol) {
            try { chart.createIndicator('VOL', false, { id: 'pane_1' }); } catch (e) { }
        }
        if (state.ma7 || state.ma25) {
            var maArgs = [];
            if (state.ma7) maArgs.push(7);
            if (state.ma25) maArgs.push(25);
            try { chart.createIndicator({ name: 'MA', calcParams: maArgs }, false, { id: 'candle_pane' }); } catch (e) { }
        }
    } catch (e) {
        console.error('KLineChart error:', e);
    }
    return chart;
}

function initChart(symbol, interval) {
    interval = interval || '1m';
    const container = document.getElementById('main-chart');
    if (!container) return;
    if (apexChart) { try { apexChart.destroy(); } catch (e) { } apexChart = null; }
    apexChartData = []; apexChartRaw = [];
    chartState.sym = symbol.replace(/\//g, '').replace('USDTUSDT', 'USDT').replace(/\s+/g, '').toUpperCase();
    chartState.tf = interval;
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:340px;color:#a9a49a;font-size:13px;">Loading...</div>';

    const sym = chartState.sym;
    let bSym = sym;
    if (bSym === 'XAUUSDT') bSym = 'PAXGUSDT';
    else if (bSym === 'XAGUSDT') bSym = 'LTCUSDT';
    else if (bSym === 'XPTUSDT') bSym = 'ETHUSDT';
    else if (bSym === 'XPDUSDT') bSym = 'BCHUSDT';

    // Use Binance Vision as fallback to avoid IP bans
    fetch('/api/mexc/klines?symbol=' + bSym + '&interval=' + interval + '&limit=150')
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (!Array.isArray(data)) return;
            apexChartRaw = data;
            apexChartData = data.map(function (k) { return { x: +k[0], y: [+k[1], +k[2], +k[3], +k[4]] }; });
            apexChart = _rebuildChart(apexChartData, apexChartRaw, chartState, 'main-chart', 360);
            updateOHLCRow('chart-ma-row', sym, interval, data[data.length - 1]);
        }).catch(function () {
            // Fallback to MEXC if Binance Vision fails
            fetch('/api/mexc/klines?symbol=' + bSym + '&interval=' + interval + '&limit=150')
                .then(r => r.json())
                .then(data => {
                    if (!Array.isArray(data)) return;
                    apexChartRaw = data;
                    apexChartData = data.map(function (k) { return { x: +k[0], y: [+k[1], +k[2], +k[3], +k[4]] }; });
                    apexChart = _rebuildChart(apexChartData, apexChartRaw, chartState, 'main-chart', 360);
                    updateOHLCRow('chart-ma-row', sym, interval, data[data.length - 1]);
                }).catch(() => { });
        });


    if (window._chartWs) { clearInterval(window._chartWs); window._chartWs = null; }
    function pollChartMexc() {
        fetch('/api/mexc/klines?symbol=' + bSym + '&interval=' + interval + '&limit=1')
            .then(r => r.json())
            .then(data => {
                if (!Array.isArray(data) || !data.length) return;
                var k = data[0];
                var rawC = [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5]];
                if (apexChartData.length) {
                    var last = apexChartData[apexChartData.length - 1];
                    if (last.x === rawC[0]) {
                        apexChartData[apexChartData.length - 1] = { x: rawC[0], y: [+k[1], +k[2], +k[3], +k[4]] };
                        apexChartRaw[apexChartRaw.length - 1] = rawC;
                    } else {
                        apexChartData.push({ x: rawC[0], y: [+k[1], +k[2], +k[3], +k[4]] });
                        apexChartRaw.push(rawC);
                        if (apexChartData.length > 160) { apexChartData.shift(); apexChartRaw.shift(); }
                    }
                }
                updateOHLCRow('chart-ma-row', sym, interval, rawC);
                _updateRealtimeChart(apexChart, chartState, rawC);
            }).catch(() => { });
    }
    window._chartWs = setInterval(pollChartMexc, 2000);
}


function initPerpChart(symbol, interval) {
    symbol = symbol || 'BTCUSDT';
    interval = interval || '1h';
    const container = document.getElementById('perp-main-chart');
    if (!container) return;
    if (apexPerpChart) { try { apexPerpChart.destroy(); } catch (e) { } apexPerpChart = null; }
    apexPerpData = []; apexPerpRaw = [];
    perpState.sym = symbol.replace(/\//g, '').toUpperCase();
    perpState.tf = interval;
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:290px;color:#a9a49a;font-size:13px;">Loading...</div>';

    const sym = perpState.sym;
    let bSym = sym;
    if (bSym === 'XAUUSDT') bSym = 'PAXGUSDT';
    else if (bSym === 'XAGUSDT') bSym = 'LTCUSDT';
    else if (bSym === 'XPTUSDT') bSym = 'ETHUSDT';
    else if (bSym === 'XPDUSDT') bSym = 'BCHUSDT';
    // Use Binance Vision as fallback to avoid IP bans
    fetch('/api/mexc/klines?symbol=' + bSym + '&interval=' + interval + '&limit=150')
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (!Array.isArray(data)) return;
            apexPerpRaw = data;
            apexPerpData = data.map(function (k) { return { x: +k[0], y: [+k[1], +k[2], +k[3], +k[4]] }; });
            apexPerpChart = _rebuildChart(apexPerpData, apexPerpRaw, perpState, 'perp-main-chart', 310);
            updateOHLCRow('perp-ma-row', sym, interval, data[data.length - 1]);
        }).catch(function () {
            // Fallback to MEXC if Binance Vision fails
            fetch('/api/mexc/klines?symbol=' + bSym + '&interval=' + interval + '&limit=150')
                .then(r => r.json())
                .then(data => {
                    if (!Array.isArray(data)) return;
                    apexPerpRaw = data;
                    apexPerpData = data.map(function (k) { return { x: +k[0], y: [+k[1], +k[2], +k[3], +k[4]] }; });
                    apexPerpChart = _rebuildChart(apexPerpData, apexPerpRaw, perpState, 'perp-main-chart', 310);
                    updateOHLCRow('perp-ma-row', sym, interval, data[data.length - 1]);
                }).catch(() => { });
        });


    if (window._perpWs) { clearInterval(window._perpWs); window._perpWs = null; }
    function pollPerpMexc() {
        fetch('/api/mexc/klines?symbol=' + bSym + '&interval=' + interval + '&limit=1')
            .then(r => r.json())
            .then(data => {
                if (!Array.isArray(data) || !data.length) return;
                var k = data[0];
                var rawC = [+k[0], +k[1], +k[2], +k[3], +k[4], +k[5]];
                if (apexPerpData.length) {
                    var last = apexPerpData[apexPerpData.length - 1];
                    if (last.x === rawC[0]) {
                        apexPerpData[apexPerpData.length - 1] = { x: rawC[0], y: [+k[1], +k[2], +k[3], +k[4]] };
                        apexPerpRaw[apexPerpRaw.length - 1] = rawC;
                    } else {
                        apexPerpData.push({ x: rawC[0], y: [+k[1], +k[2], +k[3], +k[4]] });
                        apexPerpRaw.push(rawC);
                        if (apexPerpData.length > 160) { apexPerpData.shift(); apexPerpRaw.shift(); }
                    }
                }
                updateOHLCRow('perp-chart-ma-row', sym, interval, rawC);
                _updateRealtimeChart(apexPerpChart, perpState, rawC);
            }).catch(() => { });
    }
    window._perpWs = setInterval(pollPerpMexc, 2000);
}


function _syncIndicators(chartObj, state) {
    if (!chartObj) return;
    try {
        if (state.vol) chartObj.createIndicator('VOL', false, { id: 'pane_1' });
        else chartObj.removeIndicator('pane_1', 'VOL');

        if (state.ma7 || state.ma25) {
            var maArgs = [];
            if (state.ma7) maArgs.push(7);
            if (state.ma25) maArgs.push(25);
            chartObj.createIndicator({ name: 'MA', calcParams: maArgs }, false, { id: 'candle_pane' });
        } else {
            chartObj.removeIndicator('candle_pane', 'MA');
        }
    } catch (e) { }
}

function _syncChartType(chartObj, state) {
    if (!chartObj) return;
    try {
        chartObj.setStyles({
            candle: { type: state.type === 'line' || state.type === 'area' ? 'area' : 'candle_solid' }
        });
    } catch (e) { }
}

function setChartType(type) {
    chartState.type = type;
    ['candle', 'line', 'area'].forEach(function (t) {
        var btn = document.getElementById('btn-type-' + t);
        if (btn) btn.classList.toggle('active', t === type);
    });
    _syncChartType(apexChart, chartState);
}

function toggleChartIndicator(ind) {
    chartState[ind] = !chartState[ind];
    var btn = document.getElementById('btn-ind-' + ind);
    if (btn) btn.classList.toggle('active', chartState[ind]);
    _syncIndicators(apexChart, chartState);
}

function setPerpChartType(type) {
    perpState.type = type;
    ['candle', 'line', 'area'].forEach(function (t) {
        var btn = document.getElementById('perp-btn-type-' + t);
        if (btn) btn.classList.toggle('active', t === type);
    });
    _syncChartType(apexPerpChart, perpState);
}

function togglePerpIndicator(ind) {
    perpState[ind] = !perpState[ind];
    var btn = document.getElementById('perp-btn-ind-' + ind);
    if (btn) btn.classList.toggle('active', perpState[ind]);
    _syncIndicators(apexPerpChart, perpState);
}

// ── PRODUCTION BACKEND INTEGRATION ──
let socket;
let authToken = localStorage.getItem('token');
let userData = null;
try { userData = JSON.parse(localStorage.getItem('user')); } catch (e) { userData = null; }
let activeSignals = [];   // array of current signals from server
let activeSignal = null;  // the signal the user clicked "Follow" on (used in placeOrder)
let signalTimers = {};    // signalId → setInterval handle
let currentPair = 'ETH/USDT';

function initSocket() {
    window.updateOHLCRow = function () { };
    socket = io();
    if (authToken) socket.emit('authenticate', authToken);

    socket.on('market_update', (prices) => {
        updateMarketUI(prices);
    });

    socket.on('new_signal', (signal) => {
        fetchSignals();
        showToast('New Signal: ' + signal.pair + ' ' + signal.direction);
        const tickerEl = document.getElementById('home-ticker-text');
        const sigTime = signal.entryTime ? new Date(signal.entryTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const durMins = signal.duration ? Math.round(signal.duration / 60) + 'min' : '';
        if (tickerEl) tickerEl.textContent = 'HOT SIGNAL ALERT: ' + signal.pair + ' ' + signal.direction + (sigTime ? ' @ ' + sigTime : '') + (durMins ? ' | Duration: ' + durMins : '') + ' - GET READY TO TRADE!';
        // Show bell badge immediately
        const dot = document.getElementById('notif-dot-main');
        if (dot) { dot.style.display = 'block'; }
    });

    socket.on('signal_started', (signal) => {
        const idx = activeSignals.findIndex(function (s) { return s.id === signal.id; });
        if (idx !== -1) { activeSignals[idx] = signal; } else { activeSignals.push(signal); }
        renderSignalCards();
        showToast('Signal ACTIVE: ' + signal.pair + ' — Follow Now!');
        const tickerEl = document.getElementById('home-ticker-text');
        const sigTime = signal.entryTime ? new Date(signal.entryTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        const durMins = signal.duration ? Math.round(signal.duration / 60) + 'min' : '';
        if (tickerEl) tickerEl.textContent = '🔴 SIGNAL ACTIVE: ' + signal.pair + ' ' + signal.direction + (sigTime ? ' @ ' + sigTime : '') + (durMins ? ' | ' + durMins : '') + ' - TRADE NOW!';
        // Show bell badge immediately
        const dot = document.getElementById('notif-dot-main');
        if (dot) { dot.style.display = 'block'; }
        fetchNotifications();
    });

    socket.on('signal_completed', function (data) {
        activeSignals = activeSignals.filter(function (s) { return s.id !== data.signalId; });
        if (activeSignal && activeSignal.id === data.signalId) activeSignal = null;
        if (signalTimers[data.signalId]) { clearInterval(signalTimers[data.signalId]); delete signalTimers[data.signalId]; }
        renderSignalCards();
        refreshUserData();
        loadTradeHistory();
        showToast('Signal Resolved — check History tab for result!');
    });

    socket.on('signal_cancelled', function (data) {
        activeSignals = activeSignals.filter(function (s) { return s.id !== data.signalId; });
        if (activeSignal && activeSignal.id === data.signalId) activeSignal = null;
        if (signalTimers[data.signalId]) { clearInterval(signalTimers[data.signalId]); delete signalTimers[data.signalId]; }
        renderSignalCards();
    });

    socket.on('notification', (notif) => {
        showToast(notif.title || notif.message);
        // Always show bell badge immediately
        const dot = document.getElementById('notif-dot-main');
        if (dot) dot.style.display = 'block';
        // If it's a signal notification, also update the news ticker
        if (notif.type === 'SIGNAL') {
            const tickerEl = document.getElementById('home-ticker-text');
            if (tickerEl) tickerEl.textContent = '🔔 ' + notif.title + ' - ' + notif.message;
        }
        fetchNotifications();
    });
}

function flashEl(el, isUp) {
    if (!el) return;
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(isUp ? 'flash-up' : 'flash-down');
}

function updateMarketUI(prices) {
    for (const [pair, data] of Object.entries(prices)) {
        // Skip invalid/zero prices to prevent flash
        if (!data.price || data.price <= 0) continue;

        const up = data.change >= 0;
        const sym = pair.replace('/USDT', '').replace('USDT', '');

        // Update allCoins with sparkline history
        const coin = allCoins.find(c => c.sym === sym);
        if (coin) {
            const prevPrice = parseFloat(coin.price.replace(/,/g, '')) || 0;
            let formattedPrice = data.price < 0.1 ? data.price.toFixed(5) : (data.price < 100 ? data.price.toFixed(4) : data.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
            coin.price = formattedPrice;
            coin.ch = (up ? '+' : '') + data.change.toFixed(2) + '%';
            coin.up = up;
            // Leave the sparkline arrays alone so the charts stay exactly as their initial wavy shapes.
            const hmPrice = document.getElementById('hm-price-' + sym);
            const hmChg = document.getElementById('hm-chg-' + sym);
            if (hmPrice) { hmPrice.textContent = coin.price; hmPrice.style.color = '#f5f1e8'; }
            if (hmChg) {
                hmChg.textContent = coin.ch;
                hmChg.style.background = up ? '#02c076' : '#f84960';
                hmChg.style.color = '#fff';
            }
        }

        // Update mini ticker by ID (fast, no DOM scan)
        const priceEl = document.getElementById('tick-price-' + sym);
        const chgEl = document.getElementById('tick-badge-' + sym);
        const spEl = document.getElementById('tick-sp-' + sym);
        if (priceEl) {
            const prev = priceEl.textContent;
            let formattedPrice = data.price < 0.1 ? data.price.toFixed(5) : (data.price < 100 ? data.price.toFixed(4) : data.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
            priceEl.textContent = formattedPrice;
            priceEl.className = 'price ' + (up ? 'up' : 'down');
            if (prev !== priceEl.textContent) flashEl(priceEl, up);
        }
        if (chgEl) {
            chgEl.textContent = (up ? '+' : '') + data.change.toFixed(2) + '%';
            chgEl.style.background = up ? '#00c087' : '#f84960';
        }
        if (spEl && coin) spEl.innerHTML = makeSparkline(coin);

        // Update futures screen live price (if this pair is active)
        const activeSym = currentPair.replace('/USDT', '').replace(/[\\s\/]/g, '');
        if (sym === activeSym) {
            const fpEl = document.getElementById('futures-live-price');
            const fcEl = document.getElementById('futures-price-chg');
            const pn = document.querySelector('#futures-screen .pair-change');
            if (fpEl) {
                let formattedPrice = data.price < 0.1 ? data.price.toFixed(5) : (data.price < 100 ? data.price.toFixed(4) : data.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
                fpEl.textContent = formattedPrice + ' USDT';
                fpEl.className = 'futures-live-price-val ' + (up ? 'up' : 'down');
                flashEl(fpEl, up);
            }
            if (fcEl) { fcEl.textContent = (up ? '+' : '') + data.change.toFixed(2) + '%'; fcEl.className = up ? 'up' : 'down'; }
            if (pn) { pn.textContent = ' ' + (up ? '+' : '') + data.change.toFixed(2) + '%'; pn.className = 'pair-change ' + (up ? 'up' : 'down'); }
            // Update High / Low / Volume stats
            const fHighEl = document.getElementById('futures-price-high');
            const fLowEl = document.getElementById('futures-price-low');
            const fVolEl = document.getElementById('futures-price-vol');
            if (fHighEl && data.high) fHighEl.textContent = data.high.toLocaleString();
            if (fLowEl && data.low) fLowEl.textContent = data.low.toLocaleString();
            if (fVolEl && data.volume) {
                const v = data.volume;
                fVolEl.textContent = v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(2) + 'K' : v.toFixed(2);
            }
        }

        // Update perpetual screen if BTC
        if (sym === 'BTC') {
            const ppEl = document.getElementById('perp-live-price');
            const puEl = document.getElementById('perp-live-usd');
            if (ppEl) { ppEl.textContent = data.price.toLocaleString(); ppEl.className = 'perp-price ' + (up ? 'up' : 'down'); flashEl(ppEl, up); }
            if (puEl) { puEl.textContent = '≈ $' + data.price.toLocaleString(); puEl.className = 'perp-usd ' + (up ? 'up' : 'down'); }
            const perpPriceInput = document.getElementById('perp-price');
            if (perpPriceInput) perpPriceInput.value = data.price.toFixed(2);
        }
    }

    // Re-render markets search list (targeted rebuild only when on that screen)
    if (currentScreen === 'markets-screen') {
        renderMarkets(document.getElementById('markets-search-input')?.value || '');
    }
    // Home market: targeted updates already done above per-coin, no full rebuild needed
}

async function fetchNotifications() {
    if (!authToken) return;
    try {
        const res = await fetch('/api/user/notifications', { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (!res.ok) return;
        const notifs = await res.json();
        const container = document.getElementById('notif-list-container');
        if (!container) return;
        if (!notifs.length) {
            container.innerHTML = '<div class="no-data-block" style="padding-top:60px;"><i class="fa-regular fa-bell" style="font-size:40px;color:var(--text-muted);margin-bottom:12px;"></i><p>No notifications</p></div>';
            return;
        }
        container.innerHTML = notifs.map(n => `
            <div class="notif-item ${n.read ? '' : 'unread'}">
                <div class="notif-icon ${n.type ? n.type.toLowerCase() : ''}"><i class="fa-solid fa-bell"></i></div>
                <div class="notif-content">
                    <div class="notif-title">${n.title}</div>
                    <div class="notif-msg">${n.message}</div>
                    <div class="notif-time">${new Date(n.createdAt).toLocaleString()}</div>
                </div>
            </div>
        `).join('');
        const unread = notifs.some(n => !n.read);
        const dot = document.getElementById('notif-dot-main');
        if (dot) dot.style.display = unread ? 'block' : 'none';
    } catch (err) { }
}

async function markAllRead() {
    if (!authToken) return;
    await fetch('/api/user/notifications/read', { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } });
    fetchNotifications();
}

function updateUIWithUserData() {
    if (!userData) return;

    // Sidebar
    const emailEl = document.getElementById('sidebar-email');
    const idEl = document.getElementById('sidebar-uid');
    if (emailEl) {
        const display = userData.email || '';
        emailEl.textContent = display.length > 24 ? display.substring(0, 22) + '...' : display;
    }
    if (idEl && userData.id) {
        idEl.style.display = 'flex';
        const numId = toNumericId(userData.id);
        idEl.innerHTML = `ID: ${numId} <i class="fa-regular fa-copy" onclick="copyText('${numId}')" style="cursor:pointer;"></i>`;
    }
    // Personal Center profile card — show the account email
    const pcEmail = document.getElementById('pc-email');
    if (pcEmail) pcEmail.textContent = userData.email || 'Not logged in';
    const pcUid = document.getElementById('pc-uid');
    const pcUidVal = document.getElementById('pc-uid-val');
    if (pcUid && userData.id) {
        pcUid.style.display = 'flex';
        if (pcUidVal) pcUidVal.textContent = toNumericId(userData.id);
    }
    // ── VERIFIED BADGE (based on KYC status from backend) ──
    const pcKycBadge = document.getElementById('pc-kyc-badge');
    if (pcKycBadge) {
        const kycStatus = userData.kycData?.status || 'NONE';
        const kycMap = {
            'APPROVED': { icon: 'fa-circle-check', text: 'Verified',  cls: 'pc-badge-verified verified-ok' },
            'PENDING':  { icon: 'fa-clock',        text: 'Pending',   cls: 'pc-badge-verified pending-kyc' },
            'REJECTED': { icon: 'fa-circle-xmark', text: 'Rejected',  cls: 'pc-badge-verified rejected-kyc' },
            'NONE':     { icon: 'fa-circle-xmark', text: 'Unverified',cls: 'pc-badge-verified' }
        };
        const k = kycMap[kycStatus] || kycMap['NONE'];
        pcKycBadge.innerHTML = `<i class="fa-solid ${k.icon}" style="font-size:11px;"></i> ${k.text}`;
        pcKycBadge.className = k.cls;
    }

    // ── VIP BADGE (based on total balance) ──
    const pcVipBadge = document.getElementById('pc-vip-badge');
    if (pcVipBadge) {
        const total = (userData.balance || 0) + (userData.perpetualBalance || 0);
        let vipLevel = 0;
        if (total >= 20000) vipLevel = 4;
        else if (total >= 5000) vipLevel = 3;
        else if (total >= 1000) vipLevel = 2;
        else if (total >= 100) vipLevel = 1;
        const vipIcons = ['🥉','🥈','🥇','💎','👑'];
        pcVipBadge.textContent = `${vipIcons[vipLevel]} VIP${vipLevel}`;
    }
    // Avatar always shows the NEOTRADE mark
    const pcAvatar = document.getElementById('pc-avatar');
    if (pcAvatar && !pcAvatar.querySelector('img')) {
        pcAvatar.innerHTML = `<img src="/netrontrade-logo.svg" style="width:100%;height:100%;object-fit:cover;border-radius:20px;">`;
    }

    // Assets balance — always show real USDT balance unchanged
    const balEl = document.getElementById('assets-balance-val');
    if (balEl) balEl.innerHTML = `${(userData.balance || 0).toFixed(2)} <span style="font-size:13px;font-weight:500;margin-left:4px;">USDT</span> <i class="fa-solid fa-caret-down" style="font-size:14px;margin-left:4px;"></i>`;

    // My account sub-balances — initialise spot only once; futures/perp track their own balances
    // My account sub-balances from backend
    // profitBalance is a P/L tracker, not separate money — a win's profit
    // is already inside perpetualBalance (the full payout lands there), so
    // adding profitBalance again double-counted every win into Total Assets.
    const totalAssetVal = (userData.balance || 0) + (userData.perpetualBalance || 0);
    if (document.getElementById("assets-balance-val")) document.getElementById("assets-balance-val").innerHTML = `${totalAssetVal.toFixed(2)} <span style="font-size:13px;font-weight:500;margin-left:4px;">USDT</span> <i class="fa-solid fa-caret-down" style="font-size:14px;margin-left:4px;"></i>`;
    const exchBal = document.getElementById('acct-exchange-bal');
    if (exchBal) exchBal.textContent = (userData.exchangeBalance || userData.balance || 0).toFixed(2);
    const perpBal = document.getElementById('acct-perpetual-bal');
    if (perpBal) perpBal.textContent = (userData.perpetualBalance || 0).toFixed(2);

    // Exchange sub-screen — header shows total, coin list stays at 0
    const exBalVal = userData.exchangeBalance || userData.balance || 0;
    const exchHeader = document.getElementById('exchange-assets-bal');
    if (exchHeader) exchHeader.innerHTML = `${exBalVal.toFixed(2)} <i class="fa-solid fa-caret-down" style="font-size:14px;margin-left:4px;"></i>`;

    // PnL
    const pVal = userData.todayPnl !== undefined ? userData.todayPnl : (userData.profitBalance || 0);
    const pStr = pVal > 0 ? `+${pVal.toFixed(2)}` : pVal.toFixed(2);
    const pColor = pVal > 0 ? 'var(--up-color)' : (pVal < 0 ? 'var(--down-color)' : '#fff');
    const pnlEls = ['assets-pnl-val', 'exchange-pnl-val', 'trade-pnl-val'];
    pnlEls.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.textContent = assetsVisible ? pStr : '****';
            el.style.color = assetsVisible ? (id === 'assets-pnl-val' ? '#fff' : pColor) : '#fff';
        }
    });

    // Referral link
    const refLinkEl = document.getElementById('ref-link-text');
    if (refLinkEl) refLinkEl.textContent = `${window.location.origin}/register?ref=${userData.referralCode || ''}`;

    // Referral stats
    const refCountEl = document.getElementById('ref-count');
    if (refCountEl) refCountEl.textContent = (userData.referrals || []).length;

    const refEarnedEl = document.getElementById('ref-earned');
    if (refEarnedEl) refEarnedEl.textContent = (userData.referralBalance || 0).toFixed(2);

    // Referral list (update both referrals-screen and share-screen containers)
    const refContainers = [document.getElementById('ref-list-container'), document.getElementById('share-ref-list-container')];
    const refs = userData.referrals || [];
    let htmlContent = '<div class="no-data-block"><p>No referrals yet</p></div>';

    if (refs.length > 0) {
        htmlContent = refs.map(r => {
            const commission = ((r.investments || 0) * 0.05).toFixed(2);
            return `
                <div class="ref-item" style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid rgba(214,181,106,0.14);">
                    <div>
                        <div class="ref-user" style="font-weight:600;font-size:14px;color:var(--text-primary);">${r.email}</div>
                        <div class="ref-date" style="font-size:12px;color:var(--text-secondary);">${new Date(r.createdAt).toLocaleDateString()}</div>
                    </div>
                    <div class="ref-income" style="font-weight:600;color:var(--up-color);">+${commission} USDT</div>
                </div>`;
        }).join('');
    }

    refContainers.forEach(container => {
        if (container) container.innerHTML = htmlContent;
    });

    // Share screen invite code
    const shareCodeEl = document.getElementById('share-invite-code');
    if (shareCodeEl && userData.referralCode) shareCodeEl.textContent = userData.referralCode;

    const shareRefBtn = document.getElementById('share-ref-link');
    if (shareRefBtn && userData.referralCode) {
        shareRefBtn.onclick = () => copyText(`${window.location.origin}/register?ref=${userData.referralCode}`);
    }

    // Withdrawal balance hint
    const hintEl = document.querySelector('#withdrawal-screen .input-hint');
    if (hintEl) hintEl.textContent = `Balance: ${userData.balance.toFixed(2)} USDT`;
    const wbHint = document.getElementById('withdrawal-balance-hint');
    if (wbHint && userData.balance !== undefined) wbHint.textContent = `Available: ${userData.balance.toFixed(2)} USDT`;

    // Order panel available balance
    const availSpan = document.querySelector('#order-panel .order-minmax .up');
    if (availSpan) availSpan.textContent = (userData.perpetualBalance || 0).toFixed(2);

    // Fund transfer available balance
    updateTransferAvail();

    // Convert screen available balance
    var convertAvailEl = document.getElementById('convert-avail');
    if (convertAvailEl) convertAvailEl.textContent = userData.balance.toFixed(2) + ' USDT';

    // Store deposit address for deposit screen
    if (userData.depositAddress) {
        const depEl = document.getElementById('dep-addr');
        if (depEl) depEl.textContent = userData.depositAddress;
    }

}

// The deposit address is the single fixed platform TRC20 address, served by
// the backend (TRC20_RECEIVING_ADDRESS) — not hardcoded here.
async function loadDepositInfo() {
    if (!authToken) return;
    try {
        const res = await fetch('/api/wallet/address', { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (!res.ok) return;
        const data = await res.json();
        const depEl = document.getElementById('dep-addr');
        if (depEl) depEl.textContent = data.address || '—';

        const qrBox = document.getElementById('dep-qr-box');
        if (qrBox && data.qr_code_base64) {
            qrBox.innerHTML = '<img src="' + data.qr_code_base64 + '" style="width:160px;height:160px;border-radius:8px;" />';
        }
    } catch (err) { }
}

// Everyone deposits to the same address, so the user submits the TXID of
// their transfer; the backend verifies it on-chain and queues it for approval.
async function submitDepositTxid() {
    if (!authToken) return showToast('Please login first');
    const input = document.getElementById('dep-txid');
    const btn = document.getElementById('dep-submit-btn');
    const txHash = (input && input.value || '').trim();
    if (!/^[0-9a-fA-F]{64}$/.test(txHash)) return showToast('Please enter a valid 64-character TXID');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/wallet/deposit/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ txHash })
        });
        const data = await res.json().catch(function () { return {}; });
        if (!res.ok) return showToast(data.error || 'Deposit submission failed', 4000);
        if (input) input.value = '';
        showToast('Deposit of ' + data.deposit.amount + ' USDT submitted — pending approval', 4000);
    } catch (err) {
        showToast('Network error, please try again');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function loadTransactions() {
    const container = document.getElementById('transaction-list');
    if (!container) return;
    if (!authToken) {
        container.innerHTML = '<div class="no-data-block" style="padding-top:60px;"><i class="fa-solid fa-file-invoice" style="font-size:48px;color:var(--text-muted);margin-bottom:14px;"></i><p>Please login to view transactions</p></div>';
        return;
    }
    container.innerHTML = '<div class="no-data-block" style="padding-top:60px;"><p>Loading...</p></div>';
    try {
        const res = await fetch('/api/wallet/transactions', { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (!res.ok) { container.innerHTML = '<div class="no-data-block" style="padding-top:60px;"><p>Failed to load transactions</p></div>'; return; }
        const txs = await res.json();
        if (!txs.length) {
            container.innerHTML = '<div class="no-data-block" style="padding-top:60px;"><i class="fa-solid fa-file-invoice" style="font-size:48px;color:var(--text-muted);margin-bottom:14px;"></i><p>No transactions yet</p></div>';
            return;
        }
        const statusClass = { PENDING: 'pending-status', COMPLETED: 'paid-status', FAILED: 'fail-status' };
        const statusLabel = { PENDING: 'Pending', COMPLETED: 'Completed', FAILED: 'Failed' };
        const titleMap = {
            DEPOSIT: 'Deposit', WITHDRAWAL: 'Withdrawal', TRANSFER: 'Wallet Transfer',
            REFERRAL_COMMISSION: 'Referral Commission',
            ADJUSTMENT_CREDIT: 'Balance Credit', ADJUSTMENT_DEBIT: 'Balance Debit'
        };
        window._allTxData = txs;
        container.innerHTML = txs.map((tx, idx) => `
            <div class="record-item" onclick="showTxDetail(${idx})">
                <div class="record-left">
                    <div class="record-title">${titleMap[tx.type] || tx.type}</div>
                    <div class="record-time">${new Date(tx.createdAt).toLocaleString()}</div>
                </div>
                <div class="record-right">
                    <div class="record-coin">${tx.amount.toFixed(2)} USDT</div>
                    <div class="record-status ${statusClass[tx.status] || 'pending-status'}">${statusLabel[tx.status] || tx.status}</div>
                </div>
            </div>
        `).join('');
    } catch (err) {
        container.innerHTML = '<div class="no-data-block" style="padding-top:60px;"><p>Error loading transactions</p></div>';
    }
}

function showTxDetail(idx) {
    const tx = (window._allTxData || [])[idx];
    if (!tx) return;

    let modal = document.getElementById('tx-details-screen');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'tx-details-screen';
        modal.className = 'screen full-page';
        modal.style.zIndex = '1000';
        modal.innerHTML = `
        <div class="sub-header">
            <i class="fa-solid fa-chevron-left back-btn" onclick="closeTxDetail()"></i>
            <h2>Transaction details</h2>
            <span></span>
        </div>
        <div style="padding:20px;">
            <div style="border-radius:12px;padding:20px;border-top:1px solid rgba(255,255,255,0.05);">
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Type:</span>
                    <span id="tx-type" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Time:</span>
                    <span id="tx-time" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Amount:</span>
                    <span id="tx-amount" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Status:</span>
                    <span id="tx-status" style="font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                    <span style="color:var(--text-secondary);font-size:14px;white-space:nowrap;margin-right:16px;">Note:</span>
                    <span id="tx-note" style="color:var(--text-primary);font-size:14px;font-weight:500;text-align:right;"></span>
                </div>
            </div>
        </div>`;
        document.body.appendChild(modal);
    }

    document.getElementById('tx-type').textContent = tx.type;
    document.getElementById('tx-time').textContent = new Date(tx.createdAt).toLocaleString();
    document.getElementById('tx-amount').textContent = tx.amount.toFixed(2) + ' USDT';
    const statusEl = document.getElementById('tx-status');
    statusEl.textContent = tx.status;
    statusEl.style.color = tx.status === 'COMPLETED' ? 'var(--up-color)' : tx.status === 'FAILED' ? 'var(--down-color)' : 'var(--text-secondary)';
    document.getElementById('tx-note').textContent = tx.note || '-';

    modal.style.display = 'block';
}

function closeTxDetail() {
    const modal = document.getElementById('tx-details-screen');
    if (modal) modal.style.display = 'none';
}

async function loadTradeHistory() {
    const container = document.getElementById('futures-tab-history');
    if (!container) return;
    if (!authToken) return;
    try {
        const res = await fetch('/api/signals/my-trades', { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (!res.ok) return;
        const trades = await res.json();
        if (!trades.length) {
            container.innerHTML = '<div class="no-data-block"><i class="fa-solid fa-clock-rotate-left" style="font-size:40px;color:var(--text-muted);margin-bottom:12px;"></i><p>No trade history</p></div>';
            return;
        }
        let totalTurnover = 0, totalProfit = 0;
        const rows = trades.map(t => {
            const isPending = t.outcome === 'PENDING';
            const isWin = t.outcome === 'WIN';
            const isCancelled = t.outcome === 'CANCELLED';
            const profit = isPending ? null : (isCancelled ? 0 : (isWin ? (t.profit || 0) : -t.amount));
            if (!isPending && !isCancelled) { totalTurnover += t.amount; totalProfit += profit; }
            const pair = t.signal?.pair || t.pair || 'UNKNOWN';
            const dir = t.signal?.direction || t.direction || '--';
            const date = new Date(t.createdAt).toLocaleString();
            const profitStr = isPending
                ? '<span style="color:var(--text-muted)">Pending...</span>'
                : (isCancelled ? '<span style="color:var(--text-muted)">0.00 USDT</span>' : `<span class="${profit >= 0 ? 'up' : 'down'}">${profit >= 0 ? '+' : ''}${profit.toFixed(2)} USDT</span>`);
            const statusColor = isWin ? 'up' : (isPending || isCancelled ? '' : 'down');
            const dirClass = dir === 'CALL' ? 'up' : 'down';
            const dirIcon = dir === 'CALL' ? '▲' : '▼';
            return `
                <div class="history-order" style="margin-bottom:8px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                        <span style="font-weight:600;font-size:13px;">${pair.replace(/[\s\/]/g, '')}</span>
                        <span class="${dirClass}" style="font-weight:600;">${dirIcon} ${dir}</span>
                    </div>
                    <div class="card-row"><span class="lbl">Entry Price</span><span class="val">${t.entryPrice ? Number(t.entryPrice).toFixed(4) : '--'}</span></div><div class="card-row"><span class="lbl">Close Price</span><span class="val">${t.closePrice ? Number(t.closePrice).toFixed(4) : '--'}</span></div><div class="card-row"><span class="lbl">Amount</span><span class="val">${t.amount.toFixed(2)} USDT</span></div>
                    <div class="card-row"><span class="lbl">Time</span><span class="val">${date}</span></div>
                    <div class="card-row"><span class="lbl">Status</span><span class="val ${statusColor}" style="font-weight:600;">${t.outcome}</span></div>
                    <div class="card-row"><span class="lbl">Profit/Loss</span><span class="val" style="font-weight:600;">${profitStr}</span></div>
                </div>`;
        }).join('');
        const rate = totalTurnover > 0 ? ((totalProfit / totalTurnover) * 100).toFixed(2) : '0.00';
        container.innerHTML = `
            <div class="history-summary">
                <div class="history-row"><span class="lbl">Turnover</span><span class="val">${totalTurnover.toFixed(2)}</span></div>
                <div class="history-row"><span class="lbl">Profit/Loss</span><span class="val ${totalProfit >= 0 ? 'up' : 'down'}">${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)}</span></div>
                <div class="history-row"><span class="lbl">Rate of return</span><span class="val">${rate}%</span></div>
            </div>
            ${rows}`;
    } catch (err) { }
}

async function fetchSignals() {
    if (!authToken) return;
    try {
        const res = await fetch('/api/signals', { headers: { 'Authorization': 'Bearer ' + authToken } });
        if (!res.ok) return;
        const data = await res.json();
        activeSignals = Array.isArray(data.signals) ? data.signals : [];
        if (data.tiers) {
            window.appTiers = data.tiers;
            renderVipTiers(data.tiers);
        }
        renderSignalCards();
    } catch (e) { }
}

function renderVipTiers(tiers) {
    const tbody = document.getElementById('vip-tiers-tbody');
    if (!tbody) return;

    // We expect tiers.t1, tiers.t2, etc. (up to t4 or higher)
    let html = '';
    const tierLimits = [
        { lv: 1, min: tiers.t1 || 500, label: '1 Signal / day' },
        { lv: 2, min: tiers.t2 || 1000, label: '2 Signals / day' },
        { lv: 3, min: tiers.t3 || 1500, label: '3 Signals / day' },
        { lv: 4, min: tiers.t4 || 2000, label: '4 Signals / day' }
    ];

    tierLimits.forEach(function (t, idx) {
        let max = tierLimits[idx + 1] ? tierLimits[idx + 1].min : '';
        html += `
        <tr>
            <td style="padding:5px;">LV${t.lv}</td>
            <td style="text-align:right;padding:5px;">$${t.min} ${max !== '' ? 'to $' + (max - 1) : 'and above'} <span style="display:block;font-size:10px;color:var(--accent);margin-top:2px;">(${t.label})</span></td>
        </tr>`;
    });

    tbody.innerHTML = html;

    const minLabel = document.getElementById('min-tier-label');
    if (minLabel && tiers.t1) minLabel.innerText = '$' + tiers.t1;
}

function fmtCountdown(seconds) {
    if (seconds <= 0) return '00:00';
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

function renderSignalCards() {
    var container = document.getElementById('signals-container');
    if (!container) return;
    if (!activeSignals || !activeSignals.length) {
        container.style.display = 'none';
        container.innerHTML = '';
        return;
    }
    container.style.display = 'block';
    container.innerHTML = activeSignals.map(function (sig) {
        var isCall = sig.direction === 'CALL';
        var dirColor = isCall ? 'var(--up-color)' : 'var(--down-color)';
        var dirIcon = isCall ? '▲' : '▼';
        return '<div class="signal-card" onclick="followSignal(\'' + sig.id + '\')" ' +
            'style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;margin-bottom:8px;border-radius:10px;background:var(--card2, #1e2530);border:1px solid var(--border, #2a3347);cursor:pointer;">' +
            '<div style="display:flex;flex-direction:column;gap:2px;">' +
                '<span style="font-weight:700;font-size:14px;">' + sig.pair + '</span>' +
                '<span style="font-size:11px;color:var(--text2,#888);">' + (sig.rewardPercentage ? sig.rewardPercentage + '% reward' : '') + (sig.suggestedAmount ? ' · Suggested $' + sig.suggestedAmount : '') + '</span>' +
            '</div>' +
            '<span style="display:flex;align-items:center;gap:6px;font-weight:700;color:' + dirColor + ';">' + dirIcon + ' ' + sig.direction + '</span>' +
        '</div>';
    }).join('');
}

function followSignal(signalId) {
    if (!authToken) { navTo('login-screen'); return; }
    const _totalBal = ((userData?.balance || 0) + (userData?.perpetualBalance || 0));
    const minTier1 = window.appTiers ? window.appTiers.t1 : 300;
    if (userData && _totalBal < minTier1) { showBalanceCriteria(); return; }
    var sig = activeSignals.find(function (s) { return s.id === signalId; });
    if (!sig) return;
    activeSignal = sig;

    var sym = sig.pair.replace(/[\\s\/]/g, '').replace('USDTUSDT', 'USDT');
    initChart(sym);
    switchTab('futures-screen');
    // Small delay so futures screen is visible before panel opens
    setTimeout(function () { openOrderPanel(sig.direction); }, 80);
    showToast('Signal: ' + sig.pair + ' ' + sig.direction + ' — enter amount and confirm!');
}

async function refreshUserData() {
    if (!authToken) return;
    try {
        const res = await fetch('/api/user/me', { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (res.status === 401 || res.status === 403) {
            doLogout();
            return;
        }
        if (!res.ok) return;
        const data = await res.json();
        userData = data;
        localStorage.setItem('user', JSON.stringify(userData));
        updateUIWithUserData();
    } catch (err) {
        console.error('Refresh error:', err);
    }
}

async function doLogin() {
    const identifier = document.getElementById('login-email').value.trim();

    const pass = document.getElementById('login-pass').value;
    if (!identifier || !pass) { showToast('Please enter credentials'); return; }

    const loginBtn = document.querySelector('#login-screen .btn-green-full');
    const originalText = loginBtn.textContent;
    loginBtn.disabled = true;
    loginBtn.textContent = 'Logging in...';

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: identifier, password: pass })
        });
        const data = await res.json();
        if (res.ok) {
            authToken = data.token;
            userData = data.user;
            localStorage.setItem('token', authToken);
            localStorage.setItem('user', JSON.stringify(userData));
            if (socket) socket.emit('authenticate', authToken);
            if (typeof showSuccessModal === 'function') {
                showSuccessModal('Login successful!');
            } else {
                showToast('Login successful!');
            }
            refreshUserData();
            fetchSignals();
            navTo('home-screen');
        } else {
            showToast(data.error || 'Login failed');
            if (data.error === 'Incorrect password') {
                document.getElementById('wrong-pass-overlay').style.display = 'flex';
            }
        }
    } catch (err) {
        showToast('Connection error');
    } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = originalText;
    }
}

async function doRegister() {
    const email = document.getElementById('reg-email')?.value?.trim();
    const code = document.getElementById('reg-code')?.value?.trim();
    const pass = document.getElementById('reg-pass')?.value;
    const confirm = document.getElementById('reg-confirm')?.value;
    const ref = document.getElementById('reg-invite')?.value?.trim();
    if (!email || !pass || !confirm) { showToast('Please fill all fields'); return; }
    if (!code) { showToast('Please enter the verification code'); return; }
    if (pass !== confirm) { showToast('Passwords do not match'); return; }
    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: pass, referralCode: ref, otp: code })
        });
        const data = await res.json();
        if (data.error) { showToast(data.error); return; }
        authToken = data.token;
        userData = data.user;
        localStorage.setItem('token', authToken);
        localStorage.setItem('user', JSON.stringify(userData));
        if (socket) socket.emit('authenticate', authToken);
        showToast('Registration successful!');
        refreshUserData();
        fetchSignals();
        navTo('home-screen');
    } catch (err) { showToast('Server error'); }
}

async function doForgotPassword() {
    const email = document.getElementById('forgot-email')?.value?.trim();
    if (!email) { showToast('Please enter your email'); return; }
    try {
        const res = await fetch('/api/auth/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const data = await res.json();
        if (data.error) { showToast(data.error); return; }
        document.getElementById('forgot-token-display').textContent = email;
        document.getElementById('reset-token-input').value = '';
        document.getElementById('forgot-step1').style.display = 'none';
        document.getElementById('forgot-step2').style.display = 'block';
        showToast('Reset code sent to your email');
    } catch (err) { showToast('Server error. Try again.'); }
}

async function doResetPassword() {
    const token = document.getElementById('reset-token-input')?.value?.trim();
    const newPass = document.getElementById('reset-new-pass')?.value;
    if (!token || !newPass) { showToast('Please fill all fields'); return; }
    if (newPass.length < 6) { showToast('Password must be at least 6 characters'); return; }
    try {
        const res = await fetch('/api/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, newPassword: newPass })
        });
        const data = await res.json();
        if (data.error) { showToast(data.error); return; }
        showToast('Password reset successfully! Please login.');
        document.getElementById('forgot-step1').style.display = 'block';
        document.getElementById('forgot-step2').style.display = 'none';
        navTo('login-screen');
    } catch (err) { showToast('Server error. Try again.'); }
}

function showBindAddrTip() {
    const el = document.getElementById('bind-addr-tip-overlay');
    if (el) el.style.display = 'flex';
}
function closeBindAddrTip() {
    const el = document.getElementById('bind-addr-tip-overlay');
    if (el) el.style.display = 'none';
}

async function doWithdrawal() {
    if (!authToken) { showToast('Please login first'); navTo('login-screen'); return; }
    const bound = localStorage.getItem('boundWithdrawAddress');
    // showBindAddrTip() alone gave zero feedback if that overlay ever failed
    // to render — a toast now fires either way so a tap on Submit is never
    // silently a no-op.
    if (!bound) { showToast('Please bind a withdrawal address first'); showBindAddrTip(); return; }
    // Frontend freeze check (backend also enforces this)
    const freezeUntil = localStorage.getItem('withdrawFreezeUntil');
    if (freezeUntil && new Date() < new Date(freezeUntil)) {
        const remaining = Math.ceil((new Date(freezeUntil) - new Date()) / 3600000);
        showToast(`Withdrawals frozen for ${remaining} more hour(s) after address change.`);
        return;
    }
    const amount = parseFloat(document.getElementById('withdrawal-amount')?.value);
    if (!amount || amount <= 0) { showToast('Please enter a valid amount'); return; }
    if (userData && amount > userData.balance) { showToast('Insufficient balance'); return; }

    // 2FA gate: if the account has Google Authenticator enabled, require a
    // fresh code before submitting; if not set up yet, send them to set it
    // up instead of letting the withdrawal go through unprotected.
    let twoFaEnabled = false;
    try {
        const statusRes = await fetch('/api/auth/2fa/status', { headers: { 'Authorization': `Bearer ${authToken}` } });
        const statusData = await statusRes.json();
        twoFaEnabled = !!statusData.enabled;
    } catch (e) { /* if the status check itself fails, fall through treating 2FA as not enabled */ }

    if (!twoFaEnabled) {
        showConfirmSetup2fa();
        return;
    }

    show2faCodePrompt(async (code) => {
        await submitWithdrawal(amount, code);
    });
}

async function submitWithdrawal(amount, code) {
    try {
        const res = await fetch('/api/wallet/withdraw', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ amount, code })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Withdrawal failed'); return; }
        showToast('Withdrawal submitted successfully!');
        document.getElementById('withdrawal-amount').value = '';
        refreshUserData();
    } catch (err) { showToast('Withdrawal failed'); }
}

function showConfirmSetup2fa() {
    let modal = document.getElementById('setup-2fa-popup');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'setup-2fa-popup';
        modal.style.cssText = 'display:flex;position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.55);align-items:center;justify-content:center;padding:24px;';
        modal.innerHTML = `
        <div style="background:#11100e;border-radius:18px;max-width:340px;width:100%;padding:24px 20px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,0.25);">
            <div style="width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,#4c1d95,#8b5cf6);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;">
                <i class="fa-solid fa-shield-halved" style="color:#fff;font-size:20px;"></i>
            </div>
            <div style="font-size:15px;font-weight:700;color:#f5f1e8;margin-bottom:10px;">Set Up Google Authenticator</div>
            <div style="font-size:13px;color:#6b7280;line-height:1.6;margin-bottom:20px;">For your security, withdrawals require Google Authenticator. Set it up first, then try again.</div>
            <button onclick="closeConfirmSetup2fa(); navTo('google-auth-screen');" style="width:100%;padding:13px;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;background:linear-gradient(135deg,#4c1d95,#8b5cf6);color:#fff;margin-bottom:10px;">Set Up Now</button>
            <button onclick="closeConfirmSetup2fa()" style="width:100%;padding:13px;border:none;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;background:#1a1814;color:#6b7280;">Cancel</button>
        </div>`;
        document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
}
function closeConfirmSetup2fa() {
    const modal = document.getElementById('setup-2fa-popup');
    if (modal) modal.style.display = 'none';
}

function show2faCodePrompt(onSubmit) {
    let modal = document.getElementById('2fa-code-popup');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = '2fa-code-popup';
        modal.style.cssText = 'display:flex;position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.55);align-items:center;justify-content:center;padding:24px;';
        modal.innerHTML = `
        <div style="background:#11100e;border-radius:18px;max-width:340px;width:100%;padding:24px 20px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,0.25);">
            <div style="width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,#4c1d95,#8b5cf6);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;">
                <i class="fa-solid fa-shield-halved" style="color:#fff;font-size:20px;"></i>
            </div>
            <div style="font-size:15px;font-weight:700;color:#f5f1e8;margin-bottom:14px;">Enter Authenticator Code</div>
            <input type="text" id="2fa-code-input" inputmode="numeric" maxlength="6" placeholder="000000" style="width:100%;padding:13px;border:1.5px solid rgba(139,92,246,0.25);border-radius:12px;font-size:20px;font-weight:700;text-align:center;letter-spacing:6px;margin-bottom:16px;outline:none;">
            <button id="2fa-code-submit-btn" style="width:100%;padding:13px;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;background:linear-gradient(135deg,#4c1d95,#8b5cf6);color:#fff;margin-bottom:10px;">Confirm</button>
            <button onclick="close2faCodePrompt()" style="width:100%;padding:13px;border:none;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;background:#1a1814;color:#6b7280;">Cancel</button>
        </div>`;
        document.body.appendChild(modal);
    }
    const input = document.getElementById('2fa-code-input');
    const btn = document.getElementById('2fa-code-submit-btn');
    input.value = '';
    btn.onclick = async () => {
        const code = input.value.trim();
        if (!code || code.length !== 6) { showToast('Enter the 6-digit code'); return; }
        btn.textContent = 'Verifying...';
        btn.style.pointerEvents = 'none';
        close2faCodePrompt();
        await onSubmit(code);
        btn.textContent = 'Confirm';
        btn.style.pointerEvents = 'auto';
    };
    modal.style.display = 'flex';
    input.focus();
}
function close2faCodePrompt() {
    const modal = document.getElementById('2fa-code-popup');
    if (modal) modal.style.display = 'none';
}

function doLogout() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    authToken = null;
    userData = null;
    if (socket) { socket.disconnect(); socket = null; }
    if (apexChart) { try { apexChart.destroy(); } catch (e) { } apexChart = null; }
    showToast('Logged out');
    _showScreen('login-screen');
}

async function doChangePassword() {
    if (!authToken) { showToast('Please login first'); return; }
    const oldPass = document.getElementById('cp-old')?.value;
    const newPass = document.getElementById('cp-new')?.value;
    const confirmPass = document.getElementById('cp-confirm')?.value;
    if (!oldPass || !newPass || !confirmPass) { showToast('Please fill all fields'); return; }
    if (newPass !== confirmPass) { showToast('New passwords do not match'); return; }
    if (newPass.length < 6) { showToast('Password must be at least 6 characters'); return; }
    try {
        const res = await fetch('/api/user/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ oldPassword: oldPass, newPassword: newPass })
        });
        const data = await res.json();
        if (data.error) { showToast(data.error); return; }
        showToast('Password changed successfully!');
        document.getElementById('cp-old').value = '';
        document.getElementById('cp-new').value = '';
        document.getElementById('cp-confirm').value = '';
    } catch (err) { showToast('Failed to change password'); }
}

function showTermsConditions() {
    let overlay = document.getElementById('terms-conditions-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'terms-conditions-overlay';
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100vw';
        overlay.style.height = '100vh';
        overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.zIndex = '999999';

        const box = document.createElement('div');
        box.style.background = '#1a1b20';
        box.style.padding = '30px';
        box.style.borderRadius = '12px';
        box.style.textAlign = 'center';
        box.style.maxWidth = '80%';
        box.style.width = '320px';
        box.style.color = '#fff';
        box.style.boxShadow = '0 10px 25px rgba(0,0,0,0.5)';
        box.style.border = '1px solid #333';

        const icon = document.createElement('div');
        icon.innerHTML = '⚠️';
        icon.style.fontSize = '45px';
        icon.style.marginBottom = '15px';

        const text = document.createElement('div');
        text.innerText = 'You are crossing terms and conditions.';
        text.style.fontSize = '18px';
        text.style.marginBottom = '25px';
        text.style.lineHeight = '1.4';
        text.style.fontWeight = 'bold';

        const btn = document.createElement('button');
        btn.innerText = 'OK';
        btn.style.background = '#00c853';
        btn.style.color = '#fff';
        btn.style.border = 'none';
        btn.style.padding = '12px 30px';
        btn.style.borderRadius = '6px';
        btn.style.cursor = 'pointer';
        btn.style.fontWeight = 'bold';
        btn.style.fontSize = '16px';
        btn.style.width = '100%';
        btn.onclick = () => overlay.remove();

        box.appendChild(icon);
        box.appendChild(text);
        box.appendChild(btn);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    }
}

async function placeOrder() {
    if (!authToken) { showToast('Please login first'); return; }
    const amount = parseFloat(document.getElementById('order-amount')?.value);
    if (!amount || amount <= 0) { showToast('Please enter a valid amount'); return; }
    if (userData && amount > (userData.perpetualBalance || 0)) { showToast('Insufficient balance'); return; }

    const actionBtn = document.getElementById('order-action-btn');
    if (actionBtn) { actionBtn.textContent = 'Placing...'; actionBtn.disabled = true; }
    await new Promise(function (r) { setTimeout(r, 400); });

    // Auto-detect matching signal if user manually places trade on same pair+direction → 100% HIT
    if (!activeSignal) {
        let sym = chartState.sym || (currentPair.replace(/[\s\/]/g, '').replace('USDTUSDT', 'USDT').replace(/\s+/g, '').toUpperCase());
        if (!sym.endsWith('USDT')) sym += 'USDT';
        // Match by pair (strip spaces/slashes). If a signal is active on this pair, enforce signal rules.
        const matchingSignal = activeSignals.find(s => s.status === 'ACTIVE' &&
            s.pair.replace(/[\s\/]/g, '').replace('USDTUSDT', 'USDT').toUpperCase() === sym.toUpperCase());
        if (matchingSignal) {
            activeSignal = matchingSignal; // route to signal trade = 100% WIN
        }
    }

    // Following a signal → backend trade (real balance deduction)
    if (activeSignal) {
        const _tot = ((userData?.balance || 0) + (userData?.perpetualBalance || 0));
        // Add 0.01 margin to account for floating point and rounding up (e.g. 5.29 vs 5.2858)
        if (amount > (_tot * 0.01) + 0.01) {
            if (actionBtn) { actionBtn.disabled = false; actionBtn.textContent = currentOrderDir; }
            closeOrderPanel();
            showTermsConditions();
            return;
        }

        const minTier1 = window.appTiers ? window.appTiers.t1 : 300;
        if (userData && _tot < minTier1) {
            if (actionBtn) { actionBtn.disabled = false; actionBtn.textContent = currentOrderDir; }
            closeOrderPanel();
            showBalanceCriteria();
            return;
        }
        try {
            const res = await fetch('/api/signals/trade', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                body: JSON.stringify({
                    signalId: activeSignal.id,
                    amount: amount,
                    direction: currentOrderDir,
                    entryPrice: parseFloat((allCoins.find(c => c.sym === (activeSignal.pair.replace('/USDT', '').replace('USDT', '').toUpperCase())) || allCoins[0])?.price?.toString()?.replace(/,/g, '') || '0')
                })
            });
            const data = await res.json();
            if (actionBtn) { actionBtn.disabled = false; actionBtn.textContent = currentOrderDir; }
            if (data.error) { showToast(data.error); return; }
            closeOrderPanel();
            showToast(currentOrderDir + ' trade placed! ' + amount + ' USDT on ' + activeSignal.pair);
            refreshUserData();
            renderActivePositions();
            // Switch to position tab so user sees their active trade
            var posBtn = document.querySelector('#futures-pos-tabs button[onclick*="position"]');
            if (posBtn) posBtn.click();
        } catch (err) {
            if (actionBtn) { actionBtn.disabled = false; actionBtn.textContent = currentOrderDir; }
            showToast('Trade failed. Please try again.');
        }
        return;
    }

    // Manual Trade
    const sym = chartState.sym || (currentPair.replace(/[\\s\/]/g, '').replace('USDTUSDT', 'USDT').replace(/\s+/g, '').toUpperCase());
    try {
        const res = await fetch('/api/signals/manual-trade', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ pair: sym, amount: amount, direction: currentOrderDir, duration: 600, entryPrice: parseFloat((allCoins.find(c => c.sym === sym.replace('USDT', '')) || allCoins[0]).price.toString().replace(/,/g, '')) })
        });
        const data = await res.json();
        if (actionBtn) { actionBtn.disabled = false; actionBtn.textContent = currentOrderDir; }
        if (data.error) { showToast('Trade failed: ' + data.error); return; }
        closeOrderPanel();
        showToast(currentOrderDir + ' trade placed! ' + amount + ' USDT (Manual)');
        refreshUserData();
        await renderActivePositions();
        await loadTradeHistory();
        var posBtn = document.querySelector('#futures-pos-tabs button[onclick*="position"]');
        if (posBtn) posBtn.click();
    } catch (err) {
        if (actionBtn) { actionBtn.disabled = false; actionBtn.textContent = currentOrderDir; }
        showToast('Trade failed. Please try again.');
    }
}

async function doInvest(amount) {
    if (!authToken) { showToast('Please login first'); return; }
    try {
        const res = await fetch('/api/wallet/invest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ amount })
        });
        const data = await res.json();
        if (data.error) { showToast(data.error); return; }
        showToast('Investment successful!');
        refreshUserData();
    } catch (err) { showToast('Investment failed'); }
}

function copyRefLink() {
    if (window.currentReferralLink) {
        copyText(window.currentReferralLink);
    }
}

// ── KYC ──
let kycData = null;

async function loadKycStatus() {
    if (!authToken) return;
    try {
        const res = await fetch('/api/kyc/status', { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (!res.ok) return;
        kycData = await res.json();
        updateKycUI();
    } catch (e) { }
}

function updateKycUI() {
    const status = (kycData && kycData.status) ? kycData.status : 'NONE';
    const statusMap = { NONE: 'Not Submitted', PENDING: 'Under Review', APPROVED: 'Verified ✓', REJECTED: 'Rejected' };
    const colorMap = { NONE: 'var(--text-secondary)', PENDING: '#f3ba2f', APPROVED: 'var(--up-color)', REJECTED: 'var(--down-color)' };

    const basicEl = document.getElementById('basic-kyc-status');

    if (basicEl) {
        if (!kycData || !kycData.fullName || status === 'NONE') {
            basicEl.textContent = 'Not Certified';
            basicEl.style.color = 'rgba(255, 255, 255, 0.9)';
        } else if (status === 'PENDING') {
            basicEl.textContent = 'Under Review';
            basicEl.style.color = '#ffffff';
        } else if (status === 'APPROVED') {
            basicEl.textContent = 'Verified ✓';
            basicEl.style.color = '#ffffff';
        } else {
            basicEl.textContent = 'Rejected';
            basicEl.style.color = '#ffcccc';
        }
    }

    // Update basic verification screen
    const banner = document.getElementById('basic-kyc-status-banner');
    if (banner) {
        if (status === 'PENDING') {
            banner.style.display = 'block'; banner.textContent = 'Under Review — Your application is being reviewed.';
            banner.style.background = 'rgba(243,186,47,0.1)'; banner.style.color = '#f3ba2f';
        } else if (status === 'APPROVED') {
            banner.style.display = 'block'; banner.textContent = 'Verified — Your identity has been successfully verified.';
            banner.style.background = 'rgba(2,192,118,0.1)'; banner.style.color = 'var(--up-color)';
        } else if (status === 'REJECTED') {
            banner.style.display = 'block'; banner.textContent = 'Rejected: ' + (kycData.rejectReason || 'Please resubmit.');
            banner.style.background = 'rgba(248,73,96,0.1)'; banner.style.color = 'var(--down-color)';
        } else { banner.style.display = 'none'; }
    }

    // Pre-fill form if data exists
    if (kycData.fullName) {
        const fn = document.getElementById('kyc-fullname');
        const cn = document.getElementById('kyc-country');
        const id = document.getElementById('kyc-idnumber');
        if (fn) fn.value = kycData.fullName;
        if (cn && kycData.country) cn.value = kycData.country;
        if (id && kycData.idNumber) id.value = kycData.idNumber;
    }
}

function previewKycFile(inputId, previewId) {
    const input = document.getElementById(inputId);
    const preview = document.getElementById(previewId);
    if (!input || !preview || !input.files[0]) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        preview.innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;">`;
    };
    reader.readAsDataURL(input.files[0]);
}

// Downscales/re-encodes an image client-side before upload (max 1280px on
// the long edge, JPEG q=0.75) so a 10-20MB phone-camera photo doesn't get
// sent as-is. Falls back to the original file if compression fails for any
// reason (e.g. non-image type) rather than blocking the upload.
function compressImage(file, maxDim = 1280, quality = 0.75) {
    return new Promise((resolve) => {
        if (!file || !file.type || !file.type.startsWith('image/')) return resolve(file);
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            let { width, height } = img;
            if (width > maxDim || height > maxDim) {
                const scale = maxDim / Math.max(width, height);
                width = Math.round(width * scale);
                height = Math.round(height * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            canvas.toBlob((blob) => {
                URL.revokeObjectURL(url);
                if (!blob) return resolve(file);
                resolve(new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' }));
            }, 'image/jpeg', quality);
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
        img.src = url;
    });
}

// Single combined submit — the form fields (name/ID/country) and the three
// document photos used to be two separate screens/submits ("Basic" then
// "Advanced Verification"); now it's one screen and one button, calling
// both existing backend endpoints (which both upsert the same KYC row, so
// calling them back-to-back here is safe) instead of forcing a second step.
async function submitFullKyc() {
    if (!authToken) return showToast('Please login first');
    const fullName = document.getElementById('kyc-fullname')?.value?.trim();
    const country = document.getElementById('kyc-country')?.value?.trim();
    const idNumber = document.getElementById('kyc-idnumber')?.value?.trim();
    if (!fullName || !idNumber) { showToast('Please fill all required fields'); return; }

    const selfie = document.getElementById('kyc-selfie')?.files[0];
    const idFront = document.getElementById('kyc-idfront')?.files[0];
    const idBack = document.getElementById('kyc-idback')?.files[0];

    try {
        const res = await fetch('/api/kyc/basic', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ fullName, idNumber, country })
        });
        const data = await res.json();
        if (data.error) { showToast(data.error); return; }
        kycData = data.kyc;

        if (selfie || idFront || idBack) {
            const formData = new FormData();
            if (selfie) formData.append('selfie', await compressImage(selfie));
            if (idFront) formData.append('idFront', await compressImage(idFront));
            if (idBack) formData.append('idBack', await compressImage(idBack));
            const res2 = await fetch('/api/kyc/upload', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${authToken}` },
                body: formData
            });
            const data2 = await res2.json();
            if (data2.error) { showToast(data2.error); return; }
            kycData = data2.kyc;
        }

        updateKycUI();
        showToast('Verification submitted successfully!');
    } catch (e) { showToast('Submission failed'); }
}

// ── WITHDRAWAL RECORDS ──
async function loadWithdrawalRecords() {
    const container = document.getElementById('withdrawal-records-list');
    if (!container || !authToken) return;
    container.innerHTML = '<div class="no-data-block" style="padding-top:40px;"><p>Loading...</p></div>';
    try {
        const res = await fetch('/api/wallet/withdrawals', { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (!res.ok) return;
        const txs = await res.json();
        if (!txs.length) {
            container.innerHTML = '<div class="no-data-block" style="padding-top:60px;"><i class="fa-solid fa-receipt" style="font-size:40px;color:var(--text-muted);margin-bottom:12px;"></i><p>No withdrawal records</p></div>';
            return;
        }
        const statusClass = {
            pending: 'pending-status', PENDING: 'pending-status',
            completed: 'paid-status', COMPLETED: 'paid-status',
            failed: 'fail-status', FAILED: 'fail-status',
            rejected: 'fail-status', REJECTED: 'fail-status'
        };
        const statusLabel = {
            pending: 'Under Audit', PENDING: 'Under Audit',
            completed: 'Paid', COMPLETED: 'Paid',
            failed: 'Failed', FAILED: 'Failed',
            rejected: 'Rejected', REJECTED: 'Rejected'
        };
        window._txData = window._txData || {};
        container.innerHTML = txs.map(tx => {
            window._txData[tx.id] = tx;
            return `
            <div class="record-item" onclick="showWithdrawalDetails('${tx.id}')">
                <div class="record-left">
                    <div class="record-title">Withdrawal</div>
                    <div class="record-time">${new Date(tx.requestedAt || tx.createdAt).toLocaleString()}</div>
                </div>
                <div class="record-right">
                    <div class="record-coin">${tx.amount.toFixed(2)} USDT</div>
                    <div class="record-status ${statusClass[tx.status] || 'pending-status'}">${statusLabel[tx.status] || tx.status.toUpperCase()}</div>
                </div>
            </div>
        `}).join('');
    } catch (e) { }
}

async function loadDepositRecords() {
    const container = document.getElementById('deposit-records-list');
    if (!container || !authToken) return;
    container.innerHTML = '<div class="no-data-block" style="padding-top:40px;"><p>Loading...</p></div>';
    try {
        const res = await fetch('/api/wallet/deposits', { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (!res.ok) return;
        const deps = await res.json();
        if (!deps.length) {
            container.innerHTML = '<div class="no-data-block" style="padding-top:60px;"><i class="fa-solid fa-receipt" style="font-size:40px;color:var(--text-muted);margin-bottom:12px;"></i><p>No deposit records</p></div>';
            return;
        }
        const statusClass = {
            pending_approval: 'pending-status',
            confirmed: 'paid-status', CONFIRMED: 'paid-status',
            rejected: 'fail-status', REJECTED: 'fail-status'
        };
        const statusLabel = {
            pending_approval: 'Under Audit',
            confirmed: 'Confirmed', CONFIRMED: 'Confirmed',
            rejected: 'Rejected', REJECTED: 'Rejected'
        };
        window._depositData = window._depositData || {};
        container.innerHTML = deps.map(dep => {
            window._depositData[dep.id] = dep;
            return `
            <div class="record-item" onclick="showDepositDetails('${dep.id}')">
                <div class="record-left">
                    <div class="record-title">Deposit</div>
                    <div class="record-time">${new Date(dep.detectedAt || dep.createdAt).toLocaleString()}</div>
                </div>
                <div class="record-right">
                    <div class="record-coin">${dep.amount.toFixed(2)} ${dep.currency || 'USDT'}</div>
                    <div class="record-status ${statusClass[dep.status] || 'pending-status'}">${statusLabel[dep.status] || dep.status.toUpperCase()}</div>
                </div>
            </div>
        `}).join('');
    } catch (e) { }
}

function showDepositDetails(depId) {
    const dep = (window._depositData || {})[depId];
    if (!dep) return;

    let modal = document.getElementById('deposit-details-screen');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'deposit-details-screen';
        modal.className = 'screen full-page';
        modal.style.zIndex = '1000';
        modal.innerHTML = `
        <div class="sub-header">
            <i class="fa-solid fa-chevron-left back-btn" onclick="closeDepositDetails()"></i>
            <h2>Deposit details</h2>
            <span></span>
        </div>
        <div style="padding:20px;">
            <div style="border-radius:12px;padding:20px;border-top:1px solid rgba(255,255,255,0.05);">
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Time:</span>
                    <span id="dep-time" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Deposit amount:</span>
                    <span id="dep-amount" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Currency:</span>
                    <span id="dep-currency" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;align-items:flex-start;">
                    <span style="color:var(--text-secondary);font-size:14px;white-space:nowrap;margin-right:16px;">From address:</span>
                    <span id="dep-from" style="color:var(--text-primary);font-size:14px;font-weight:500;word-break:break-all;text-align:right;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;align-items:flex-start;">
                    <span style="color:var(--text-secondary);font-size:14px;white-space:nowrap;margin-right:16px;">Tx hash:</span>
                    <span id="dep-txhash" style="color:var(--text-primary);font-size:14px;font-weight:500;word-break:break-all;text-align:right;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Status:</span>
                    <span id="dep-status" style="font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;">
                    <span style="color:var(--text-secondary);font-size:14px;">Reason:</span>
                    <span id="dep-reason" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
            </div>
        </div>`;
        document.body.appendChild(modal);
    }

    const d = new Date(dep.detectedAt || dep.createdAt);
    document.getElementById('dep-time').textContent = d.toLocaleString();
    document.getElementById('dep-amount').textContent = dep.amount.toFixed(2) + ' ' + (dep.currency || 'USDT');
    document.getElementById('dep-currency').textContent = dep.currency || 'USDT';
    document.getElementById('dep-from').textContent = dep.fromAddress || '--';
    document.getElementById('dep-txhash').textContent = dep.txHash || '--';

    const statusLabel = { pending_approval: 'Under Audit', confirmed: 'Confirmed', rejected: 'Rejected' };
    const statusColor = { pending_approval: 'var(--text-secondary)', confirmed: 'var(--up-color)', rejected: 'var(--down-color)' };
    const statusEl = document.getElementById('dep-status');
    statusEl.textContent = statusLabel[dep.status] || dep.status.toUpperCase();
    statusEl.style.color = statusColor[dep.status] || 'var(--text-secondary)';

    document.getElementById('dep-reason').textContent = dep.rejectionReason || '-';

    modal.style.display = 'block';
}

function closeDepositDetails() {
    const modal = document.getElementById('deposit-details-screen');
    if (modal) modal.style.display = 'none';
}

function showWithdrawalDetails(txId) {
    const tx = window._txData[txId];
    if (!tx) return;
    
    let modal = document.getElementById('withdrawal-details-screen');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'withdrawal-details-screen';
        modal.className = 'screen full-page';
        modal.style.zIndex = '1000';
        modal.innerHTML = `
        <div class="sub-header">
            <i class="fa-solid fa-chevron-left back-btn" onclick="closeWithdrawalDetails()"></i>
            <h2>Withdrawal details</h2>
            <span></span>
        </div>
        <div style="padding:20px;">
            <div style="border-radius:12px;padding:20px;border-top:1px solid rgba(255,255,255,0.05);">
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Time:</span>
                    <span id="wd-time" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Withdrawal amount:</span>
                    <span id="wd-amount" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Handling fee (8%):</span>
                    <span id="wd-fee" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Actual Amount:</span>
                    <span id="wd-actual" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Chain name:</span>
                    <span id="wd-chain" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;align-items:flex-start;">
                    <span style="color:var(--text-secondary);font-size:14px;white-space:nowrap;margin-right:16px;">Address:</span>
                    <span id="wd-address" style="color:var(--text-primary);font-size:14px;font-weight:500;word-break:break-all;text-align:right;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Status:</span>
                    <span id="wd-status" style="font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;">
                    <span style="color:var(--text-secondary);font-size:14px;">Reason:</span>
                    <span id="wd-reason" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
            </div>
        </div>`;
        document.body.appendChild(modal);
    }
    
    const d = new Date(tx.requestedAt || tx.createdAt);
    const dateStr = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')} (UTC+5)`;
    document.getElementById('wd-time').textContent = dateStr;
    
    const fmt = num => Number.isInteger(num) ? num : num.toFixed(2);
    
    document.getElementById('wd-amount').textContent = fmt(tx.amount) + ' USDT';
    
    const handlingFee = tx.amount * 0.08;
    document.getElementById('wd-fee').textContent = fmt(handlingFee) + ' USDT';
    
    const actualAmount = tx.amount - handlingFee;
    document.getElementById('wd-actual').textContent = fmt(actualAmount) + ' USDT';
    
    document.getElementById('wd-chain').textContent = tx.chain || 'TRC20';
    document.getElementById('wd-address').textContent = tx.toAddress || tx.address || localStorage.getItem('boundWithdrawAddress') || '--';
    
    const statusLabel = {
        pending: 'Under Audit', PENDING: 'Under Audit',
        completed: 'Paid', COMPLETED: 'Paid',
        failed: 'Failed', FAILED: 'Failed',
        rejected: 'Rejected', REJECTED: 'Rejected'
    };
    const statusClass = {
        pending: 'var(--text-secondary)', PENDING: 'var(--text-secondary)',
        completed: 'var(--up-color)', COMPLETED: 'var(--up-color)',
        failed: 'var(--down-color)', FAILED: 'var(--down-color)',
        rejected: 'var(--down-color)', REJECTED: 'var(--down-color)'
    };
    
    const statusEl = document.getElementById('wd-status');
    statusEl.textContent = statusLabel[tx.status] || tx.status.toUpperCase();
    statusEl.style.color = statusClass[tx.status] || 'var(--text-secondary)';
    
    document.getElementById('wd-reason').textContent = tx.rejectReason || '-';
    
    modal.style.display = 'block';
}

function closeWithdrawalDetails() {
    const modal = document.getElementById('withdrawal-details-screen');
    if (modal) {
        modal.style.display = 'none';
    }
}

// ── PERPETUAL PAIR PICKER ──
const PERP_PAIRS = ['ETH/USDT', 'BTC/USDT', 'DASH/USDT', 'FIL/USDT', 'LINK/USDT', 'LTC/USDT', 'TRX/USDT', 'XRP/USDT', 'ZEC/USDT', 'YFI/USDT', 'BCH/USDT'];
let currentPerpPair = 'BTC/USDT';
window._currentPerpPair = 'BTC/USDT';
let currentPerpSide = 'long';
let selectedChainType = 'TRC20';

function showPerpPairPicker() {
    var list = document.getElementById('perp-pair-list');
    if (list) {
        list.innerHTML = PERP_PAIRS.map(p => '<div class="perp-pair-item' + (p === currentPerpPair ? ' selected' : '') + '" onclick="selectPerpPair(\'' + p + '\')">' + p.replace('/', ' / ') + '</div>').join('');
    }
    var overlay = document.getElementById('perp-pair-picker-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closePerpPairPicker() {
    var overlay = document.getElementById('perp-pair-picker-overlay');
    if (overlay) overlay.style.display = 'none';
}

function selectPerpPair(pair) {
    currentPerpPair = pair;
    window._currentPerpPair = pair;
    var nameEl = document.getElementById('perp-pair-name');
    var chartNameEl = document.getElementById('perp-chart-pair-name');
    if (nameEl) nameEl.textContent = pair + ' Perpetual';
    if (chartNameEl) chartNameEl.textContent = pair + ' Perpetual';
    _perpSmoothPrice = 0;
    closePerpPairPicker();

    // Fetch real price from Binance for this pair
    var binanceSym = pair.replace(/[\\s\/]/g, '').replace('USDTUSDT', 'USDT').replace(/\s+/g, '').toUpperCase();
    fetch('/api/mexc/ticker/price?symbol=' + binanceSym)
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (d && d.price) {
                var p = parseFloat(d.price);
                if (p > 0) {
                    _perpSmoothPrice = p;
                    var coin = (window.allCoins || []).find(function (c) { return c.sym === pair.split('/')[0]; });
                    if (coin) coin.price = p.toLocaleString();
                    renderPerpOrderBook();
                }
            }
        }).catch(function () { });

    renderPerpOrderBook();

    // If chart screen is open, reload chart for new pair
    if (currentScreen === 'perp-chart-screen') {
        var activeTf = document.querySelector('#perp-chart-timeframes button.active');
        initPerpDetailChart(binanceSym, activeTf ? activeTf.dataset.tf || '1h' : '1h');
    }
}

function setPerpSide(side) {
    currentPerpSide = side;
    var longTab = document.getElementById('perp-long-tab');
    var shortTab = document.getElementById('perp-short-tab');
    var btn = document.getElementById('perp-buy-btn');
    if (side === 'long') {
        if (longTab) longTab.className = 'perp-ls-btn long-active';
        if (shortTab) shortTab.className = 'perp-ls-btn';
        if (btn) { btn.textContent = 'Buy Long'; btn.className = 'perp-action-btn long-btn'; }
    } else {
        if (longTab) longTab.className = 'perp-ls-btn';
        if (shortTab) shortTab.className = 'perp-ls-btn short-active';
        if (btn) { btn.textContent = 'Buy Short'; btn.className = 'perp-action-btn short-btn'; }
    }
}

function selectPerpOrderType(type) {
    var lbl = document.getElementById('perp-order-type-label');
    var dd = document.getElementById('perp-order-type-dd');
    var priceEl = document.getElementById('perp-form-price');
    if (lbl) lbl.textContent = type;
    if (dd) dd.style.display = 'none';
    if (priceEl) priceEl.style.display = type === 'Market' ? 'none' : 'block';
}

function adjPerpQty(dir) {
    var inp = document.getElementById('perp-qty-input');
    if (inp) { var v = parseFloat(inp.value) || 0; inp.value = Math.max(0, v + dir).toFixed(2); }
}

function setPerpQtyPct(pct) {
    const avail = parseFloat(document.getElementById('perp-avail-amt')?.textContent || '0');
    const qty = ((avail * pct) / 100).toFixed(2);
    const input = document.getElementById('perp-qty-input');
    if (input) input.value = qty;
    // Highlight active button
    document.querySelectorAll('.perp-pct-row button:not(.pct-locked)').forEach(b => b.classList.remove('pct-active'));
    const activeBtn = document.getElementById('pct-btn-' + pct);
    if (activeBtn) activeBtn.classList.add('pct-active');
    showToast(pct + '% selected');
}

// Tier unlock system — checks if user balance meets threshold to unlock pct
async function checkPctTier(pct, btnId) {
    // Tier thresholds (USDT balance required to unlock)
    const tiers = { 25: 100, 50: 500, 75: 1000, 100: 2000 };
    const required = tiers[pct] || 9999;
    const balance = parseFloat(userData?.balance || 0) + parseFloat(userData?.perpetualBalance || 0);

    // Check backend tier setting
    try {
        const res = await fetch('/api/user/me', { headers: { Authorization: 'Bearer ' + authToken } });
        const data = await res.json();
        const tierLevel = data?.user?.tierLevel || 0;
        const tierMap = { 1: 25, 2: 50, 3: 75, 4: 100 };
        const maxPct = tierMap[tierLevel] || 1;

        if (pct <= maxPct || balance >= required) {
            // Unlock this button
            const btn = document.getElementById(btnId);
            if (btn) {
                btn.classList.remove('pct-locked');
                btn.textContent = pct + '%';
                btn.setAttribute('onclick', `setPerpQtyPct(${pct})`);
                setPerpQtyPct(pct);
            }
        } else {
            showToast(`Deposit $${required} USDT to unlock ${pct}% trading`);
        }
    } catch(e) {
        if (balance >= required) {
            setPerpQtyPct(pct);
        } else {
            showToast(`Deposit $${required} USDT to unlock ${pct}% trading`);
        }
    }
}

async function placePerpOrder() {
    if (!authToken) { showToast('Please login first'); navTo('login-screen'); return; }
    const qty = document.getElementById('perp-qty-input')?.value?.trim();
    const accessCode = document.getElementById('perp-access-code')?.value?.trim().toUpperCase() || '';
    if (!qty || parseFloat(qty) <= 0) { showToast('Please enter quantity'); return; }

    // Find active signal for current pair
    const pairSym = (window._currentPerpPair || 'BTC/USDT');
    const btn = document.getElementById('perp-buy-btn');
    const side = btn?.textContent?.includes('Short') ? 'PUT' : 'CALL';

    // Try to find a matching active signal
    try {
        const res = await fetch('/api/signals', { headers: { Authorization: 'Bearer ' + authToken } });
        const data = await res.json();
        const signals = data.signals || data || [];
        const activeSignal = signals.find(s => s.status === 'ACTIVE' && s.pair && pairSym.includes(s.pair.split('/')[0]));

        if (activeSignal) {
            // Place signal trade with access code
            const tradeRes = await fetch('/api/signals/trade', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
                body: JSON.stringify({
                    signalId: activeSignal.id,
                    amount: parseFloat(qty),
                    direction: side,
                    entryPrice: parseFloat(allCoins.find(c => c.sym === pairSym.split('/')[0])?.price?.toString().replace(/,/g,'') || '0'),
                    accessCode
                })
            });
            const tradeData = await tradeRes.json();
            if (tradeData.error) { showToast(tradeData.error); return; }
            showToast('✅ Trade placed successfully!');
            document.getElementById('perp-access-code').value = '';
            document.getElementById('perp-qty-input').value = '';
            await refreshUserData();
        } else {
            showToast('No active signal for this pair. Please wait for a signal.');
        }
    } catch(e) {
        showToast('Connection error. Please try again.');
    }
}

function pasteAccessCode() {
    navigator.clipboard.readText().then(text => {
        const el = document.getElementById('perp-access-code');
        if (el) {
            el.value = text.trim().toUpperCase();
            showToast('Code pasted!');
            setTimeout(() => onAccessCodeInput(el.value), 100);
        }
    }).catch(() => showToast('Allow clipboard access to paste'));
}

// Auto-execute trade when access code is pasted/typed
let _codeTimer = null;
async function onAccessCodeInput(code) {
    if (!code || code.length < 4) return;
    const statusEl = document.getElementById('perp-code-status');
    const boxEl = document.getElementById('perp-code-box');
    clearTimeout(_codeTimer);
    _codeTimer = setTimeout(async () => {
        if (!authToken) { showToast('Please login first'); return; }
        if (statusEl) { statusEl.style.display = 'block'; statusEl.style.color = '#d6b56a'; statusEl.textContent = '⏳ Verifying code...'; }
        const pairSym = (window._currentPerpPair || 'BTC/USDT');
        const btn = document.getElementById('perp-buy-btn');
        const side = btn?.textContent?.includes('Short') ? 'PUT' : 'CALL';
        const qty = parseFloat(document.getElementById('perp-qty-input')?.value || '0');
        try {
            const res = await fetch('/api/signals', { headers: { Authorization: 'Bearer ' + authToken } });
            const data = await res.json();
            const signals = data.signals || data || [];
            const activeSignal = signals.find(s => s.status === 'ACTIVE' && s.pair && pairSym.includes(s.pair.split('/')[0]));
            if (!activeSignal) {
                if (statusEl) { statusEl.style.color = '#f84960'; statusEl.textContent = '❌ No active signal for this pair'; }
                return;
            }

            // Auto-set direction from signal
            if (activeSignal.direction === 'PUT' || activeSignal.direction === 'CALL') {
                const isShort = activeSignal.direction === 'PUT';
                if (typeof setPerpSide === 'function') setPerpSide(isShort ? 'short' : 'long');
            }
            // Auto-set quantity from signal allocation% of balance
            const qtyInput = document.getElementById('perp-qty-input');
            const availBal = parseFloat(userData?.perpetualBalance || 0);
            const allocPct = activeSignal.suggestedAmount ? parseFloat(activeSignal.suggestedAmount) : 1;
            let tradeAmt = qty && qty > 0 ? qty : parseFloat((availBal * (allocPct / 100)).toFixed(2));
            if (qtyInput && tradeAmt > 0) qtyInput.value = tradeAmt;

            if (!tradeAmt || tradeAmt <= 0) {
                if (statusEl) { statusEl.style.color = '#f59e0b'; statusEl.textContent = '⚠️ No balance in Perpetual. Transfer funds first.'; }
                return;
            }

            // Show signal info card
            const infoCard = document.getElementById('perp-signal-info');
            if (infoCard) {
                infoCard.style.display = 'block';
                const dirEl = document.getElementById('si-dir');
                const isCall = activeSignal.direction === 'CALL';
                document.getElementById('si-pair').textContent = activeSignal.pair || pairSym;
                if (dirEl) { dirEl.textContent = activeSignal.direction || side; dirEl.style.color = isCall ? '#02c076' : '#f84960'; }
                document.getElementById('si-dur').textContent = activeSignal.duration >= 60 ? Math.floor(activeSignal.duration/60) + ' min' : activeSignal.duration + 's';
                document.getElementById('si-amt').textContent = tradeAmt.toFixed(2) + ' USDT';
                document.getElementById('si-profit').textContent = '+' + (activeSignal.rewardPercentage || 80) + '%';
                document.getElementById('si-risk').textContent = activeSignal.riskLevel || 'MEDIUM';
            }

            // Execute trade
            const tradeRes = await fetch('/api/signals/trade', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + authToken },
                body: JSON.stringify({
                    signalId: activeSignal.id,
                    amount: tradeAmt,
                    direction: activeSignal.direction || side,
                    entryPrice: parseFloat(allCoins.find(c => c.sym === pairSym.split('/')[0])?.price?.toString().replace(/,/g,'') || '0'),
                    accessCode: code
                })
            });
            const tradeData = await tradeRes.json();
            if (tradeData.error) {
                if (statusEl) { statusEl.style.color = '#f84960'; statusEl.textContent = '❌ ' + tradeData.error; }
                if (boxEl) boxEl.style.borderColor = 'rgba(248,73,96,0.6)';
                return;
            }
            // Success — show in Positions instantly
            if (statusEl) { statusEl.style.color = '#02c076'; statusEl.textContent = '✅ Trade placed!'; }
            if (boxEl) boxEl.style.borderColor = 'rgba(2,192,118,0.6)';
            showToast('✅ Trade placed!');
            document.getElementById('perp-access-code').value = '';
            document.getElementById('perp-qty-input').value = '';

            // Switch to Positions tab immediately
            const posBtn = document.querySelector('#perp-pos-tabs button');
            if (posBtn) setPerpPosTab(posBtn, 'positions');
            // Load positions right away
            await loadPerpTrades('positions');

            setTimeout(() => {
                if (statusEl) statusEl.style.display = 'none';
                if (boxEl) boxEl.style.borderColor = 'rgba(139,92,246,0.5)';
            }, 2000);
            await refreshUserData();
        } catch(e) {
            if (statusEl) { statusEl.style.color = '#f84960'; statusEl.textContent = '❌ Connection error'; }
        }
    }, 600); // 600ms debounce after user stops typing
}

function setPerpPosTab(btn, tab) {
    document.querySelectorAll('#perp-pos-tabs button').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    ['positions', 'orders', 'history', 'trades'].forEach(function (t) {
        var el = document.getElementById('perp-tab-' + t);
        if (el) el.style.display = t === tab ? 'block' : 'none';
    });
    if (tab === 'positions' || tab === 'history' || tab === 'trades') loadPerpTrades(tab);
}

async function loadPerpTrades(tab) {
    if (!authToken) return;
    try {
        const res = await fetch('/api/signals/my-trades', { headers: { Authorization: 'Bearer ' + authToken } });
        const data = await res.json();
        const trades = data.trades || data || [];

        const pending = trades.filter(t => t.outcome === 'PENDING' || !t.outcome);
        const history = trades.filter(t => t.outcome === 'WIN' || t.outcome === 'LOSS');

        if (tab === 'positions') renderPerpPositions(pending);
        if (tab === 'history') renderPerpHistory(history);
        if (tab === 'trades') renderPerpHistory(trades);
    } catch(e) { console.error('Trades load error', e); }
}

function renderPerpPositions(trades) {
    const el = document.getElementById('perp-tab-positions');
    if (!el) return;
    if (!trades || trades.length === 0) {
        el.innerHTML = '<div class="no-data-block" style="padding:30px 20px;"><p style="color:var(--text-muted);text-align:center;">No open positions</p></div>';
        return;
    }
    el.innerHTML = trades.map(t => {
        const pair = t.signal?.pair || t.pair || 'BTC/USDT';
        const dir = t.direction || 'CALL';
        const isCall = dir === 'CALL';
        const dirColor = isCall ? '#02c076' : '#f84960';
        const dirLabel = isCall ? '▲ LONG' : '▼ SHORT';
        const amount = parseFloat(t.amount || 0).toFixed(2);
        const reward = t.signal?.rewardPercentage || 80;
        const entryPrice = parseFloat(t.entryPrice || 0).toFixed(2);
        const createdAt = t.createdAt ? new Date(t.createdAt).toLocaleTimeString() : '--';
        const endMs = t.signal?.entryTime && t.signal?.duration
            ? new Date(t.signal.entryTime).getTime() + (t.signal.duration * 1000) : 0;
        const totalSec = t.signal?.duration || 60;

        return `
        <div style="background:#11100e;border-radius:14px;padding:14px 16px;margin:10px 12px;box-shadow:0 2px 12px rgba(0,0,0,0.35);border:1px solid rgba(214,181,106,0.14);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <div style="display:flex;align-items:center;gap:8px;">
                    <span style="font-size:15px;font-weight:800;color:#f5f1e8;">${pair}</span>
                    <span style="font-size:11px;font-weight:700;color:#fff;background:${dirColor};padding:3px 10px;border-radius:6px;">${dirLabel}</span>
                </div>
                <div style="text-align:right;">
                    <div id="cd-${t.id}" style="font-size:16px;font-weight:900;color:#f59e0b;font-variant-numeric:tabular-nums;letter-spacing:1px;">--:--</div>
                    <div style="font-size:9px;color:#9ca3af;margin-top:1px;">${createdAt}</div>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;margin-bottom:10px;">
                <div style="background:#1a1814;border-radius:8px;padding:7px;text-align:center;">
                    <div style="font-size:8px;color:#9ca3af;margin-bottom:2px;">AMOUNT</div>
                    <div style="font-size:12px;font-weight:800;color:#f5f1e8;">${amount}</div>
                    <div style="font-size:8px;color:#9ca3af;">USDT</div>
                </div>
                <div style="background:#1a1814;border-radius:8px;padding:7px;text-align:center;">
                    <div style="font-size:8px;color:#9ca3af;margin-bottom:2px;">ENTRY</div>
                    <div style="font-size:12px;font-weight:800;color:#f5f1e8;">${entryPrice}</div>
                </div>
                <div style="background:rgba(2,192,118,0.08);border-radius:8px;padding:7px;text-align:center;">
                    <div style="font-size:8px;color:#9ca3af;margin-bottom:2px;">PROFIT</div>
                    <div style="font-size:12px;font-weight:800;color:#02c076;">+${reward}%</div>
                </div>
                <div style="background:#1a1814;border-radius:8px;padding:7px;text-align:center;">
                    <div style="font-size:8px;color:#9ca3af;margin-bottom:2px;">DURATION</div>
                    <div style="font-size:12px;font-weight:800;color:#f5f1e8;">${Math.floor(totalSec/60)} min</div>
                </div>
            </div>
            <!-- Progress bar -->
            <div style="height:5px;background:#1a1814;border-radius:4px;overflow:hidden;">
                <div id="pb-${t.id}" style="height:100%;background:linear-gradient(90deg,${dirColor},${dirColor}88);border-radius:4px;width:0%;transition:width 1s linear;"></div>
            </div>
        </div>`;
    }).join('');

    // Start smooth countdowns for all positions
    if (window._posCountdownInterval) clearInterval(window._posCountdownInterval);
    window._posCountdownInterval = setInterval(() => {
        trades.forEach(t => {
            const cdEl = document.getElementById('cd-' + t.id);
            const pbEl = document.getElementById('pb-' + t.id);
            if (!cdEl) return;
            const endMs = t.signal?.entryTime && t.signal?.duration
                ? new Date(t.signal.entryTime).getTime() + (t.signal.duration * 1000) : 0;
            const totalSec = t.signal?.duration || 60;
            if (!endMs) { cdEl.textContent = '--:--'; return; }
            const remaining = Math.max(0, Math.floor((endMs - Date.now()) / 1000));
            const mm = Math.floor(remaining / 60).toString().padStart(2,'0');
            const ss = (remaining % 60).toString().padStart(2,'0');
            cdEl.textContent = mm + ':' + ss;
            cdEl.style.color = remaining < 30 ? '#f84960' : remaining < 60 ? '#f59e0b' : '#02c076';
            // Progress bar = elapsed %
            const elapsed = totalSec - remaining;
            const pct = Math.min(100, Math.floor((elapsed / totalSec) * 100));
            if (pbEl) pbEl.style.width = pct + '%';
            // Auto-reload when timer hits 0
            if (remaining === 0) {
                clearInterval(window._posCountdownInterval);
                setTimeout(() => loadPerpTrades('positions'), 2000);
            }
        });
    }, 1000);
}

function renderPerpHistory(trades) {
    const el = document.getElementById('perp-tab-history') || document.getElementById('perp-tab-trades');
    const elTrades = document.getElementById('perp-tab-trades');
    const target = trades.some(t => !t.outcome || t.outcome === 'PENDING') ? elTrades : el;
    if (!target) return;
    if (!trades || trades.length === 0) {
        target.innerHTML = '<div class="no-data-block" style="padding:30px 20px;"><p style="color:var(--text-muted);text-align:center;">No trade history</p></div>';
        return;
    }
    window._perpHistoryTrades = trades;
    target.innerHTML = trades.map((t, idx) => {
        const pair = t.signal?.pair || 'BTC/USDT';
        const dir = t.direction || 'CALL';
        const isCall = dir === 'CALL';
        const outcome = t.outcome || 'PENDING';
        const outcomeColor = outcome === 'WIN' ? '#02c076' : outcome === 'LOSS' ? '#f84960' : '#f59e0b';
        const outcomeLabel = outcome === 'WIN' ? '✅ WIN' : outcome === 'LOSS' ? '❌ LOSS' : '⏳ PENDING';
        const profit = parseFloat(t.profit || 0);
        const profitStr = profit >= 0 ? '+' + profit.toFixed(2) : profit.toFixed(2);
        const amount = parseFloat(t.amount || 0).toFixed(2);
        const createdAt = t.createdAt ? new Date(t.createdAt).toLocaleString() : '--';
        return `
        <div onclick="showTradeDetails(${idx})" style="cursor:pointer;background:#11100e;border-radius:12px;padding:14px 16px;margin:8px 12px;box-shadow:0 2px 8px rgba(0,0,0,0.35);border-left:3px solid ${outcomeColor};">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <div>
                    <div style="font-size:13px;font-weight:800;color:#f5f1e8;">${pair} <span style="font-size:10px;color:${isCall?'#02c076':'#f84960'};font-weight:700;">${dir}</span></div>
                    <div style="font-size:10px;color:#9ca3af;margin-top:2px;">${createdAt}</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:12px;font-weight:700;color:${outcomeColor};">${outcomeLabel}</div>
                    <div style="font-size:13px;font-weight:800;color:${profit>=0?'#02c076':'#f84960'};margin-top:2px;">${profitStr} USDT</div>
                    <div style="font-size:10px;color:#9ca3af;">${amount} USDT</div>
                </div>
            </div>
        </div>`;
    }).join('');
}

function showTradeDetails(idx) {
    const t = (window._perpHistoryTrades || [])[idx];
    if (!t) return;

    let modal = document.getElementById('trade-details-screen');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'trade-details-screen';
        modal.className = 'screen full-page';
        modal.style.zIndex = '1000';
        modal.innerHTML = `
        <div class="sub-header">
            <i class="fa-solid fa-chevron-left back-btn" onclick="closeTradeDetails()"></i>
            <h2>Trade details</h2>
            <span></span>
        </div>
        <div style="padding:20px;">
            <div style="border-radius:12px;padding:20px;border-top:1px solid rgba(255,255,255,0.05);">
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Pair:</span>
                    <span id="td-pair" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Direction:</span>
                    <span id="td-direction" style="font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Time:</span>
                    <span id="td-time" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Amount:</span>
                    <span id="td-amount" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Entry price:</span>
                    <span id="td-entry" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Close price:</span>
                    <span id="td-close" style="color:var(--text-primary);font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:20px;">
                    <span style="color:var(--text-secondary);font-size:14px;">Result:</span>
                    <span id="td-outcome" style="font-size:14px;font-weight:500;"></span>
                </div>
                <div style="height:1px;background:rgba(255,255,255,0.05);margin-bottom:20px;"></div>
                <div style="display:flex;justify-content:space-between;">
                    <span style="color:var(--text-secondary);font-size:14px;">Profit/Loss:</span>
                    <span id="td-profit" style="font-size:14px;font-weight:500;"></span>
                </div>
            </div>
        </div>`;
        document.body.appendChild(modal);
    }

    const pair = t.signal?.pair || t.pair || 'BTC/USDT';
    const dir = t.direction || 'CALL';
    const outcome = t.outcome || 'PENDING';
    const profit = parseFloat(t.profit || 0);
    const d = t.createdAt ? new Date(t.createdAt) : null;

    document.getElementById('td-pair').textContent = pair;
    const dirEl = document.getElementById('td-direction');
    dirEl.textContent = dir;
    dirEl.style.color = dir === 'CALL' ? 'var(--up-color)' : 'var(--down-color)';
    document.getElementById('td-time').textContent = d ? d.toLocaleString() : '--';
    document.getElementById('td-amount').textContent = parseFloat(t.amount || 0).toFixed(2) + ' USDT';
    document.getElementById('td-entry').textContent = t.entryPrice ? parseFloat(t.entryPrice).toFixed(4) : '--';
    document.getElementById('td-close').textContent = t.closePrice ? parseFloat(t.closePrice).toFixed(4) : '--';

    const outcomeEl = document.getElementById('td-outcome');
    const outcomeLabel = outcome === 'WIN' ? 'WIN' : outcome === 'LOSS' ? 'LOSS' : outcome === 'CANCELLED' ? 'CANCELLED' : 'PENDING';
    outcomeEl.textContent = outcomeLabel;
    outcomeEl.style.color = outcome === 'WIN' ? 'var(--up-color)' : outcome === 'LOSS' ? 'var(--down-color)' : 'var(--text-secondary)';

    const profitEl = document.getElementById('td-profit');
    profitEl.textContent = (profit >= 0 ? '+' : '') + profit.toFixed(2) + ' USDT';
    profitEl.style.color = profit >= 0 ? 'var(--up-color)' : 'var(--down-color)';

    modal.style.display = 'block';
}

function closeTradeDetails() {
    const modal = document.getElementById('trade-details-screen');
    if (modal) modal.style.display = 'none';
}

var _perpObInterval = null;
var _perpSmoothPrice = 0;

function startPerpOrderBookLoop() {
    stopPerpOrderBookLoop();
    // If current pair has no real price yet, fetch it first
    var pairSym = (window._currentPerpPair || 'BTC/USDT').split('/')[0];
    var coin = (window.allCoins || []).find(function (c) { return c.sym === pairSym; });
    var hasPrice = coin && coin.price && coin.price !== '--' && parseFloat(coin.price.replace(/,/g, '')) > 0;
    if (!hasPrice) {
        var binanceSym = (window._currentPerpPair || 'BTC/USDT').replace(/[\\s\/]/g, '').replace('USDTUSDT', 'USDT').replace(/\s+/g, '').toUpperCase();
        fetch('/api/mexc/ticker/price?symbol=' + binanceSym)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d && d.price) {
                    var p = parseFloat(d.price);
                    if (p > 0) {
                        _perpSmoothPrice = p;
                        if (coin) coin.price = p.toLocaleString();
                        renderPerpOrderBook();
                    }
                }
            }).catch(function () { });
    }
    renderPerpOrderBook();
    _perpObInterval = setInterval(renderPerpOrderBook, 1500);
}

function stopPerpOrderBookLoop() {
    if (_perpObInterval) { clearInterval(_perpObInterval); _perpObInterval = null; }
}

function renderPerpOrderBook() {
    // Get live price from allCoins for the selected pair
    var pairSym = (window._currentPerpPair || 'BTC/USDT').split('/')[0];
    var coin = (window.allCoins || []).find(function (c) { return c.sym === pairSym; });
    var basePrice = coin ? parseFloat((coin.price || '').replace(/,/g, '')) : 0;
    if (!basePrice || isNaN(basePrice) || basePrice <= 0) {
        // Use last smooth price if available, otherwise skip render
        if (_perpSmoothPrice > 0) basePrice = _perpSmoothPrice;
        else return;
    }

    // Smooth walk: initialise once, then nudge slightly each tick
    if (!_perpSmoothPrice || Math.abs(_perpSmoothPrice - basePrice) / basePrice > 0.02) {
        _perpSmoothPrice = basePrice;
    }
    _perpSmoothPrice += _perpSmoothPrice * 0.00008 * (Math.random() - 0.5);
    var price = _perpSmoothPrice;

    var midEl = document.getElementById('perp-mid-price');
    if (midEl) {
        midEl.textContent = price.toFixed(2);
        midEl.style.color = coin && !coin.up ? 'var(--down-color)' : 'var(--up-color)';
    }

    // Fixed spread step per row, only amounts randomise smoothly
    var step = price * 0.00025;
    var asks = [], bids = [];
    for (var i = 0; i < 8; i++) {
        var askPrice = (price + (i + 1) * step).toFixed(2);
        var bidPrice = (price - (i + 1) * step).toFixed(2);
        var askAmt = (Math.random() * 250 + 20).toFixed(2) + 'K';
        var bidAmt = (Math.random() * 250 + 20).toFixed(2) + 'K';
        asks.push('<div class="perp-ob-row ask"><span>' + askPrice + '</span><span>' + askAmt + '</span></div>');
        bids.push('<div class="perp-ob-row bid"><span>' + bidPrice + '</span><span>' + bidAmt + '</span></div>');
    }
    var asksEl = document.getElementById('perp-asks-list');
    var bidsEl = document.getElementById('perp-bids-list');
    if (asksEl) asksEl.innerHTML = asks.join('');
    if (bidsEl) bidsEl.innerHTML = bids.join('');

    // Sync header pair change %
    var chgEl = document.getElementById('perp-pair-change');
    if (chgEl && coin) { chgEl.textContent = ' ' + coin.ch; chgEl.className = 'pair-change ' + (coin.up ? 'up' : 'down'); }

    // Sync available amount with user balance
    var availEl = document.getElementById('perp-avail-amt');
    if (availEl && userData) availEl.textContent = (userData.perpetualBalance || 0).toFixed(2) + ' USDT';
}

function showPerpInfo() { showToast('Contract info coming soon'); }

var _perpDetailChart = null;
var _perpDetailData = [];
var _perpDetailRaw = [];
var _perpDetailWs = null;
var _perpDetailState = { sym: 'BTCUSDT', tf: '1h', type: 'candle', ma: false, ema: false, bb: false, vol: false };

function initPerpDetailChart(symbol, interval) {
    symbol = (symbol || 'BTCUSDT').replace(/\//g, '').replace('USDTUSDT', 'USDT').replace(/\s+/g, '').toUpperCase();
    interval = interval || '1h';
    var container = document.getElementById('perp-detail-chart');
    if (!container) return;
    if (_perpDetailChart) { try { _perpDetailChart.destroy(); } catch (e) { } _perpDetailChart = null; }
    _perpDetailData = []; _perpDetailRaw = [];
    _perpDetailState.sym = symbol; _perpDetailState.tf = interval;
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:290px;color:#a9a49a;font-size:13px;">Loading...</div>';

    // Update price display
    var pairSym = symbol.replace('USDT', '');
    var coin = (window.allCoins || []).find(function (c) { return c.sym === pairSym; });
    var priceEl = document.getElementById('perp-chart-price');
    if (priceEl && coin) { priceEl.textContent = coin.price; priceEl.className = 'futures-live-price-val ' + (coin.up ? 'up' : 'down'); }
    var highEl = document.getElementById('perp-chart-high');
    var lowEl = document.getElementById('perp-chart-low');
    var volEl = document.getElementById('perp-chart-vol');
    if (highEl && coin) highEl.textContent = coin.high || '--';
    if (lowEl && coin) lowEl.textContent = coin.low || '--';
    if (volEl && coin) volEl.textContent = coin.vol || '--';

    const sym = _perpDetailState.sym;
    let bSym = sym;
    if (bSym === 'XAUUSDT') bSym = 'PAXGUSDT';
    else if (bSym === 'XAGUSDT') bSym = 'LTCUSDT';
    else if (bSym === 'XPTUSDT') bSym = 'ETHUSDT';
    else if (bSym === 'XPDUSDT') bSym = 'BCHUSDT';

    fetch('/api/mexc/klines?symbol=' + bSym + '&interval=' + interval + '&limit=150')
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (!Array.isArray(data)) return;
            _perpDetailRaw = data;
            _perpDetailData = data.map(function (k) { return { x: +k[0], y: [+k[1], +k[2], +k[3], +k[4]] }; });
            _perpDetailChart = _rebuildChart(_perpDetailData, _perpDetailRaw, _perpDetailState, 'perp-detail-chart', 300);
            updateOHLCRow('perp-chart-ma-row', symbol, interval, data[data.length - 1]);
        }).catch(function () { container.innerHTML = '<div style="padding:20px;text-align:center;color:#a9a49a;">Chart unavailable</div>'; });

    if (_perpDetailWs) { try { _perpDetailWs.close(); } catch (e) { } _perpDetailWs = null; }
    function connectWs() {
        _perpDetailWs = null; // removed binance ws
        var timer = null;
        _perpDetailWs.onmessage = function (e) {
            try {
                var msg = JSON.parse(e.data);
                const priceEl = document.getElementById('perp-price-val');
                if (msg.stream && msg.stream.includes('@kline_')) {
                    var k = msg.data.k;
                    var rawC = [k.t, k.o, k.h, k.l, k.c, k.v];
                    if (_perpDetailData.length) {
                        var last = _perpDetailData[_perpDetailData.length - 1];
                        if (last.x === k.t) { _perpDetailData[_perpDetailData.length - 1] = { x: k.t, y: [+k.o, +k.h, +k.l, +k.c] }; _perpDetailRaw[_perpDetailRaw.length - 1] = rawC; }
                        else { _perpDetailData.push({ x: k.t, y: [+k.o, +k.h, +k.l, +k.c] }); _perpDetailRaw.push(rawC); if (_perpDetailData.length > 160) { _perpDetailData.shift(); _perpDetailRaw.shift(); } }
                    }
                    if (priceEl) { priceEl.textContent = (+k.c >= 100 ? (+k.c).toFixed(2) : (+k.c) >= 1 ? (+k.c).toFixed(4) : (+k.c).toFixed(6)); }
                    updateOHLCRow('perp-chart-ma-row', symbol, interval, rawC);
                    _updateRealtimeChart(_perpDetailChart, _perpDetailState, rawC);
                } else if (msg.stream && msg.stream.includes('@ticker')) {
                    if (_perpDetailData.length && _perpDetailChart) {
                        var lastIdx = _perpDetailData.length - 1;
                        var cPrice = +msg.data.c;
                        var lastRaw = _perpDetailRaw[lastIdx];
                        lastRaw[4] = cPrice;
                        lastRaw[2] = Math.max(+lastRaw[2], cPrice);
                        lastRaw[3] = Math.min(+lastRaw[3], cPrice);
                        _perpDetailData[lastIdx].y[3] = cPrice;
                        _perpDetailData[lastIdx].y[1] = lastRaw[2];
                        _perpDetailData[lastIdx].y[2] = lastRaw[3];
                        if (priceEl) { priceEl.textContent = (cPrice >= 100 ? cPrice.toFixed(2) : cPrice >= 1 ? cPrice.toFixed(4) : cPrice.toFixed(6)); }
                        updateOHLCRow('perp-chart-ma-row', symbol, interval, lastRaw);
                        _updateRealtimeChart(_perpDetailChart, _perpDetailState, lastRaw);
                    }
                }
            } catch (ex) { }
        };
        _perpDetailWs.onclose = function () { setTimeout(connectWs, 3000); };
    }
    connectWs();
}

function setPerpChartTf(btn, tf) {
    document.querySelectorAll('#perp-chart-timeframes button').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    var sym = (window._currentPerpPair || 'BTC/USDT').replace(/[\\s\/]/g, '').replace('USDTUSDT', 'USDT').replace(/\s+/g, '').toUpperCase();
    initPerpDetailChart(sym, tf);
}

function setPerpChartTab(btn, tab) {
    document.querySelectorAll('#perp-chart-screen .positions-tabs button').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    var e = document.getElementById('perp-chart-tab-entrusted');
    var t = document.getElementById('perp-chart-tab-trades');
    if (e) e.style.display = tab === 'entrusted' ? 'block' : 'none';
    if (t) t.style.display = tab === 'trades' ? 'block' : 'none';
}

// ── BIND ADDRESS ──
function selectChainType(type) {
    selectedChainType = type;
    document.querySelectorAll('.chain-type-btn').forEach(function (b) { b.classList.remove('active'); });
    var btn = document.getElementById('chain-' + type.toLowerCase());
    if (btn) btn.classList.add('active');
}

function _renderBindAddressScreen(data) {
    const boundState = document.getElementById('bind-addr-bound-state');
    const formState = document.getElementById('bind-addr-form-state');
    const freezeBanner = document.getElementById('bind-freeze-banner');
    const freezeText = document.getElementById('bind-freeze-text');

    if (data.freezeUntil && new Date() < new Date(data.freezeUntil)) {
        const remaining = Math.ceil((new Date(data.freezeUntil) - new Date()) / 3600000);
        if (freezeBanner) { freezeBanner.style.display = 'block'; }
        if (freezeText) freezeText.textContent = `Withdrawals frozen for ${remaining} more hour(s) after unbinding.`;
    } else {
        if (freezeBanner) freezeBanner.style.display = 'none';
    }

    if (data.address) {
        if (boundState) boundState.style.display = 'block';
        if (formState) formState.style.display = 'none';
        const addrDisplay = document.getElementById('bind-addr-display');
        const chainDisplay = document.getElementById('bind-chain-display');
        if (addrDisplay) addrDisplay.textContent = data.address;
        if (chainDisplay) chainDisplay.textContent = data.chain || 'TRC20';
        localStorage.setItem('boundWithdrawAddress', data.address);
        localStorage.setItem('boundWithdrawChain', data.chain || 'TRC20');
    } else {
        if (boundState) boundState.style.display = 'none';
        if (formState) formState.style.display = 'block';
        localStorage.removeItem('boundWithdrawAddress');
    }
}

async function loadBindAddressScreen() {
    try {
        const res = await fetch('/api/wallet/bound-address', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') } });
        if (!res.ok) return;
        const data = await res.json();
        _renderBindAddressScreen(data);
    } catch (e) { /* silently fallback to localStorage */ }
}

async function doBindAddress() {
    var addr = document.getElementById('bind-addr-input')?.value.trim();
    if (!addr) { showToast('Please enter wallet address'); return; }
    try {
        const res = await fetch('/api/wallet/bind-address', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ address: addr, chain: selectedChainType || 'TRC20' })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Failed to bind address'); return; }
        showToast('Address bound successfully!');
        localStorage.removeItem('withdrawFreezeUntil');
        _renderBindAddressScreen({ address: data.address, chain: data.chain, freezeUntil: null });
    } catch (e) {
        showToast('Network error');
    }
}

async function doUnbindAddress() {
    if (!confirm('Unbinding will freeze withdrawals for 24 hours. Continue?')) return;
    try {
        const res = await fetch('/api/wallet/unbind-address', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') }
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Failed to unbind'); return; }
        showToast('Address unbound. Withdrawals frozen for 24 hours.');
        localStorage.setItem('withdrawFreezeUntil', data.freezeUntil);
        _renderBindAddressScreen({ address: null, chain: null, freezeUntil: data.freezeUntil });
    } catch (e) {
        showToast('Network error');
    }
}

// ── GOOGLE AUTHENTICATOR (2FA) ──
async function loadGoogleAuthSetup() {
    const badge = document.getElementById('google-auth-enabled-badge');
    const removeCard = document.getElementById('google-auth-remove-card');
    const setupForm = document.getElementById('google-auth-setup-form');

    try {
        const statusRes = await fetch('/api/auth/2fa/status', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') } });
        const statusData = await statusRes.json();
        const enabled = !!statusData.enabled;

        if (badge) badge.style.display = enabled ? 'flex' : 'none';

        if (enabled) {
            // Already active — don't show the QR/secret again or let a stolen
            // session silently rebind a new authenticator; require the
            // account password first (see promptDisable2fa()).
            if (removeCard) removeCard.style.display = 'block';
            if (setupForm) setupForm.style.display = 'none';
            return;
        }

        if (removeCard) removeCard.style.display = 'none';
        if (setupForm) setupForm.style.display = 'block';

        const qrImg = document.getElementById('google-auth-qr');
        const qrPlaceholder = document.getElementById('google-auth-qr-placeholder');
        const keyEl = document.getElementById('google-auth-key');
        if (keyEl) keyEl.textContent = 'Loading...';
        if (qrImg) { qrImg.style.display = 'none'; qrImg.src = ''; }
        if (qrPlaceholder) qrPlaceholder.style.display = 'block';

        const res = await fetch('/api/auth/2fa/setup', { headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') } });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Failed to load 2FA setup'); return; }

        if (keyEl) keyEl.textContent = data.secret;
        if (qrImg && data.qr_code_base64) {
            qrImg.src = data.qr_code_base64;
            qrImg.style.display = 'block';
        }
        if (qrPlaceholder) qrPlaceholder.style.display = 'none';
    } catch (e) {
        showToast('Network error loading 2FA');
    }
}

function promptDisable2fa() {
    let modal = document.getElementById('disable-2fa-popup');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'disable-2fa-popup';
        modal.style.cssText = 'display:flex;position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.55);align-items:center;justify-content:center;padding:24px;';
        modal.innerHTML = `
        <div style="background:#11100e;border-radius:18px;max-width:340px;width:100%;padding:24px 20px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,0.25);">
            <div style="width:48px;height:48px;border-radius:14px;background:rgba(239,68,68,0.10);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;">
                <i class="fa-solid fa-triangle-exclamation" style="color:#dc2626;font-size:20px;"></i>
            </div>
            <div style="font-size:15px;font-weight:700;color:#f5f1e8;margin-bottom:14px;">Confirm Your Password</div>
            <input type="password" id="disable-2fa-password" placeholder="Account password" style="width:100%;padding:13px;border:1.5px solid rgba(139,92,246,0.25);border-radius:12px;font-size:15px;margin-bottom:16px;outline:none;">
            <button id="disable-2fa-confirm-btn" style="width:100%;padding:13px;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;background:#dc2626;color:#fff;margin-bottom:10px;">Remove Authenticator</button>
            <button onclick="closeDisable2faPrompt()" style="width:100%;padding:13px;border:none;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer;background:#1a1814;color:#6b7280;">Cancel</button>
        </div>`;
        document.body.appendChild(modal);
    }
    const input = document.getElementById('disable-2fa-password');
    const btn = document.getElementById('disable-2fa-confirm-btn');
    input.value = '';
    btn.onclick = async () => {
        const password = input.value;
        if (!password) { showToast('Enter your password'); return; }
        btn.textContent = 'Verifying...';
        btn.style.pointerEvents = 'none';
        try {
            const res = await fetch('/api/auth/2fa/disable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ password })
            });
            const data = await res.json();
            if (!res.ok) { showToast(data.error || 'Failed to remove authenticator'); btn.textContent = 'Remove Authenticator'; btn.style.pointerEvents = 'auto'; return; }
            closeDisable2faPrompt();
            showToast('Authenticator removed — set up a new one below.');
            loadGoogleAuthSetup();
        } catch (e) {
            showToast('Network error');
            btn.textContent = 'Remove Authenticator';
            btn.style.pointerEvents = 'auto';
        }
    };
    modal.style.display = 'flex';
    input.focus();
}
function closeDisable2faPrompt() {
    const modal = document.getElementById('disable-2fa-popup');
    if (modal) modal.style.display = 'none';
}

async function bindGoogleAuth() {
    const code = document.getElementById('google-auth-code')?.value?.trim();
    if (!code || code.length !== 6) { showToast('Enter a 6-digit code'); return; }

    try {
        const res = await fetch('/api/auth/2fa/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error || 'Invalid code'); return; }

        showToast('Google Authenticator linked successfully!');
        const badge = document.getElementById('google-auth-enabled-badge');
        if (badge) badge.style.display = 'flex';
        const codeInput = document.getElementById('google-auth-code');
        if (codeInput) codeInput.value = '';
    } catch (e) {
        showToast('Network error');
    }
}

// ── CONVERT ──
var _convertDir = 'USDT_TO_BTC'; // or 'BTC_TO_USDT'
var _simBtcBalance = 0;          // simulated BTC accumulated this session

function _syncBtcAssetRow() {
    var btcPrice = (window._marketPrices && window._marketPrices['BTCUSDT']) ? window._marketPrices['BTCUSDT'] : 77400;
    var availEl = document.getElementById('exch-btc-avail');
    var valEl = document.getElementById('exch-btc-val');
    if (availEl) availEl.textContent = _simBtcBalance > 0 ? _simBtcBalance.toFixed(8) : '0';
    if (valEl) valEl.textContent = _simBtcBalance > 0 ? '≈ $' + (_simBtcBalance * btcPrice).toFixed(2) : '≈ $0.00';
}

function _convertCoinDot(coin) {
    if (coin === 'USDT') return '<img src="https://assets.coingecko.com/coins/images/325/small/Tether.png" style="width:28px;height:28px;border-radius:50%;flex-shrink:0;">';
    return '<span class="coin-dot" style="background:#f7931a;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;"><i class="fa-brands fa-bitcoin" style="color:#fff;font-size:12px;"></i></span>';
}

function _updateConvertAvail() {
    var availEl = document.getElementById('convert-avail');
    if (!availEl) return;
    if (_convertDir === 'USDT_TO_BTC') {
        var bal = (userData && userData.balance !== undefined) ? userData.balance : 0;
        availEl.textContent = bal.toFixed(2) + ' USDT';
    } else {
        availEl.textContent = _simBtcBalance.toFixed(8) + ' BTC';
    }
}

function loadConvertRates() {
    var btcPrice = (window._marketPrices && window._marketPrices['BTCUSDT']) ? window._marketPrices['BTCUSDT'] : 77400;
    var rateEl = document.getElementById('convert-rate');
    if (rateEl) rateEl.textContent = '1 BTC ≈ ' + Number(btcPrice).toLocaleString() + ' USDT';
    _updateConvertAvail();
}

function calcConvert() {
    var from = parseFloat(document.getElementById('convert-from-amount') ? document.getElementById('convert-from-amount').value : 0) || 0;
    var btcPrice = (window._marketPrices && window._marketPrices['BTCUSDT']) ? window._marketPrices['BTCUSDT'] : 77400;
    var toEl = document.getElementById('convert-to-amount');
    if (!toEl) return;
    if (_convertDir === 'USDT_TO_BTC') {
        toEl.textContent = from > 0 ? (from / btcPrice).toFixed(8) : '0';
    } else {
        toEl.textContent = from > 0 ? (from * btcPrice).toFixed(2) : '0';
    }
}

function setConvertMax() {
    var inp = document.getElementById('convert-from-amount');
    if (!inp) return;
    if (_convertDir === 'USDT_TO_BTC') {
        var bal = (userData && userData.balance !== undefined) ? userData.balance : 0;
        inp.value = bal.toFixed(2);
    } else {
        inp.value = _simBtcBalance.toFixed(8);
    }
    calcConvert();
}

function swapConvert() {
    _convertDir = _convertDir === 'USDT_TO_BTC' ? 'BTC_TO_USDT' : 'USDT_TO_BTC';
    var fromCoin = _convertDir === 'USDT_TO_BTC' ? 'USDT' : 'BTC';
    var toCoin = _convertDir === 'USDT_TO_BTC' ? 'BTC' : 'USDT';

    var fromCoinEl = document.getElementById('convert-from-coin');
    var toCoinEl = document.getElementById('convert-to-coin');

    if (fromCoinEl) {
        var fromDot = fromCoinEl.previousElementSibling;
        if (fromDot) fromDot.outerHTML = _convertCoinDot(fromCoin);
        fromCoinEl = document.getElementById('convert-from-coin'); // re-query after outerHTML swap
        fromCoinEl.textContent = fromCoin;
    }
    if (toCoinEl) {
        var toDot = toCoinEl.previousElementSibling;
        if (toDot) toDot.outerHTML = _convertCoinDot(toCoin);
        toCoinEl = document.getElementById('convert-to-coin');
        toCoinEl.textContent = toCoin;
    }

    var inp = document.getElementById('convert-from-amount');
    var toEl = document.getElementById('convert-to-amount');
    if (inp) inp.value = '';
    if (toEl) toEl.textContent = '0';

    _updateConvertAvail();
}

function showConvertFromPicker() { showToast('Currency selector coming soon'); }
function showConvertToPicker() { showToast('Currency selector coming soon'); }

function doConvert() {
    var inp = document.getElementById('convert-from-amount');
    var amt = inp ? parseFloat(inp.value) : 0;
    if (!amt || amt <= 0) { showToast('Enter amount to convert'); return; }
    var btcPrice = (window._marketPrices && window._marketPrices['BTCUSDT']) ? window._marketPrices['BTCUSDT'] : 77400;
    var btn = document.querySelector('[onclick="doConvert()"]');

    if (_convertDir === 'USDT_TO_BTC') {
        var usdtBal = (userData && userData.balance !== undefined) ? userData.balance : 0;
        if (amt > usdtBal) { showToast('Insufficient USDT balance'); return; }
        var btcAmt = (amt / btcPrice).toFixed(8);
        if (btn) { btn.textContent = 'Processing...'; btn.disabled = true; }
        setTimeout(function () {
            _simBtcBalance += parseFloat(btcAmt);
            var toEl = document.getElementById('convert-to-amount');
            if (toEl) toEl.textContent = btcAmt;
            _syncBtcAssetRow();
            showToast('Converted ' + amt.toFixed(2) + ' USDT → ' + btcAmt + ' BTC');
            if (inp) inp.value = '';
            if (btn) { btn.textContent = 'Exchange'; btn.disabled = false; }
        }, 800);
    } else {
        if (amt > _simBtcBalance) { showToast('Insufficient BTC balance'); return; }
        var usdtAmt = (amt * btcPrice).toFixed(2);
        if (btn) { btn.textContent = 'Processing...'; btn.disabled = true; }
        setTimeout(function () {
            _simBtcBalance = Math.max(0, _simBtcBalance - amt);
            var toEl2 = document.getElementById('convert-to-amount');
            if (toEl2) toEl2.textContent = usdtAmt;
            _updateConvertAvail();
            _syncBtcAssetRow();
            showToast('Converted ' + amt.toFixed(8) + ' BTC → ' + usdtAmt + ' USDT');
            if (inp) inp.value = '';
            if (btn) { btn.textContent = 'Exchange'; btn.disabled = false; }
        }, 800);
    }
}

// ── PUBLIC APP SETTINGS (About Us + Support) ──
let _appSettings = null;
async function _fetchAppSettings() {
    if (_appSettings) return _appSettings;
    try {
        const res = await fetch('/api/public/settings');
        _appSettings = await res.json();
    } catch (e) { _appSettings = {}; }
    return _appSettings;
}

// The admin panel's "Promo Banner" (Settings → Promo Banner) saved to
// PlatformSettings but nothing on the user side ever read it back at all —
// a dead stub. This is a real text-only popup (no image), shown once per
// browser session while the admin's enabled/schedule window is active.
async function applyPromoBanner() {
    try {
        if (sessionStorage.getItem('promoBannerShown')) return;
        const s = await _fetchAppSettings();
        if (!s.promo_banner) return;
        let cfg;
        try { cfg = JSON.parse(s.promo_banner); } catch (e) { return; }
        if (!cfg.enabled || !cfg.text) return;

        const now = Date.now();
        if (cfg.start) {
            const startMs = new Date(cfg.start).getTime();
            if (!isNaN(startMs) && now < startMs) return;
            if (cfg.durationDays && !isNaN(startMs)) {
                const endMs = startMs + parseFloat(cfg.durationDays) * 86400000;
                if (now > endMs) return;
            }
        }

        showPromoBannerPopup(cfg.text);
        sessionStorage.setItem('promoBannerShown', '1');
    } catch (e) { }
}

function showPromoBannerPopup(text) {
    let modal = document.getElementById('promo-banner-popup');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'promo-banner-popup';
        modal.style.cssText = 'display:flex;position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.55);align-items:center;justify-content:center;padding:24px;';
        modal.innerHTML = `
        <div style="background:#11100e;border-radius:18px;max-width:340px;width:100%;padding:24px 20px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,0.25);">
            <div style="width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,#4c1d95,#8b5cf6);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;">
                <i class="fa-solid fa-bullhorn" style="color:#fff;font-size:20px;"></i>
            </div>
            <div id="promo-banner-popup-text" style="font-size:14px;color:#f5f1e8;line-height:1.6;margin-bottom:20px;white-space:pre-wrap;"></div>
            <button onclick="closePromoBannerPopup()" style="width:100%;padding:13px;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;background:linear-gradient(135deg,#4c1d95,#8b5cf6);color:#fff;">Got it</button>
        </div>`;
        document.body.appendChild(modal);
    }
    document.getElementById('promo-banner-popup-text').textContent = text;
    modal.style.display = 'flex';
}

function closePromoBannerPopup() {
    const modal = document.getElementById('promo-banner-popup');
    if (modal) modal.style.display = 'none';
}

// iOS has no installable APK equivalent and no JS API to trigger
// "Add to Home Screen" — Safari only exposes that via its own Share
// sheet, so the best we can do is walk the user through it.
function showIosInstallInstructions() {
    let modal = document.getElementById('ios-install-popup');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'ios-install-popup';
        modal.style.cssText = 'display:flex;position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.55);align-items:center;justify-content:center;padding:24px;';
        modal.innerHTML = `
        <div style="background:#11100e;border-radius:18px;max-width:340px;width:100%;padding:24px 20px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,0.25);">
            <div style="width:48px;height:48px;border-radius:14px;background:linear-gradient(135deg,#4c1d95,#8b5cf6);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;">
                <i class="fa-brands fa-apple" style="color:#fff;font-size:22px;"></i>
            </div>
            <div style="font-size:15px;font-weight:700;color:#f5f1e8;margin-bottom:14px;">Install NEOTRADE on iPhone</div>
            <div style="text-align:left;font-size:13px;color:#a9a49a;line-height:2;margin-bottom:20px;">
                1. Open this site in <b>Safari</b><br>
                2. Tap the <b>Share</b> icon <i class="fa-solid fa-arrow-up-from-bracket"></i><br>
                3. Tap <b>"Add to Home Screen"</b><br>
                4. Tap <b>Add</b> — NEOTRADE now opens like an app
            </div>
            <button onclick="closeIosInstallInstructions()" style="width:100%;padding:13px;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer;background:linear-gradient(135deg,#4c1d95,#8b5cf6);color:#fff;">Got it</button>
        </div>`;
        document.body.appendChild(modal);
    }
    modal.style.display = 'flex';
}

function closeIosInstallInstructions() {
    const modal = document.getElementById('ios-install-popup');
    if (modal) modal.style.display = 'none';
}

async function downloadApp() {
    const s = await _fetchAppSettings();
    if (s.apk_download_url) {
        window.location.href = s.apk_download_url;
    } else {
        showToast('App download will be available soon');
    }
}

async function loadAboutScreen() {
    const s = await _fetchAppSettings();
    const set = (id, val) => { const el = document.getElementById(id); if (el && val) el.textContent = val; };
    set('about-app-name', s.app_name);
    set('about-logo-initials', s.app_name ? s.app_name.substring(0, 2).toUpperCase() : null);
    set('about-version', s.app_version ? 'Version ' + s.app_version : null);
    set('about-description', s.app_description);
    const setLink = (btnId, url, toast) => {
        const el = document.getElementById(btnId);
        if (!el) return;
        if (url) { el.onclick = () => window.open(url, '_blank'); }
        else { el.onclick = () => showToast(toast); }
    };
    setLink('about-website-btn', s.app_website_url, 'Opening website...');
    setLink('about-twitter-btn', s.app_twitter_url, 'Opening Twitter...');
    setLink('about-telegram-btn', s.app_telegram_url, 'Opening Telegram...');
}

async function loadSupportScreen() {
    const s = await _fetchAppSettings();
    const emailEl = document.getElementById('support-email-text');
    const telegramEl = document.getElementById('support-telegram-text');
    const emailCard = document.getElementById('support-email-card');
    const telegramCard = document.getElementById('support-telegram-card');
    const faqCard = document.getElementById('support-faq-card');
    if (emailEl && s.support_email) emailEl.textContent = s.support_email;
    if (telegramEl && s.support_telegram) telegramEl.textContent = s.support_telegram;
    if (emailCard && s.support_email) emailCard.onclick = () => window.open('mailto:' + s.support_email);
    if (telegramCard && s.support_telegram) {
        const tgUrl = s.support_telegram.startsWith('http') ? s.support_telegram : 'https://t.me/' + s.support_telegram.replace('@', '');
        telegramCard.onclick = () => window.open(tgUrl, '_blank');
    }
    if (faqCard && s.support_faq_url) faqCard.onclick = () => window.open(s.support_faq_url, '_blank');
}

// ── SHARE / REFERRAL SCREEN ──

function toggleRefAccordion(header) {
    const item = header.parentElement;
    const body = item.querySelector('.ref-accordion-body');
    const icon = header.querySelector('.ref-accordion-icon');
    if (!body || !icon) return;
    const isOpen = body.style.maxHeight && body.style.maxHeight !== '0px';

    item.parentElement.querySelectorAll('.ref-accordion-body').forEach(function (b) {
        if (b !== body) b.style.maxHeight = '0px';
    });
    item.parentElement.querySelectorAll('.ref-accordion-icon').forEach(function (i) {
        if (i !== icon) i.style.transform = 'rotate(0deg)';
    });

    if (isOpen) {
        body.style.maxHeight = '0px';
        icon.style.transform = 'rotate(0deg)';
    } else {
        body.style.maxHeight = body.scrollHeight + 'px';
        icon.style.transform = 'rotate(180deg)';
    }
}

async function loadShareScreen() {
    if (!authToken) { navTo('login-screen'); return; }

    // Load Info (terms, FAQ, banner, announcement)
    try {
        const infoRes = await fetch('/api/referral/info');
        if (infoRes.ok) {
            const info = await infoRes.json();
            if (info.referral_title) document.getElementById('refPageTitle').textContent = info.referral_title;
            if (info.referral_description) document.getElementById('refPageDesc').textContent = info.referral_description;
            document.getElementById('refTermsText').textContent = info.referral_terms || 'Referral rewards are credited automatically once a referred user makes a qualifying deposit. Rewards are paid per the level and percentage rates set by the platform, and may be adjusted or withheld in cases of suspected abuse, fraud, or self-referral.';
            document.getElementById('refFaqText').textContent = info.referral_faq || 'Q: When do I earn from a referral?\nA: After you have made your own first deposit and someone in your network makes a qualifying deposit.\n\nQ: How many levels deep does the referral network go?\nA: Up to 5 levels.\n\nQ: Where can I see my referral earnings?\nA: Check your referral balance on the Assets screen.';
            document.querySelectorAll('#share-screen .ref-accordion-body').forEach(function (b) {
                if (b.style.maxHeight && b.style.maxHeight !== '0px') b.style.maxHeight = b.scrollHeight + 'px';
            });
            if (info.referral_banner) {
                const bannerEl = document.getElementById('refPageBanner');
                if (bannerEl) {
                    bannerEl.style.backgroundImage = `url(${info.referral_banner})`;
                    bannerEl.style.display = 'block';
                }
            }
            if (info.referral_announcement) {
                const annEl = document.getElementById('refPageAnnouncement');
                if (annEl) {
                    annEl.textContent = info.referral_announcement;
                    annEl.style.display = 'block';
                }
            }
        }
    } catch (e) { console.error('Error loading referral info', e); }

    // Load Dashboard Stats
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12000);
        let res;
        try {
            res = await fetch('/api/referral/dashboard', { headers: { 'Authorization': 'Bearer ' + authToken }, signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
        if (!res.ok) throw new Error('Failed to fetch stats');
        const data = await res.json();

        const stats = data.stats || {};
        const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        const setHtml = (id, val) => { const el = document.getElementById(id); if (el) el.innerHTML = val; };

        setHtml('refUserTotalEarnings', (stats.totalRewards || 0).toFixed(2) + ' <span style="font-size:16px; font-weight:600;">USDT</span>');
        setText('refStatDirect', stats.totalDirect || 0);
        setText('refStatIndirect', stats.totalIndirect || 0);
        setText('refStatActive', stats.activeTeamMembers != null ? stats.activeTeamMembers : (stats.activeReferrals || 0));
        setText('refStatTeam', stats.totalTeam || 0);
        setText('refStatDeposits', (stats.totalTeamDeposits || 0).toFixed(2));
        setText('refStatRewards', (stats.totalRewards || 0).toFixed(2));

        const growthEl = document.getElementById('refGrowthBadge');
        if (growthEl && stats.growth) {
            const last7 = stats.growth.last7Days || 0;
            const prev7 = stats.growth.prev7Days || 0;
            const diff = last7 - prev7;
            growthEl.style.display = 'inline-block';
            if (diff > 0) {
                growthEl.style.background = 'rgba(14,203,129,0.12)'; growthEl.style.color = 'var(--up-color)';
                growthEl.innerHTML = '<i class="fa-solid fa-arrow-trend-up"></i> +' + last7 + ' this week';
            } else if (last7 > 0) {
                growthEl.style.background = 'rgba(139,92,246,0.12)'; growthEl.style.color = 'var(--primary)';
                growthEl.innerHTML = '<i class="fa-solid fa-users"></i> +' + last7 + ' this week';
            } else {
                growthEl.style.background = 'rgba(255,255,255,0.06)'; growthEl.style.color = 'var(--text-muted)';
                growthEl.innerHTML = 'No new members this week';
            }
        }

        if (stats.thisWeek) {
            setText('refWeekMembers', stats.thisWeek.newMembers || 0);
            setText('refWeekDeposits', (stats.thisWeek.deposits || 0).toFixed(2));
            setText('refWeekEarnings', (stats.thisWeek.earnings || 0).toFixed(2));
        }

        const refLink = window.location.origin + '/?ref=' + (data.referralCode || '');
        setText('refUserLink', refLink);
        window.currentReferralLink = refLink;

        // Render 4 levels as compact chips (2x2 grid)
        const levels = data.levels || {};
        let levelsHtml = '';
        for (let i = 1; i <= 4; i++) {
            const l = levels[i] || {};
            const count = l.count || 0;
            const reward = (l.reward || 0).toFixed(2);
            levelsHtml += `
                <div class="pql-liquid-card" onclick="filterShareTreeByLevel(${i}); scrollToShareSection('refTreeSection');" style="border-radius:14px; padding:12px; cursor:pointer;">
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                        <div style="width:26px; height:26px; border-radius:8px; background:rgba(79,172,254,0.12); color:#4facfe; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:11.5px; flex-shrink:0;">${i}</div>
                        <span style="font-size:11.5px; color:var(--text-secondary); font-weight:600;">Step ${i}</span>
                    </div>
                    <div style="font-size:18px; font-weight:800; color:var(--text-primary); line-height:1;">${count}</div>
                    <div style="font-size:10.5px; color:var(--text-muted); margin-top:5px;">People &middot; <span style="color:var(--up-color); font-weight:700;">+${reward}</span> earned</div>
                </div>
            `;
        }
        setHtml('refNetworkLevels', levelsHtml);

        window._refCreditsHistory = Array.isArray(data.history) ? data.history : [];
        renderRefCreditsSummary();

        window._myReferralsTree = Array.isArray(data.tree) ? data.tree : [];
        window._myReferralsHistory = Array.isArray(data.history) ? data.history : [];

        const teamById = {};
        function indexNode(n, parentEmail) {
            teamById[n.id] = Object.assign({}, n, { parentEmail: n.parentEmail || parentEmail || null });
            (n.children || []).forEach(function (c) { indexNode(c, n.email); });
        }
        (window._myReferralsTree || []).forEach(function (n) { indexNode(n, null); });
        window._myTeamById = teamById;

        renderShareTreePreview();
    } catch (e) {
        console.error('Error loading referral dashboard', e);
    }
}

// Opens a full detail screen for any referral team member
function openReferralDetail(id) {
    const r = (window._myTeamById || {})[id];
    if (!r) return;
    const setText = (elId, val) => { const el = document.getElementById(elId); if (el) el.textContent = val; };

    setText('rd-avatar', (r.email || '?').charAt(0).toUpperCase());
    setText('rd-email', r.email || 'Unknown');
    setText('rd-userid', 'Account Number: ' + (r.referralCode || r.id));
    setText('rd-level', r.level === 1 ? 'You invited them directly' : 'Step ' + r.level + ' — your team invited them');
    setText('rd-joined', r.joinedAt ? new Date(r.joinedAt).toLocaleDateString() : '—');
    setText('rd-deposit', (r.totalDeposit || 0).toFixed(2) + ' USDT');
    setText('rd-reward', '+' + (r.rewardEarned || 0).toFixed(2) + ' USDT');

    const deposited = r.totalDeposit || 0;
    const rewarded = (r.rewardEarned || 0) > 0;
    const statusWrap = document.getElementById('rd-status-wrap');
    if (statusWrap) statusWrap.innerHTML = refStatusBadgeHtml(deposited, rewarded);

    const parentWrap = document.getElementById('rd-parent-wrap');
    if (parentWrap) {
        if (r.level > 1 && r.parentEmail) {
            parentWrap.style.display = 'block';
            parentWrap.innerHTML = '<i class="fa-solid fa-diagram-project" style="margin-right:6px;"></i>Brought into your team by <strong style="color:var(--text-primary);">' + r.parentEmail + '</strong>';
        } else {
            parentWrap.style.display = 'none';
        }
    }

    const txEl = document.getElementById('rd-transactions');
    if (txEl) {
        const txs = (window._myReferralsHistory || []).filter(function (h) { return h.referrer && h.referrer.id === id; });
        if (!txs.length) {
            txEl.innerHTML = '<div style="text-align:center; padding:16px; color:var(--text-muted); font-size:12.5px;">You haven\'t been paid because of this person yet.</div>';
        } else {
            txEl.innerHTML = txs.map(function (t) {
                const dt = t.createdAt ? new Date(t.createdAt).toLocaleString() : '';
                const pct = t.percentage != null ? (t.percentage + '%') : '';
                return `
                    <div style="display:flex; justify-content:space-between; align-items:center; background:rgba(255,255,255,0.03); padding:10px 12px; border-radius:10px;">
                        <div>
                            <div style="font-size:12.5px; font-weight:700; color:var(--text-primary);">They deposited${pct ? ' &middot; you got ' + pct : ''}</div>
                            <div style="font-size:10.5px; color:var(--text-muted); margin-top:2px;">${dt}</div>
                        </div>
                        <div style="font-weight:800; color:var(--up-color); font-size:13.5px;">+${(t.amount || 0).toFixed(2)}</div>
                    </div>
                `;
            }).join('');
        }
    }

    navTo('referral-detail-screen');
}

// Filter state for the Share screen's team tree
window._shareTreeFilter = { level: null, activeOnly: false };

function scrollToShareSection(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function _updateShareTreeFilterBar() {
    const bar = document.getElementById('refTreeFilterBar');
    const label = document.getElementById('refTreeFilterLabel');
    if (!bar || !label) return;
    const f = window._shareTreeFilter;
    if (f.level) {
        bar.style.display = 'flex';
        label.innerHTML = '<i class="fa-solid fa-filter"></i> Showing Step ' + f.level + ' only';
    } else if (f.activeOnly) {
        bar.style.display = 'flex';
        label.innerHTML = '<i class="fa-solid fa-filter"></i> Showing people already depositing';
    } else {
        bar.style.display = 'none';
    }
}

function filterShareTreeByLevel(level) {
    const f = window._shareTreeFilter;
    f.level = (f.level === level) ? null : level;
    f.activeOnly = false;
    _updateShareTreeFilterBar();
    renderShareTreePreview();
}

function filterShareTreeActiveOnly() {
    const f = window._shareTreeFilter;
    f.activeOnly = !f.activeOnly;
    f.level = null;
    _updateShareTreeFilterBar();
    renderShareTreePreview();
}

function clearShareTreeFilter() {
    window._shareTreeFilter = { level: null, activeOnly: false };
    _updateShareTreeFilterBar();
    renderShareTreePreview();
}

function renderShareTreePreview() {
    const el = document.getElementById('refTreePreview');
    if (!el) return;
    const tree = window._myReferralsTree || [];
    const filter = window._shareTreeFilter || { level: null, activeOnly: false };

    if (!tree.length) {
        el.innerHTML = '<div style="text-align:center; padding:28px 0; color:var(--text-muted); font-size:12.5px;"><i class="fa-solid fa-sitemap" style="font-size:28px; opacity:0.35; display:block; margin-bottom:10px;"></i>Your team tree is empty.<br>Share your link to start building it.</div>';
        return;
    }

    function memberRow(n) {
        const rewarded = (n.rewardEarned || 0) > 0;
        const dotColor = n.active ? '#02c076' : 'var(--text-muted)';
        const initial = (n.email || '?').charAt(0).toUpperCase();
        const avatarBg = n.active
            ? 'linear-gradient(135deg, #02c076, #04d98a)'
            : 'linear-gradient(135deg, rgba(255,255,255,0.18), rgba(255,255,255,0.06))';
        return `
            <div onclick="openReferralDetail('${n.id}')" style="display:flex; align-items:center; gap:10px; padding:10px 12px; background:var(--bg-card); border:1px solid var(--border-color); border-left:3px solid ${dotColor}; border-radius:12px; cursor:pointer;">
                <div class="tree-node-avatar" style="background:${avatarBg};">${initial}</div>
                <div style="flex:1; min-width:0;">
                    <div style="font-size:12.5px; font-weight:700; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${n.email || 'Unknown'}</div>
                    <div style="font-size:10px; color:var(--text-muted); margin-top:2px;">Step ${n.level} &middot; put in ${(n.totalDeposit || 0).toFixed(0)} USDT${rewarded ? ' &middot; you got +' + n.rewardEarned.toFixed(2) : ''}</div>
                </div>
                <i class="fa-solid fa-chevron-right" style="color:var(--text-muted); font-size:10px; flex-shrink:0;"></i>
            </div>
        `;
    }

    if (filter.level || filter.activeOnly) {
        const flat = [];
        function collect(n) { flat.push(n); (n.children || []).forEach(collect); }
        tree.forEach(collect);
        const matches = flat.filter(function (n) {
            if (filter.level) return n.level === filter.level;
            if (filter.activeOnly) return !!n.active;
            return true;
        });
        el.innerHTML = matches.length
            ? matches.map(memberRow).join('')
            : '<div style="text-align:center; padding:24px 0; color:var(--text-muted); font-size:12.5px;">Nobody matches this filter yet.</div>';
        return;
    }

    function renderNode(n) {
        const hasChildren = n.children && n.children.length;
        return `
            <div>
                ${memberRow(n)}
                ${hasChildren ? '<div class="tree-children">' + n.children.map(renderNode).join('') + '</div>' : ''}
            </div>
        `;
    }

    el.innerHTML = `
        <div class="pql-liquid-card" style="display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:12px; margin-bottom:4px;">
            <div class="tree-node-avatar" style="background:linear-gradient(135deg, var(--primary), #f97316);"><i class="fa-solid fa-crown" style="font-size:12px; color:#fff;"></i></div>
            <div style="font-size:13px; font-weight:800; color:var(--primary);">Me</div>
        </div>
    ` + tree.map(renderNode).join('');
}

// Uses the native share sheet on the phone (WhatsApp, SMS, etc.) when
// available; falls back to just copying the link on desktop browsers.
function shareRefLink() {
    if (!window.currentReferralLink) return;
    if (navigator.share) {
        navigator.share({ title: 'Join NEOTRADE', text: 'Join me on NEOTRADE and start earning:', url: window.currentReferralLink }).catch(function () { });
    } else {
        copyRefLink();
    }
}

// Renders the compact "Recent Transactions" summary card on the Share screen.
function renderRefCreditsSummary() {
    const history = window._refCreditsHistory || [];
    const countEl = document.getElementById('refCreditsSummaryCount');
    const lastEl = document.getElementById('refCreditsSummaryLast');
    const totalEl = document.getElementById('refCreditsSummaryTotal');
    if (!countEl) return;

    const total = history.reduce(function (sum, r) { return sum + (r.amount || 0); }, 0);
    countEl.textContent = history.length + (history.length === 1 ? ' Payment' : ' Payments');
    totalEl.textContent = total.toFixed(2);

    if (!history.length) {
        lastEl.textContent = 'No payments yet';
    } else {
        const last = history[0];
        const fromEmail = (last.referrer && last.referrer.email) || 'Team member';
        lastEl.textContent = 'Last: +' + (last.amount || 0).toFixed(2) + ' from ' + fromEmail;
    }
}

// Full Transaction History screen — every referral payment, paginated 10-at-a-time.
function openTransactionHistory() {
    window._txHistoryShown = 10;
    renderTxHistoryList();
    navTo('transaction-history-screen');
}

function renderTxHistoryList() {
    const history = window._refCreditsHistory || [];
    const shown = window._txHistoryShown || 10;
    const listEl = document.getElementById('txHistoryList');
    const emptyEl = document.getElementById('txHistoryEmpty');
    const moreBtn = document.getElementById('txHistoryMoreBtn');
    if (!listEl) return;

    const total = history.reduce(function (sum, r) { return sum + (r.amount || 0); }, 0);
    const countEl = document.getElementById('txHistoryCount');
    const totalEl = document.getElementById('txHistoryTotal');
    if (countEl) countEl.textContent = history.length;
    if (totalEl) totalEl.textContent = total.toFixed(2);

    if (!history.length) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        if (moreBtn) moreBtn.style.display = 'none';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    listEl.innerHTML = history.slice(0, shown).map(function (r) {
        const fromEmail = (r.referrer && r.referrer.email) || 'Team member';
        const fromId = r.referrer && r.referrer.id;
        const pct = r.percentage != null ? (r.percentage + '%') : '';
        const dt = r.createdAt ? new Date(r.createdAt).toLocaleString() : '';
        const clickAttr = fromId ? `onclick="openReferralDetail('${fromId}')"` : '';
        return `
            <div class="pql-liquid-card" ${clickAttr} style="border-radius:12px; padding:12px 14px; display:flex; justify-content:space-between; align-items:center; gap:9px; ${fromId ? 'cursor:pointer;' : ''}">
                <div style="display:flex; align-items:center; gap:10px; min-width:0;">
                    <div style="width:32px; height:32px; border-radius:50%; background:rgba(2,192,118,0.12); display:flex; align-items:center; justify-content:center; flex-shrink:0;"><i class="fa-solid fa-gift" style="color:var(--up-color); font-size:12px;"></i></div>
                    <div style="min-width:0;">
                        <div style="font-weight:700; font-size:13px; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                            From ${fromEmail}
                        </div>
                        <div style="font-size:10.5px; color:var(--text-muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">Step ${r.level}${pct ? ' &middot; ' + pct : ''} &middot; ${dt}</div>
                    </div>
                </div>
                <div style="font-weight:800; color:var(--up-color); font-size:14px; white-space:nowrap; flex-shrink:0;">+${(r.amount || 0).toFixed(2)}</div>
            </div>
        `;
    }).join('');

    if (moreBtn) moreBtn.style.display = history.length > shown ? 'block' : 'none';
}

function showMoreTxHistory() {
    window._txHistoryShown = (window._txHistoryShown || 10) + 10;
    renderTxHistoryList();
}

// Minimum deposit before any referral reward is paid.
const REFERRAL_REWARD_MIN_DEPOSIT = 500;

function refStatusBadgeHtml(deposited, rewarded) {
    if (deposited >= REFERRAL_REWARD_MIN_DEPOSIT || rewarded) {
        return '<span style="color:#02c076;background:rgba(2,192,118,0.1);padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap;"><i class="fa-solid fa-circle-check" style="margin-right:4px;"></i>Earning You Money</span>';
    }
    if (deposited > 0) {
        return '<span style="color:#8b5cf6;background:rgba(139,92,246,0.1);padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap;"><i class="fa-solid fa-triangle-exclamation" style="margin-right:4px;"></i>Needs $' + REFERRAL_REWARD_MIN_DEPOSIT + ' More</span>';
    }
    return '<span style="color:var(--text-muted);background:rgba(255,255,255,0.05);padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap;"><i class="fa-solid fa-clock" style="margin-right:4px;"></i>Hasn\'t Deposited Yet</span>';
}

// ── FETCH REAL PRICES ON LOAD ──
async function fetchInitialPrices() {
    try {
        allCoins.forEach(coin => {
            let p = parseFloat(coin.price.toString().replace(/,/g, ''));
            if (isNaN(p)) return;
            // 0.05% max fluctuation per tick
            let change = (Math.random() - 0.5) * 0.001 * p;
            p += change;

            let pStr;
            if (p < 0.0001) pStr = p.toFixed(8);
            else if (p < 1) pStr = p.toFixed(5);
            else if (p < 100) pStr = p.toFixed(3);
            else pStr = p.toFixed(2);

            coin.price = pStr;
            let chgVal = parseFloat(coin.ch.replace('%', ''));
            chgVal += (Math.random() - 0.5) * 0.02;
            coin.up = chgVal >= 0;
            coin.ch = (chgVal >= 0 ? '+' : '') + chgVal.toFixed(2) + '%';

            // Only update the newest candle/point
            coin.sp[coin.sp.length - 1] = p;

            // Evolve the graph quickly every 3 ticks
            if (!coin.tickCount) coin.tickCount = 0;
            coin.tickCount++;
            if (coin.tickCount > 3) {
                coin.sp.shift();
                coin.sp.push(p);
                coin.tickCount = 0;
            }
        });
        renderMarkets();
        renderMiniTickers();
        renderHomeMarkets();
    } catch (e) { }
}

function loadTickerText() {
    const defaultText = 'NEOTRADE — Trade with precision      Premium digital asset platform      Secure settlement      BTC, ETH, TRX and more         ';
    function setTicker(text) {
        const t1 = document.getElementById('ticker-content-1');
        const t2 = document.getElementById('ticker-content-2');
        if (t1) t1.innerHTML = text;
        if (t2) t2.innerHTML = text;
    }
    // Try to fetch from server, fall back to default
    fetch('/api/ticker').then(r => r.json()).then(d => {
        if (d && d.text && !d.text.toLowerCase().includes('trexis')) {
            setTicker(d.text + '        ');
        } else {
            setTicker(defaultText);
        }
    }).catch(() => setTicker(defaultText));
}

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
    // Generate 30 realistic past data points for highly detailed curly graphs based on actual price
    allCoins.forEach(coin => {
        let p = parseFloat(coin.price.toString().replace(/,/g, ''));
        if (isNaN(p)) return;
        let newSp = [];
        let currentP = p;
        for (let i = 0; i < 60; i++) {
            newSp.unshift(currentP);
            // Simulate past prices by walking backwards
            currentP -= (Math.random() - 0.5) * 0.005 * p;
        }
        coin.sp = newSp;
    });

    loadTickerText();
    loadBanners();
    applyPromoBanner();
    renderMarkets();
    renderMiniTickers();
    renderHomeMarkets('change');
    updateTimePeriod();
    setInterval(updateCountdown, 1000);
    initSocket();
    fetchInitialPrices();
    checkForAppUpdate();

    const path = window.location.pathname;
    const urlParams = new URLSearchParams(window.location.search);
    const refCode = urlParams.get('ref');

    if (authToken) {
        showSlide(0);
        startSlider();
        _showScreen('home-screen');
        refreshUserData();
        fetchNotifications();
        loadKycStatus();
        initChart('ETHUSDT');
        setInterval(refreshUserData, 30000);
        fetchSignals();
    } else {
        if (path === '/register' || path === '/signup' || refCode) {
            _showScreen('register-screen');
            if (refCode) {
                setTimeout(() => {
                    const inviteInput = document.getElementById('reg-invite');
                    if (inviteInput) inviteInput.value = refCode;
                }, 100);
            }
        } else {
            _showScreen('login-screen');
        }
    }

    // Hide preloader after app logic runs (allow video to play for a bit)
    setTimeout(() => {
        const preloader = document.getElementById('app-preloader');
        if (preloader) {
            preloader.classList.add('hidden');
            setTimeout(() => preloader.style.display = 'none', 600); // remove from DOM flow after fade
        }
    }, 2800); // 2.8 seconds wait to show the animation
});

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Ratio Fluctuation for Futures Buttons
setInterval(() => {
    const callEl = document.getElementById('call-ratio-val');
    const putEl = document.getElementById('put-ratio-val');
    if (callEl && putEl && callEl.offsetParent !== null) {
        let baseCall = 50.62;
        let fluctuation = (Math.random() * 2 - 1).toFixed(2); // -1.00 to +1.00
        let newCall = (baseCall + parseFloat(fluctuation)).toFixed(2);
        let newPut = (100 - newCall).toFixed(2);
        callEl.textContent = newCall + '%';
        putEl.textContent = newPut + '%';
    }
}, 2000);


// ── FUND TRANSFER LOGIC ──
let transferFrom = 'Exchange';
let transferTo = 'Perpetual';
let transferBalances = { Exchange: 0, Perpetual: 0 };

function openFundTransferModal() {
    document.getElementById('fund-transfer-overlay').style.display = 'flex';
    fetchBalancesForTransfer();
}

function closeFundTransferModal() {
    document.getElementById('fund-transfer-overlay').style.display = 'none';
}

function fetchBalancesForTransfer() {
    fetch('/api/wallet/balance', { headers: { 'Authorization': 'Bearer ' + authToken } })
        .then(r => r.json())
        .then(d => {
            transferBalances.Exchange = parseFloat(d.exchangeBalance || d.balance || 0);
            transferBalances.Perpetual = parseFloat(d.perpetualBalance || 0);
            updateTransferUI();
        }).catch(e => console.error(e));
}

function setTransferVal(type, val) {
    if (type === 'from') {
        if (transferTo === val) transferTo = transferFrom;
        transferFrom = val;
    } else {
        if (transferFrom === val) transferFrom = transferTo;
        transferTo = val;
    }
    updateTransferUI();
    toggleDropdown(`transfer-${type}-dd`);
}

function swapTransferDirection() {
    const temp = transferFrom;
    transferFrom = transferTo;
    transferTo = temp;
    updateTransferUI();
}

function updateTransferUI() {
    document.getElementById('transfer-from-val').textContent = transferFrom;
    document.getElementById('transfer-to-val').textContent = transferTo;
    document.getElementById('transfer-avail-amt').textContent = transferBalances[transferFrom].toFixed(2);
    checkTransferBtn();
}

function checkTransferBtn() {
    const amt = parseFloat(document.getElementById('modal-transfer-amount').value);
    const btn = document.getElementById('modal-transfer-confirm-btn');
    if (amt > 0 && amt <= transferBalances[transferFrom]) {
        btn.style.opacity = '1';
        btn.style.pointerEvents = 'auto';
    } else {
        btn.style.opacity = '0.5';
        btn.style.pointerEvents = 'none';
    }
}

function setNewTransferAll() {
    document.getElementById('modal-transfer-amount').value = transferBalances[transferFrom];
    checkTransferBtn();
}

function closePenaltyTermsModal() {
    document.getElementById('penalty-terms-overlay').style.display = 'none';
}

function confirmNewTransfer() {
    // Exchange <-> Perpetual is now free/instant — no lock period or
    // early-withdrawal penalty (Trade wallet, which had that policy, has
    // been removed).
    proceedNewTransfer();
}

function proceedNewTransfer() {
    closePenaltyTermsModal();
    const amt = document.getElementById('modal-transfer-amount').value;
    const btn = document.getElementById('modal-transfer-confirm-btn');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
    btn.style.pointerEvents = 'none';

    fetch('/api/wallet/transfer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + authToken },
        body: JSON.stringify({ fromWallet: transferFrom, toWallet: transferTo, amount: amt })
    })
        .then(r => r.json())
        .then(d => {
            btn.innerHTML = 'Confirm Transfer';
            if (d.error) {
                showToast(d.error);
            } else {
                if (d.penaltyAmount && d.penaltyAmount > 0) {
                    showToast('Transfer successful! ' + d.penaltyAmount.toFixed(2) + ' USDT deducted as early withdrawal penalty.');
                } else {
                    showToast('Transfer successful!');
                }
                document.getElementById('modal-transfer-amount').value = '';
                closeFundTransferModal();
                refreshUserData(); // Refresh global balances
                if (typeof fetchBalancesForTransfer === 'function') fetchBalancesForTransfer();
            }
        })
        .catch(e => {
            btn.innerHTML = 'Confirm Transfer';
            showToast('Transfer failed. Try again.');
        });
}



function showSuccessModal(msg) {
    return new Promise(resolve => {
        const modal = document.getElementById('success-toast-modal');
        const msgEl = document.getElementById('success-toast-msg');
        if (modal && msgEl) {
            msgEl.textContent = msg;
            modal.style.display = 'flex';
            setTimeout(() => {
                modal.style.display = 'none';
                resolve();
            }, 1500);
        } else {
            showToast(msg);
            resolve();
        }
    });
}


// ── FUTURES CHART HEADER COUNTDOWN ──
let headerCountdownInterval = null;
function startHeaderCountdown() {
    if (headerCountdownInterval) clearInterval(headerCountdownInterval);
    headerCountdownInterval = setInterval(updateHeaderCountdown, 1000);
    updateHeaderCountdown();
}

function updateHeaderCountdown() {
    if (document.getElementById('futures-screen').style.display === 'none') return;
    const activeBtn = document.querySelector('#futures-timeframes button.active');
    if (!activeBtn) return;

    const periodSecs = parseInt(activeBtn.dataset.sec) || 60;
    const now = new Date();

    // Time relative to start of Unix epoch (makes math easy)
    const nowSecs = Math.floor(now.getTime() / 1000);
    const nextBoundarySecs = Math.ceil(nowSecs / periodSecs) * periodSecs;

    let remain = nextBoundarySecs - nowSecs;
    if (remain === 0) remain = periodSecs;

    const elCountdown = document.getElementById('header-countdown');
    if (elCountdown) elCountdown.textContent = remain + ' s';

    // Order time formatting
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const elOrderTime = document.getElementById('header-order-time');
    if (elOrderTime) elOrderTime.textContent = y + '/' + m + '/' + d + ' ' + hh + ':' + mm + ':' + ss;

    // Time period formatting
    const startBoundary = new Date((nextBoundarySecs - periodSecs) * 1000);
    const endBoundary = new Date(nextBoundarySecs * 1000);
    const startH = String(startBoundary.getHours()).padStart(2, '0');
    const startM = String(startBoundary.getMinutes()).padStart(2, '0');
    const endH = String(endBoundary.getHours()).padStart(2, '0');
    const endM = String(endBoundary.getMinutes()).padStart(2, '0');

    const elTimePeriod = document.getElementById('header-time-period');
    if (elTimePeriod) elTimePeriod.textContent = startH + ':' + startM + '~' + endH + ':' + endM;
}

document.addEventListener('DOMContentLoaded', () => {
    startHeaderCountdown();
    loadBanners();
});

let bannerSlideIndex = 0;
let bannerInterval = null;

window.currentSlide = function (n) {
    showBannerSlide(n);
};

function showBannerSlide(n) {
    const slides = document.querySelectorAll('#banner-slides-container .slide');
    const dots = document.querySelectorAll('#banner-dots-container .dot');
    if (!slides.length) return;

    if (n >= slides.length) { bannerSlideIndex = 0; }
    else if (n < 0) { bannerSlideIndex = slides.length - 1; }
    else { bannerSlideIndex = n; }

    slides.forEach((slide, index) => {
        if (index === bannerSlideIndex) {
            slide.style.opacity = '1';
            slide.style.zIndex = '1';
            slide.classList.add('active');
        } else {
            slide.style.opacity = '0';
            slide.style.zIndex = '0';
            slide.classList.remove('active');
        }
    });

    dots.forEach((dot, index) => {
        if (index === bannerSlideIndex) {
            dot.classList.add('active');
            dot.style.backgroundColor = 'rgba(255,255,255,1)';
        } else {
            dot.classList.remove('active');
            dot.style.backgroundColor = 'rgba(255,255,255,0.5)';
        }
    });

    // Reset interval on manual slide
    if (bannerInterval) clearInterval(bannerInterval);
    bannerInterval = setInterval(() => { showBannerSlide(bannerSlideIndex + 1); }, 3000);
}


// PWA Installation Logic
let deferredPrompt;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
});

function installPWA() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                console.log('User accepted the install prompt');
            } else {
                console.log('User dismissed the install prompt');
            }
            deferredPrompt = null;
        });
    } else {
        showToast("App is already installed or your browser doesn't support it.");
    }
}

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then(registration => {
            console.log('SW registered: ', registration.scope);
        }).catch(err => {
            console.log('SW registration failed: ', err);
        });
    });
}

// ==================== DYNAMIC BANNERS ====================
async function loadBanners() {
    const s = await _fetchAppSettings();
    const bannerContainer = document.getElementById('banner-slides-container');
    const dotContainer = document.getElementById('banner-dots-container');

    if (!bannerContainer || !dotContainer) return;

    // Premium CSS banners — 2 slides only
    const bannerDefs = [
        {
            bg: 'linear-gradient(135deg,#0f0c29 0%,#302b63 50%,#24243e 100%)',
            title: 'In Bitcoin trading,<br>timing is everything',
            sub: 'Stay ahead with instant insights',
            accent: '#8b5cf6',
            badge: '🔥 LIVE', badgeColor: '#f84960'
        },
        {
            bg: 'linear-gradient(135deg,#060c1a 0%,#0e2040 50%,#1a3060 100%)',
            title: 'Follow Expert Signals.<br>Win More.',
            sub: 'Real-time signals with entry codes',
            accent: '#38bdf8',
            badge: '📈 NEW', badgeColor: '#02c076'
        }
    ];

    let slidesHtml = '';
    let dotsHtml = '';
    bannerDefs.forEach((b, i) => {
        const isActive = i === 0 ? 'active' : '';
        slidesHtml += `<div class="slide ${isActive}" style="position:absolute;top:0;left:0;width:100%;height:100%;opacity:${i===0?1:0};transition:opacity 0.7s ease-in-out;background:${b.bg};overflow:hidden;">

            <!-- Dot grid overlay -->
            <div style="position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,0.07) 1px,transparent 1px);background-size:18px 18px;pointer-events:none;"></div>

            <!-- Glow blob top-right -->
            <div style="position:absolute;top:-30px;right:-30px;width:180px;height:180px;background:radial-gradient(circle,${b.accent}55 0%,transparent 65%);border-radius:50%;pointer-events:none;"></div>

            <!-- Floating crypto symbols background -->
            <div style="position:absolute;inset:0;pointer-events:none;overflow:hidden;">
                <span style="position:absolute;top:8px;right:14px;font-size:52px;opacity:0.13;color:#fff;font-weight:900;line-height:1;transform:rotate(12deg);">₿</span>
                <span style="position:absolute;bottom:6px;right:60px;font-size:28px;opacity:0.09;color:#fff;font-weight:700;transform:rotate(-8deg);">Ξ</span>
                <span style="position:absolute;top:14px;right:76px;font-size:18px;opacity:0.08;color:${b.accent};font-weight:700;">◈</span>
                <span style="position:absolute;bottom:18px;right:18px;font-size:20px;opacity:0.1;color:#fff;">✦</span>
                <span style="position:absolute;top:50%;right:130px;font-size:14px;opacity:0.07;color:#fff;transform:translateY(-50%);">●</span>
            </div>

            <!-- Glowing circle ring -->
            <div style="position:absolute;top:-20px;right:-20px;width:140px;height:140px;border:1.5px solid ${b.accent}30;border-radius:50%;pointer-events:none;"></div>
            <div style="position:absolute;top:-5px;right:-5px;width:110px;height:110px;border:1px solid ${b.accent}20;border-radius:50%;pointer-events:none;"></div>

            <!-- Content -->
            <div style="position:relative;z-index:3;padding:18px 20px;height:100%;display:flex;flex-direction:column;justify-content:center;max-width:68%;">
                <!-- Logo + badge row -->
                <div style="display:flex;align-items:center;gap:7px;margin-bottom:8px;">
                    <div style="width:22px;height:22px;border-radius:6px;overflow:hidden;flex-shrink:0;">
                        <img src="/netrontrade-logo.svg" style="width:100%;height:100%;object-fit:contain;">
                    </div>
                    <span style="font-size:12px;font-weight:800;color:#fff;letter-spacing:1px;">NEOTRADE</span>
                    <span style="font-size:9px;font-weight:700;color:#fff;padding:2px 7px;border-radius:20px;background:${b.badgeColor};">${b.badge}</span>
                </div>
                <!-- Headline -->
                <div style="font-size:16px;font-weight:800;color:#fff;line-height:1.25;margin-bottom:5px;letter-spacing:-0.3px;">${b.title}</div>
                <!-- Subline -->
                <div style="font-size:10px;color:rgba(255,255,255,0.5);font-weight:400;margin-bottom:10px;">${b.sub}</div>
                <!-- CTA button -->
                <div style="display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.22);padding:6px 14px;border-radius:20px;width:fit-content;">
                    <span style="font-size:10px;font-weight:700;color:#fff;">Start Trading</span>
                    <i class="fa-solid fa-arrow-right" style="font-size:8px;color:rgba(255,255,255,0.8);"></i>
                </div>
            </div>

        </div>`;
        dotsHtml += `<span class="dot ${isActive}" onclick="currentSlide(${i})" style="cursor:pointer;height:6px;width:6px;margin:0 4px;background-color:rgba(255,255,255,0.5);border-radius:50%;display:inline-block;transition:all 0.3s ease;"></span>`;
    });
    bannerContainer.innerHTML = slidesHtml;
    dotContainer.innerHTML = dotsHtml;

    // Initialize the slider loop
    showBannerSlide(0);
}


async function loadWithdrawalScreen() {
    if (!userData) {
        await refreshUserData();
    }
    updateWithdrawalFeeCalc();
    const balanceText = document.getElementById('withdrawal-balance-text');
    if (balanceText && userData) {
        // Exchange balance is accessible at userData.balances.exchange
        const bal = parseFloat(userData.balance || 0).toFixed(4);
        balanceText.innerText = 'Balance: ' + bal + ' USDT';
    }

    const bound = localStorage.getItem('boundWithdrawAddress');
    const addrInput = document.getElementById('withdrawal-addr');
    if (addrInput) {
        if (bound) {
            addrInput.value = bound;
            addrInput.readOnly = true;
        } else {
            addrInput.value = '';
            addrInput.readOnly = false;
            showBindAddrTip();
        }
    }
}

function setWithdrawalMax() {
    if (userData) {
        const bal = parseFloat(userData.balance || 0);
        document.getElementById('withdrawal-amount').value = bal > 0 ? bal : '';
    }
    updateWithdrawalFeeCalc();
}

// The handling fee % is an admin-editable setting (Settings ->
// withdrawal_handling_fee_pct) — previously this screen hardcoded "8%" in
// the label and never actually calculated anything (the amount input had
// no oninput handler at all), so Fee/"You will receive" always showed
// 0.00/— regardless of what was typed.
let _withdrawalFeePct = null;
async function updateWithdrawalFeeCalc() {
    if (_withdrawalFeePct === null) {
        const s = await _fetchAppSettings();
        _withdrawalFeePct = parseFloat(s.withdrawal_handling_fee_pct);
        if (isNaN(_withdrawalFeePct)) _withdrawalFeePct = 8;
        const label = document.getElementById('withdrawal-fee-label');
        if (label) label.textContent = 'HANDLING FEE (' + _withdrawalFeePct + '%)';
    }

    const amt = parseFloat(document.getElementById('withdrawal-amount')?.value) || 0;
    const fee = amt > 0 ? amt * (_withdrawalFeePct / 100) : 0;
    const receive = Math.max(0, amt - fee);

    const feeInput = document.getElementById('withdrawal-fee');
    if (feeInput) feeInput.value = fee > 0 ? fee.toFixed(2) : '';
    const receiveEl = document.getElementById('withdrawal-receive-amt');
    if (receiveEl) receiveEl.textContent = amt > 0 ? receive.toFixed(2) + ' USDT' : '— USDT';
}

window.cancelManualTrade = async function (id) {
    if (!authToken) return;
    try {
        const res = await fetch('/api/signals/manual-cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ tradeId: id })
        });
        const data = await res.json();
        if (data.error) { showToast(data.error); return; }
        showToast('Trade Cancelled');
        refreshUserData();
        renderActivePositions();
        loadTradeHistory();
    } catch (e) { }
};
window.resolveManualTrade = async function (id) {
    if (!authToken) return;
    try {
        await fetch('/api/signals/manual-resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ tradeId: id })
        });
        refreshUserData();
        renderActivePositions();
        loadTradeHistory();
    } catch (e) { }
};

// ══════════════════════════════════════════════════════
// LOCKED DAYS MODAL
// ══════════════════════════════════════════════════════
window.showLockedDaysModal = function() {
    let remaining = 35;
    if (userData && userData.createdAt) {
        const createdDate = new Date(userData.createdAt);
        const now = new Date();
        const diffTime = now.getTime() - createdDate.getTime();
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        remaining = 35 - diffDays;
        if (remaining < 0) remaining = 0;
    }
    
    document.getElementById('locked-days-count').innerText = remaining;
    const modal = document.getElementById('locked-days-modal');
    if(modal) {
        modal.style.display = 'flex';
    }
};

window.closeLockedDaysModal = function() {
    const modal = document.getElementById('locked-days-modal');
    if(modal) {
        modal.style.display = 'none';
    }
};

// ── RULES & GUIDELINES SCREEN ──
const RULES_DEFAULTS = {
    stepGuide: [
        { title: 'CREATE YOUR ACCOUNT', desc: 'Create your account using your desired referral link.' },
        { title: 'CHOOSE A PLAN AND DEPOSIT AMOUNT', desc: 'Choose a plan that suits you and decide your deposit amount.' },
        { title: 'CONFIRM THE AMOUNT', desc: 'Kindly confirm the amount first that will be transferred after network fee.' },
        { title: 'SHARE YOUR INFORMATION ON TELEGRAM', desc: 'After successful deposit, share your information on Telegram.' },
        { title: 'TRANSFER BALANCE TO TRADE', desc: 'Before placing a trade, kindly transfer balance from Exchange to Trade. Otherwise the trade will not be placed.' },
        { title: 'GUIDE YOUR NEW MEMBER', desc: 'Properly guide your new member to follow these steps for a smooth and successful experience.' }
    ],
    telegramId: '@netrontrade',
    importantNote: 'Follow each step carefully to avoid delays or issues. We are here to support you at every stage.',
    membershipPlans: [
        { name: 'Basic Membership', priceRange: '$500 – $699', signals: 2, welcomeBonusPct: 5, followTradeDays: 2, foodAllowance: 10, bonusText: 'Add 1 member → get 1 extra signal · Add 3 members → get 2 extra signals', premium: false, warningText: '' },
        { name: 'Standard Membership', priceRange: '$700 – $1099', signals: 3, welcomeBonusPct: 7, followTradeDays: 2, foodAllowance: 20, bonusText: 'Add 2 members → get 1 extra signal · Add 3 members → get 2 extra signals', premium: false, warningText: '' },
        { name: 'Premium Membership', priceRange: '$1100 & up', signals: 3, welcomeBonusPct: 10, followTradeDays: 4, foodAllowance: 30, bonusText: 'Add 2 members → get 1 extra signal · Add 3 members → get 2 extra signals', premium: true, warningText: 'Member approval requires a mandatory deposit of at least 50% of the Leader account balance.' }
    ],
    shareholderLevels: [
        { level: 'LV1', directCount: 5, indirectCount: null, rewardIntervalDays: 10, rewardAmount: 30 },
        { level: 'LV2', directCount: 7, indirectCount: 40, rewardIntervalDays: 10, rewardAmount: 70 },
        { level: 'LV3', directCount: 10, indirectCount: 100, rewardIntervalDays: 10, rewardAmount: 150 },
        { level: 'LV4', directCount: 16, indirectCount: 200, rewardIntervalDays: 10, rewardAmount: 300 }
    ],
    tradeTimeTable: [
        { label: 'Basic Signal 1', uae: '02:00 PM', pakistan: '03:00 PM', india: '03:30 PM' },
        { label: 'Basic Signal 2', uae: '02:30 PM', pakistan: '03:30 PM', india: '04:00 PM' },
        { label: 'Basic Signal 3', uae: '06:00 PM', pakistan: '07:00 PM', india: '07:30 PM' },
        { label: 'Extra Signal 1', uae: '07:00 PM', pakistan: '08:00 PM', india: '08:30 PM' },
        { label: 'Extra Signal 2', uae: '08:00 PM', pakistan: '09:00 PM', india: '09:30 PM' },
        { label: 'Follow Trade', uae: '09:00 PM', pakistan: '10:00 PM', india: '10:30 PM' }
    ],
    tradeNotes: [
        '1% is applied on each trade — no more than 1% is allowed per trade.',
        '0.50% profit is given to members on each trade.',
        "Profit is calculated on the member's account balance after each trade."
    ],
    withdrawalRules: [
        'You can withdraw at any time.',
        'Full amount can be withdrawn by paying an 18% handling fee on the profit amount.',
        'If you withdraw the full amount (Investment + Profit), a bonus will be removed and 25% is the handling fee.',
        'If the withdrawal amount is less than $100, then $18 is the handling fee.',
        'If the withdrawal amount is more than $100, then 18% is the handling fee.'
    ]
};

async function loadRulesScreen() {
    let rules = RULES_DEFAULTS;
    try {
        const resp = await fetch('/api/public/settings');
        if (resp.ok) {
            const data = await resp.json();
            if (data.rules_content_json) {
                try { rules = JSON.parse(data.rules_content_json); } catch(e) { rules = RULES_DEFAULTS; }
            }
        }
    } catch(e) { /* fall through to defaults */ }

    // Step Guide
    const stepEl = document.getElementById('rules-step-guide');
    if (stepEl) {
        stepEl.innerHTML = rules.stepGuide.map((s, i) => `
            <div style="display:flex;align-items:flex-start;gap:12px;">
                <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#4c1d95,#8b5cf6);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <span style="font-size:12px;font-weight:800;color:#fff;">${i + 1}</span>
                </div>
                <div>
                    <div style="font-size:12px;font-weight:700;color:#f5f1e8;margin-bottom:3px;">${s.title}</div>
                    <div style="font-size:12px;color:#6b7280;line-height:1.6;">${s.desc}</div>
                </div>
            </div>
        `).join('');
    }

    // Telegram / Important Note
    const noteWrap = document.getElementById('rules-telegram-note');
    const noteText = document.getElementById('rules-important-note-text');
    if (noteWrap && noteText && rules.importantNote) {
        noteText.textContent = rules.importantNote;
        noteWrap.style.display = 'block';
    }

    // Membership Plans
    const memEl = document.getElementById('rules-membership-plans');
    if (memEl) {
        memEl.innerHTML = rules.membershipPlans.map(p => `
            <div style="border:${p.premium ? '1.5px solid #f59e0b' : '1px solid rgba(214,181,106,0.18)'};border-radius:14px;padding:16px;background:${p.premium ? 'linear-gradient(135deg,rgba(245,158,11,0.14),#11100e)' : '#1a1814'};">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
                    ${p.premium ? '<i class="fa-solid fa-crown" style="color:#f59e0b;font-size:14px;"></i>' : '<i class="fa-solid fa-star" style="color:#8b5cf6;font-size:12px;"></i>'}
                    <span style="font-size:14px;font-weight:700;color:#f5f1e8;">${p.name}</span>
                    <span style="margin-left:auto;font-size:12px;font-weight:700;color:#8b5cf6;background:rgba(139,92,246,0.1);padding:3px 10px;border-radius:20px;">${p.priceRange}</span>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
                    <div style="background:#11100e;border-radius:8px;padding:8px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,0.35);">
                        <div style="font-size:16px;font-weight:800;color:#8b5cf6;">${p.signals}</div>
                        <div style="font-size:11px;color:#9ca3af;">Daily Signals</div>
                    </div>
                    <div style="background:#11100e;border-radius:8px;padding:8px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,0.35);">
                        <div style="font-size:16px;font-weight:800;color:#10b981;">${p.welcomeBonusPct}%</div>
                        <div style="font-size:11px;color:#9ca3af;">Welcome Bonus</div>
                    </div>
                    <div style="background:#11100e;border-radius:8px;padding:8px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,0.35);">
                        <div style="font-size:16px;font-weight:800;color:#f59e0b;">${p.followTradeDays}</div>
                        <div style="font-size:11px;color:#9ca3af;">Follow Trade Days</div>
                    </div>
                    <div style="background:#11100e;border-radius:8px;padding:8px;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,0.35);">
                        <div style="font-size:16px;font-weight:800;color:#3b82f6;">$${p.foodAllowance}</div>
                        <div style="font-size:11px;color:#9ca3af;">Food Allowance</div>
                    </div>
                </div>
                ${p.bonusText ? `<div style="font-size:11px;color:#7c3aed;background:rgba(139,92,246,0.07);border-radius:8px;padding:8px 10px;">${p.bonusText}</div>` : ''}
                ${p.warningText ? `<div style="margin-top:8px;font-size:11px;color:#dc2626;background:rgba(239,68,68,0.10);border-radius:8px;padding:8px 10px;border-left:3px solid #f87171;">${p.warningText}</div>` : ''}
            </div>
        `).join('');
    }

    // Trade Time Table
    const ttEl = document.getElementById('rules-trade-timetable');
    if (ttEl) {
        ttEl.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:260px;">
                <thead>
                    <tr style="background:#1a1814;">
                        <th style="color:#8b5cf6;padding:8px 6px;text-align:left;border-radius:8px 0 0 8px;font-weight:600;">Signal</th>
                        <th style="color:#8b5cf6;padding:8px 6px;text-align:center;font-weight:600;">UAE</th>
                        <th style="color:#8b5cf6;padding:8px 6px;text-align:center;font-weight:600;">Pakistan</th>
                        <th style="color:#8b5cf6;padding:8px 6px;text-align:center;border-radius:0 8px 8px 0;font-weight:600;">India</th>
                    </tr>
                </thead>
                <tbody>
                    ${rules.tradeTimeTable.map((r, i) => `
                    <tr style="border-bottom:1px solid rgba(214,181,106,0.14);${i % 2 === 0 ? 'background:#1a1814;' : ''}">
                        <td style="padding:7px 6px;color:#f5f1e8;font-weight:600;">${r.label}</td>
                        <td style="padding:7px 6px;text-align:center;color:#6b7280;">${r.uae}</td>
                        <td style="padding:7px 6px;text-align:center;color:#6b7280;">${r.pakistan}</td>
                        <td style="padding:7px 6px;text-align:center;color:#6b7280;">${r.india}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        `;
    }

    // Trade Notes
    const notesEl = document.getElementById('rules-trade-notes');
    if (notesEl && rules.tradeNotes && rules.tradeNotes.length) {
        notesEl.innerHTML = rules.tradeNotes.map(note => `
            <div style="display:flex;align-items:flex-start;gap:8px;font-size:12px;color:#a9a49a;">
                <i class="fa-solid fa-circle-check" style="color:#8b5cf6;font-size:11px;margin-top:2px;flex-shrink:0;"></i>
                <span>${note}</span>
            </div>
        `).join('');
    }

    // Shareholder Levels
    const shEl = document.getElementById('rules-shareholder-levels');
    if (shEl) {
        shEl.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:12px;">
                <thead>
                    <tr style="background:#1a1814;">
                        <th style="color:#8b5cf6;padding:8px 6px;text-align:left;font-weight:600;">Level</th>
                        <th style="color:#8b5cf6;padding:8px 6px;text-align:center;font-weight:600;">Direct</th>
                        <th style="color:#8b5cf6;padding:8px 6px;text-align:center;font-weight:600;">Indirect</th>
                        <th style="color:#8b5cf6;padding:8px 6px;text-align:center;font-weight:600;">Every</th>
                        <th style="color:#8b5cf6;padding:8px 6px;text-align:right;font-weight:600;">Reward</th>
                    </tr>
                </thead>
                <tbody>
                    ${rules.shareholderLevels.map((lv, i) => `
                    <tr style="border-bottom:1px solid rgba(214,181,106,0.14);${i % 2 === 0 ? 'background:#1a1814;' : ''}">
                        <td style="padding:7px 6px;font-weight:700;color:#7c3aed;">${lv.level}</td>
                        <td style="padding:7px 6px;text-align:center;color:#f5f1e8;">${lv.directCount}</td>
                        <td style="padding:7px 6px;text-align:center;color:#6b7280;">${lv.indirectCount != null ? lv.indirectCount : '—'}</td>
                        <td style="padding:7px 6px;text-align:center;color:#6b7280;">${lv.rewardIntervalDays}d</td>
                        <td style="padding:7px 6px;text-align:right;font-weight:700;color:#10b981;">$${lv.rewardAmount}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        `;
    }

    // Withdrawal Rules
    const wdEl = document.getElementById('rules-withdrawal-rules');
    if (wdEl) {
        wdEl.innerHTML = rules.withdrawalRules.map((rule, i) => `
            <div style="display:flex;align-items:flex-start;gap:10px;background:#1a1814;border-radius:10px;padding:10px 12px;">
                <div style="width:20px;height:20px;border-radius:50%;background:linear-gradient(135deg,#4c1d95,#8b5cf6);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <span style="font-size:10px;font-weight:800;color:#fff;">${i + 1}</span>
                </div>
                <span style="font-size:12px;color:#a9a49a;line-height:1.6;">${rule}</span>
            </div>
        `).join('');
    }
}

// ── REFERRAL SCREEN ──
function loadReferralScreen() {
    // Referral code
    const codeEl = document.getElementById('referral-code-display');
    const linkEl = document.getElementById('referral-link-display');
    const countEl = document.getElementById('referral-count-display');
    const earnedEl = document.getElementById('referral-earned-display');
    const listEl = document.getElementById('referral-list-display');

    if (userData && userData.referralCode) {
        if (codeEl) codeEl.textContent = userData.referralCode;
        if (linkEl) linkEl.textContent = `${window.location.origin}/register?ref=${userData.referralCode}`;
    }

    if (userData) {
        const refs = userData.referrals || [];
        if (countEl) countEl.textContent = refs.length;
        if (earnedEl) earnedEl.textContent = (userData.referralBalance || 0).toFixed(2);

        if (listEl) {
            if (refs.length === 0) {
                listEl.innerHTML = `
                    <div style="text-align:center;padding:24px;">
                        <i class="fa-solid fa-users" style="font-size:32px;color:#e0e0f0;margin-bottom:8px;display:block;"></i>
                        <p style="color:#9ca3af;font-size:13px;">No referrals yet. Share your code to start earning!</p>
                    </div>`;
            } else {
                listEl.innerHTML = refs.map(r => `
                    <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(214,181,106,0.14);">
                        <div style="width:36px;height:36px;border-radius:50%;background:rgba(139,92,246,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                            <i class="fa-solid fa-user" style="color:#8b5cf6;font-size:14px;"></i>
                        </div>
                        <div style="flex:1;">
                            <div style="font-size:13px;font-weight:600;color:#f5f1e8;">${r.username || r.email || 'Member'}</div>
                            <div style="font-size:11px;color:#9ca3af;">${r.createdAt ? new Date(r.createdAt).toLocaleDateString() : ''}</div>
                        </div>
                        <div style="font-size:12px;font-weight:700;color:${r.balance > 0 ? '#10b981' : '#9ca3af'};">
                            ${r.balance > 0 ? '$' + Number(r.balance).toFixed(2) : 'Pending'}
                        </div>
                    </div>
                `).join('');
            }
        }
    }
}
