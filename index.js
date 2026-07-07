import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

var local_secret_state = null;
var local_SECRET_KEYS = null;

// ─── DS Default Pricing Rules (reference data for default channel) ─────────────
var DS_DEFAULT_RULES = [
  {
    id: 'rule_ds_v4_flash',
    pattern: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    hit: 0.02, miss: 1.0, output: 2.0,
    isDefault: true, enabled: true,
    offpeak: { hit: 0.02,  miss: 1.0, output: 2.0  },
    peak:    { hit: 0.04,  miss: 2.0, output: 4.0  },
  },
  {
    id: 'rule_ds_v4_pro',
    pattern: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    hit: 0.025, miss: 3.0, output: 6.0,
    isDefault: true, enabled: true,
    offpeak: { hit: 0.025, miss: 3.0, output: 6.0  },
    peak:    { hit: 0.05,  miss: 6.0, output: 12.0 },
  },
  {
    id: 'rule_ds_chat',
    pattern: 'deepseek-chat',
    label: 'DeepSeek Chat',
    hit: 1.0, miss: 2.0, output: 8.0,
    isDefault: true, enabled: true,
    offpeak: { hit: 1.0, miss: 2.0, output: 8.0 },
    peak:    { hit: 1.0, miss: 2.0, output: 8.0 },
  },
  {
    id: 'rule_ds_reasoner',
    pattern: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    hit: 2.0, miss: 4.0, output: 16.0,
    isDefault: true, enabled: true,
    offpeak: { hit: 2.0, miss: 4.0, output: 16.0 },
    peak:    { hit: 2.0, miss: 4.0, output: 16.0 },
  },
];

function cloneDefaultRules() {
  return DS_DEFAULT_RULES.map(function (r) {
    return Object.assign({}, r,
      { peak: Object.assign({}, r.peak), offpeak: Object.assign({}, r.offpeak) });
  });
}

// ─── Default Settings ──────────────────────────────────────────────────────────
var DEFAULT_SETTINGS = {
  debug: false,
  debugHit: 10000,
  debugMiss: 5000,
  debugOutput: 2000,
  debugModel: 'deepseek-v4-flash',
  displayMode: 'wand-modal',
  moduleOrder: ['balance', 'stats', 'latest', 'history', 'diff'],
  moduleVisibility: { balance: true, stats: true, latest: true, history: true, diff: true },
  statsVisibility: {
    'total-cost': true,
    'hit-rate': true,
    'avg-cost': true,
    'savings': true,
    'input-cost': true,
    'output-cost': true,
    'total-tokens': false,
    'hit-tokens': false,
    'miss-tokens': false,
    'rounds-count': false,
    'max-turn-cost': false,
    'avg-turn-tokens': false,
    'latest-hit-rate': false,
    'hit-miss-ratio': false,
    'avg-input-tokens': false,
    'avg-output-tokens': false,
    'savings-rate': false,
    'min-turn-cost': false,
    'max-turn-tokens': false,
    'min-turn-tokens': false,
  },
  channels: [],          // populated by initDefaultChannels()
  balanceLayout: 'vertical', // 'vertical' | 'horizontal'
  // Legacy fields kept only for migration detection:
  autoBalance: false,
  balanceInterval: 10,
  useNewPricing: false,
  newPricingDate: new Date('2026-07-15T00:00:00+08:00').getTime(),
  isDsOfficialDeleted: false,
};

// ─── State ────────────────────────────────────────────────────────────────────
var state = {
  currentSave: null,
  saves: {},
  lastUsage: null,
  panelOpen: false,
  // Legacy (kept for migration only):
  apiKey: '',
  balance: null,
  customBalance: null,
  // Settings:
  settings: Object.assign({}, DEFAULT_SETTINGS),
  messageCount: 0,
  lastRealSave: '',
  // UI transient state (not persisted):
  activeModelFilter: '__all__',
  activeChannelFilter: '__all__',
};

var isInitDone    = false;
var initTimestamp = 0;
var selectedBeforeId = null;
var selectedAfterId  = null;
var lastProcessedSignature = '';
var lastProcessedTime      = 0;
var walletBtnObserver  = null;
var _refreshPending    = false;
var _saveSavesTimer    = null;
var _mergedStatsCache  = null;
var _mergedStatsCacheKey = '';
var _saveSelectHash    = '';
var _docClickListener  = null;
var processedRequestIds = [];

var debugLogs = [];
function logDebug(msg) {
  var time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  debugLogs.push('[' + time + '] ' + msg);
  if (debugLogs.length > 20) debugLogs.shift();
  try {
    var doc = getDoc();
    var el = doc.getElementById('ds-debug-log-content');
    if (el) {
      el.textContent = debugLogs.join('\n');
    }
  } catch (e) {}
}

// ─── Storage keys ─────────────────────────────────────────────────────────────
var TARGET_API            = '/api/backends/chat-completions/generate';
var KEY_STORAGE           = 'ds_api_key';
var BALANCE_STORAGE       = 'ds_balance_data';
var SAVES_STORAGE         = 'ds_saves';
var CURRENT_SAVE_KEY      = 'ds_current_save';
var SETTINGS_STORAGE      = 'ds_settings';
var MESSAGE_COUNT_STORAGE = 'ds_message_count';
var CUSTOM_BALANCE_STORAGE = 'ds_custom_balance';

// ─── Panel HTML ────────────────────────────────────────────────────────────────
var PANEL_HTML = `
<div class="ds-margin-b-16" style="display:flex; align-items:center; gap:6px;">
  <select id="ds-save-select" class="ds-select" style="height:36px; padding:6px 10px; box-sizing:border-box;"></select>
  <button id="ds-btn-new-save" class="ds-btn ds-btn-normal" style="padding:0; width:36px; height:36px; display:flex; align-items:center; justify-content:center; box-sizing:border-box; flex-shrink:0;" title="新建当前存档">
    <i class="fa-solid fa-plus" style="font-size:14px;"></i>
  </button>
  <button id="ds-btn-delete-save" class="ds-btn ds-btn-normal" style="padding:0; width:36px; height:36px; display:flex; align-items:center; justify-content:center; box-sizing:border-box; flex-shrink:0;" title="删除当前存档">
    <i class="fa-solid fa-trash" style="font-size:14px;"></i>
  </button>
  <button id="ds-btn-delete-all" class="ds-btn ds-btn-normal" style="padding:0; width:36px; height:36px; display:flex; align-items:center; justify-content:center; box-sizing:border-box; flex-shrink:0;" title="清空全部存档">
    <i class="fa-solid fa-broom" style="font-size:14px;"></i>
  </button>
</div>

<div id="ds-modules-container">

  <!-- 钱包余额模块 -->
  <div id="ds-module-balance" class="ds-margin-b-16">
    <div class="ds-flex-between ds-margin-b-12">
      <div class="ds-section-title">
        <div class="ds-title-indicator"></div>
        <span>账户余额</span>
      </div>
      <div class="ds-flex-row">
        <button id="ds-btn-balance-layout" class="ds-btn ds-btn-sm ds-btn-normal" title="切换布局" style="padding:4px 8px;">
          <i class="fa-solid fa-table-cells-large" style="font-size:11px;"></i>
        </button>
      </div>
    </div>
    <div id="ds-balance-cards"></div>
  </div>

  <!-- 统计概览模块 -->
  <div id="ds-module-stats" class="ds-margin-b-16">
    <div class="ds-flex-between ds-margin-b-8">
      <div class="ds-section-title">
        <div class="ds-title-indicator"></div>
        <span>统计概览</span>
        <span id="ds-save-time" class="ds-section-time"></span>
      </div>
      <div class="ds-flex-row">
        <button id="ds-btn-refresh" class="ds-btn ds-btn-sm ds-btn-normal">刷新</button>
        <button id="ds-btn-clear"   class="ds-btn ds-btn-sm ds-btn-danger">清空</button>
      </div>
    </div>
    <div id="ds-model-filter" class="ds-margin-b-8"></div>
    <div id="ds-channel-filter" class="ds-margin-b-8"></div>
    <div class="ds-grid-3">
      <div id="ds-stat-card-total-cost" class="ds-card">
        <div class="ds-card-title">总消耗</div>
        <div class="ds-card-val"><span id="ds-total-cost">¥0.00</span></div>
        <div id="ds-total-tokens" class="ds-card-sub">0 tokens</div>
      </div>
      <div id="ds-stat-card-hit-rate" class="ds-card">
        <div class="ds-card-title">加权缓存命中率</div>
        <div class="ds-card-val-green"><span id="ds-weighted-rate">0%</span></div>
        <div id="ds-rounds" class="ds-card-sub">基于 0 轮</div>
      </div>
      <div id="ds-stat-card-avg-cost" class="ds-card">
        <div class="ds-card-title">平均每轮</div>
        <div class="ds-card-val"><span id="ds-avg-cost">¥0.00</span></div>
        <div id="ds-avg-tokens" class="ds-card-sub">0 tokens</div>
      </div>
      <div id="ds-stat-card-savings" class="ds-card">
        <div class="ds-card-title">预计节省</div>
        <div class="ds-card-val-green"><span id="ds-savings">¥0.00</span></div>
        <div id="ds-savings-tokens" class="ds-card-sub">0 tokens</div>
      </div>
      <div id="ds-stat-card-input-cost" class="ds-card">
        <div class="ds-card-title">输入费用</div>
        <div class="ds-card-val"><span id="ds-input-cost">¥0.00</span></div>
        <div id="ds-input-tokens" class="ds-card-sub">0 tokens</div>
      </div>
      <div id="ds-stat-card-output-cost" class="ds-card">
        <div class="ds-card-title">输出费用</div>
        <div class="ds-card-val"><span id="ds-output-cost">¥0.00</span></div>
        <div id="ds-output-tokens" class="ds-card-sub">0 tokens</div>
      </div>
      <div id="ds-stat-card-total-tokens" class="ds-card">
        <div class="ds-card-title">总 Tokens</div>
        <div class="ds-card-val"><span id="ds-stat-total-tokens">0</span></div>
        <div id="ds-stat-total-tokens-sub" class="ds-card-sub">单轮平均 0</div>
      </div>
      <div id="ds-stat-card-hit-tokens" class="ds-card">
        <div class="ds-card-title">命中 Tokens</div>
        <div class="ds-card-val-green"><span id="ds-stat-hit-tokens">0</span></div>
        <div id="ds-stat-hit-tokens-sub" class="ds-card-sub">占输入 0%</div>
      </div>
      <div id="ds-stat-card-miss-tokens" class="ds-card">
        <div class="ds-card-title">未命中 Tokens</div>
        <div class="ds-card-val"><span id="ds-stat-miss-tokens">0</span></div>
        <div id="ds-stat-miss-tokens-sub" class="ds-card-sub">占输入 0%</div>
      </div>
      <div id="ds-stat-card-rounds-count" class="ds-card">
        <div class="ds-card-title">对话轮数</div>
        <div class="ds-card-val"><span id="ds-stat-rounds-count">0</span></div>
        <div id="ds-stat-rounds-count-sub" class="ds-card-sub">轮对话</div>
      </div>
      <div id="ds-stat-card-max-turn-cost" class="ds-card">
        <div class="ds-card-title">单轮最大</div>
        <div class="ds-card-val"><span id="ds-stat-max-turn-cost">¥0.00</span></div>
        <div id="ds-stat-max-turn-cost-sub" class="ds-card-sub">暂无数据</div>
      </div>
      <div id="ds-stat-card-avg-turn-tokens" class="ds-card">
        <div class="ds-card-title">单轮平均 Tokens</div>
        <div class="ds-card-val"><span id="ds-stat-avg-turn-tokens">0</span></div>
        <div id="ds-stat-avg-turn-tokens-sub" class="ds-card-sub">输 0 · 出 0</div>
      </div>
      <div id="ds-stat-card-latest-hit-rate" class="ds-card">
        <div class="ds-card-title">最新命中率</div>
        <div class="ds-card-val-green"><span id="ds-stat-latest-hit-rate">-</span></div>
        <div id="ds-stat-latest-hit-rate-sub" class="ds-card-sub">暂无数据</div>
      </div>
      <div id="ds-stat-card-hit-miss-ratio" class="ds-card ds-card-strip">
        <div style="display:flex; flex-direction:column; flex-shrink:0;">
          <div class="ds-card-title" style="margin-bottom:0;">命中 / 未命中</div>
          <div id="ds-stat-hit-miss-ratio-sub" class="ds-card-sub" style="margin-top:2px;">输出 0 token</div>
        </div>
        <div style="flex:1; margin:0 16px; display:flex; flex-direction:column; gap:4px; min-width:0;">
          <div id="ds-hit-miss-bar-bg" style="background:rgba(255,255,255,0.06); border-radius:4px; height:6px; overflow:hidden; display:flex;">
            <div id="ds-hit-miss-bar-hit"  style="background:var(--SmartThemeQuoteColor); width:0%; height:100%; transition:width 0.3s;"></div>
            <div id="ds-hit-miss-bar-miss" style="background:var(--SmartThemeUnderlineColor); width:0%; height:100%; transition:width 0.3s;"></div>
          </div>
          <div style="display:flex; justify-content:space-between; font-size:9px; color:var(--SmartThemeEmColor, #9ca3af);">
            <span id="ds-hit-miss-lbl-hit">命中: 0.0%</span>
            <span id="ds-hit-miss-lbl-miss">未命中: 0.0%</span>
          </div>
        </div>
        <div style="text-align:right; flex-shrink:0;">
          <div class="ds-card-val" style="font-size: 16px; white-space: nowrap;"><span id="ds-stat-hit-miss-ratio">0 / 0</span></div>
        </div>
      </div>
      <div id="ds-stat-card-avg-input-tokens" class="ds-card">
        <div class="ds-card-title">单轮平均输入</div>
        <div class="ds-card-val"><span id="ds-stat-avg-input-tokens">0</span></div>
        <div id="ds-stat-avg-input-tokens-sub" class="ds-card-sub">暂无数据</div>
      </div>
      <div id="ds-stat-card-avg-output-tokens" class="ds-card">
        <div class="ds-card-title">单轮平均输出</div>
        <div class="ds-card-val"><span id="ds-stat-avg-output-tokens">0</span></div>
        <div id="ds-stat-avg-output-tokens-sub" class="ds-card-sub">占总数 0%</div>
      </div>
      <div id="ds-stat-card-savings-rate" class="ds-card">
        <div class="ds-card-title">节省比例</div>
        <div class="ds-card-val-green"><span id="ds-stat-savings-rate">0%</span></div>
        <div id="ds-stat-savings-rate-sub" class="ds-card-sub">节省 ¥0.00</div>
      </div>
      <div id="ds-stat-card-min-turn-cost" class="ds-card">
        <div class="ds-card-title">单轮最小</div>
        <div class="ds-card-val"><span id="ds-stat-min-turn-cost">¥0.00</span></div>
        <div id="ds-stat-min-turn-cost-sub" class="ds-card-sub">暂无数据</div>
      </div>
      <div id="ds-stat-card-max-turn-tokens" class="ds-card">
        <div class="ds-card-title">单轮最大 Tokens</div>
        <div class="ds-card-val"><span id="ds-stat-max-turn-tokens">0</span></div>
        <div id="ds-stat-max-turn-tokens-sub" class="ds-card-sub">暂无数据</div>
      </div>
      <div id="ds-stat-card-min-turn-tokens" class="ds-card">
        <div class="ds-card-title">单轮最小 Tokens</div>
        <div class="ds-card-val"><span id="ds-stat-min-turn-tokens">0</span></div>
        <div id="ds-stat-min-turn-tokens-sub" class="ds-card-sub">暂无数据</div>
      </div>
    </div>
  </div>

  <!-- 最新一条模块 -->
  <div id="ds-module-latest" class="ds-margin-b-16">
    <div class="ds-section-title ds-margin-b-12">
      <div class="ds-title-indicator"></div>
      <span>最新一条</span>
    </div>
    <div id="ds-latest" class="ds-card">
      <div class="ds-wait-text">等待第一次对话...</div>
    </div>
  </div>

  <!-- 历史记录模块 -->
  <div id="ds-module-history" class="ds-margin-b-16">
    <div class="ds-section-title ds-margin-b-12">
      <div class="ds-title-indicator"></div>
      <span>历史记录</span>
    </div>
    <div id="ds-history">
      <div class="ds-wait-text">暂无历史记录</div>
    </div>
  </div>

  <!-- 提示词缓存断点对比模块 -->
  <div id="ds-module-diff" class="ds-margin-b-16">
    <div class="ds-flex-between ds-margin-b-12">
      <div class="ds-section-title">
        <div class="ds-title-indicator"></div>
        <span>缓存断点</span>
      </div>
      <div class="ds-flex-row">
        <button id="ds-btn-diff-fullscreen" class="ds-btn ds-btn-sm ds-btn-normal" style="padding: 4px 8px;" title="全屏对比">
          <i class="fa-solid fa-expand"></i>
        </button>
      </div>
    </div>
    <div id="ds-diff" class="ds-card" style="padding:12px; font-family:system-ui,-apple-system,sans-serif">
      <div class="ds-wait-text">请在下方历史记录中选择"旧请求"和"新请求"进行对比</div>
    </div>
  </div>

</div>
`;

// ─── IndexedDB Persistent Helper ──────────────────────────────────────────────
var DB_NAME    = 'deepseek_stats_db';
var STORE_NAME = 'settings_store';
var DB_VERSION = 1;
var useLocalStorageFallback = false;

function getDB() {
  if (useLocalStorageFallback) return Promise.reject(new Error('IndexedDB in fallback mode'));
  return new Promise(function (resolve, reject) {
    try {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
      };
      request.onsuccess = function (e) { resolve(e.target.result); };
      request.onerror   = function (e) { useLocalStorageFallback = true; reject(e.target.error); };
    } catch (err) { useLocalStorageFallback = true; reject(err); }
  });
}

function dbGet(key) {
  if (useLocalStorageFallback) {
    try { return Promise.resolve(localStorage.getItem('ds_ext_' + key)); } catch (e) { return Promise.resolve(null); }
  }
  return getDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      try {
        var tx = db.transaction([STORE_NAME], 'readonly');
        var req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror   = function (e) { reject(e.target.error); };
      } catch (err) { reject(err); }
    });
  }).catch(function (err) {
    console.warn('[DS] dbGet fallback:', err);
    useLocalStorageFallback = true;
    try { return localStorage.getItem('ds_ext_' + key); } catch (e) { return null; }
  });
}

function dbSet(key, value) {
  if (useLocalStorageFallback) {
    try { localStorage.setItem('ds_ext_' + key, value); return Promise.resolve(); } catch (e) { return Promise.resolve(); }
  }
  return getDB().then(function (db) {
    return new Promise(function (resolve, reject) {
      try {
        var tx  = db.transaction([STORE_NAME], 'readwrite');
        var req = tx.objectStore(STORE_NAME).put(value, key);
        req.onsuccess = function () { resolve(); };
        req.onerror   = function (e) { reject(e.target.error); };
      } catch (err) { reject(err); }
    });
  }).catch(function (err) {
    console.warn('[DS] dbSet fallback:', err);
    useLocalStorageFallback = true;
    try { localStorage.setItem('ds_ext_' + key, value); } catch (e) {}
  });
}

async function migrateLocalStorageToIndexedDB() {
  try {
    var migratedKey = 'ds_db_migrated';
    if (await dbGet(migratedKey)) return;
    var keys = [KEY_STORAGE, BALANCE_STORAGE, SAVES_STORAGE, CURRENT_SAVE_KEY,
                SETTINGS_STORAGE, MESSAGE_COUNT_STORAGE, CUSTOM_BALANCE_STORAGE, 'ds_last_real_save'];
    for (var i = 0; i < keys.length; i++) {
      var v = localStorage.getItem('ds_ext_' + keys[i]);
      if (v !== null) await dbSet(keys[i], v);
    }
    await dbSet(migratedKey, true);
    console.log('[DS] LocalStorage → IndexedDB migration done.');
  } catch (e) { console.warn('[DS] Migration failed:', e); }
}

async function saveDataAsync(key, value) {
  try {
    if (typeof getAllVariables === 'function' && typeof replaceVariables === 'function') {
      var v = getAllVariables(); v[key] = value; replaceVariables(v);
    }
  } catch (e) {}
  await dbSet(key, value);
}

async function loadDataAsync(key) {
  try {
    if (typeof getAllVariables === 'function') {
      var v = getAllVariables();
      if (v && v[key] != null) return v[key];
    }
  } catch (e) {}
  var val = await dbGet(key);
  return val !== undefined ? val : null;
}

function saveData(key, value) { saveDataAsync(key, value).catch(function (e) { console.warn('[DS] saveData error:', e); }); }

// ─── Viewport helper ───────────────────────────────────────────────────────────
function syncViewportHeight() {
  try {
    var p = window.parent || window;
    var h = (p.visualViewport && p.visualViewport.height) || p.innerHeight || 640;
    p.document.documentElement.style.setProperty('--ds-vvh', Math.max(320, Math.round(h)) + 'px');
  } catch (e) {}
}

// ─── Module ordering helpers ──────────────────────────────────────────────────
function applyModuleOrder() {
  try {
    var doc = getDoc();
    var container = doc.getElementById('ds-modules-container');
    if (!container) return;
    var order = state.settings.moduleOrder || ['balance', 'stats', 'latest', 'history', 'diff'];
    order.forEach(function (key) {
      var el = doc.getElementById('ds-module-' + key);
      if (el) container.appendChild(el);
    });
  } catch (e) { console.warn('[DS] applyModuleOrder:', e); }
}

function applyModuleVisibility() {
  try {
    var doc = getDoc();
    var validModules = ['balance', 'stats', 'latest', 'history', 'diff'];
    var visibility = state.settings.moduleVisibility || {};
    validModules.forEach(function (key) {
      var el = doc.getElementById('ds-module-' + key);
      if (el) {
        var vis = visibility[key] !== false;
        el.style.setProperty('display', vis ? '' : 'none', vis ? '' : 'important');
      }
    });
  } catch (e) { console.warn('[DS] applyModuleVisibility:', e); }
}

function applyStatsVisibility() {
  try {
    var doc = getDoc();
    var visibility = state.settings.statsVisibility || {};
    var keys = [
      'total-cost','hit-rate','avg-cost','savings','input-cost','output-cost',
      'total-tokens','hit-tokens','miss-tokens','rounds-count','max-turn-cost','avg-turn-tokens',
      'latest-hit-rate','hit-miss-ratio','avg-input-tokens','avg-output-tokens','savings-rate',
      'min-turn-cost','max-turn-tokens','min-turn-tokens'
    ];
    keys.forEach(function (k) {
      var el = doc.getElementById('ds-stat-card-' + k);
      if (el) {
        var vis = visibility[k] !== false;
        el.style.setProperty('display', vis ? '' : 'none', vis ? '' : 'important');
      }
    });
  } catch (e) { console.warn('[DS] applyStatsVisibility:', e); }
}

function renderStatsCustomizerSettings(doc) {
  try {
    var listEl = doc.getElementById('ds-stats-custom-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    var visibility = state.settings.statsVisibility || {};
    var keys = [
      'total-cost','hit-rate','avg-cost','savings','input-cost','output-cost',
      'total-tokens','hit-tokens','miss-tokens','rounds-count','max-turn-cost','avg-turn-tokens',
      'latest-hit-rate','hit-miss-ratio','avg-input-tokens','avg-output-tokens','savings-rate',
      'min-turn-cost','max-turn-tokens','min-turn-tokens'
    ];
    var names = {
      'total-cost':'总消耗','hit-rate':'加权缓存命中率','avg-cost':'平均每轮','savings':'预计节省',
      'input-cost':'输入费用','output-cost':'输出费用','total-tokens':'总Tokens','hit-tokens':'命中Tokens',
      'miss-tokens':'未命中Tokens','rounds-count':'对话轮数','max-turn-cost':'单轮最大','avg-turn-tokens':'单轮平均',
      'latest-hit-rate':'最新命中率','hit-miss-ratio':'命中 / 未命中','avg-input-tokens':'单轮平均输入',
      'avg-output-tokens':'单轮平均输出','savings-rate':'节省比例','min-turn-cost':'单轮最小',
      'max-turn-tokens':'单轮最大 Tokens','min-turn-tokens':'单轮最小 Tokens'
    };
    keys.forEach(function (key) {
      var lbl = doc.createElement('label');
      lbl.style.cssText = 'display:flex;align-items:center;gap:4px;cursor:pointer;margin:0;font-size:11px;min-width:0;padding:2px 0;';
      var chk = doc.createElement('input');
      chk.type = 'checkbox'; chk.style.margin = '0'; chk.style.cursor = 'pointer';
      chk.checked = visibility[key] !== false;
      chk.onchange = function () {
        state.settings.statsVisibility[key] = this.checked;
        saveSettings(); applyStatsVisibility();
      };
      lbl.appendChild(chk);
      var span = doc.createElement('span');
      span.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      span.textContent = names[key];
      lbl.appendChild(span);
      listEl.appendChild(lbl);
    });
  } catch (e) { console.warn('[DS] renderStatsCustomizerSettings:', e); }
}

function renderModuleOrderSettings(doc) {
  try {
    var listEl = doc.getElementById('ds-module-order-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    var order = state.settings.moduleOrder || ['balance','stats','latest','history','diff'];
    var visibility = state.settings.moduleVisibility || {};
    var names = { balance:'钱包余额', stats:'统计概览', latest:'最新一条', history:'历史记录', diff:'缓存断点' };
    order.forEach(function (key, index) {
      var row = doc.createElement('div');
      row.className = 'ds-flex-between';
      row.style.cssText = 'background:rgba(255,255,255,0.03);padding:4px 6px;border-radius:6px;border:1px solid var(--SmartThemeBorderColor,#374151);font-size:12px;align-items:center;margin-bottom:4px;gap:6px;';
      var lbl = doc.createElement('label');
      lbl.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;margin:0;flex:1;min-width:0;';
      var chk = doc.createElement('input');
      chk.type = 'checkbox'; chk.style.cssText = 'margin:0;cursor:pointer;';
      chk.checked = visibility[key] !== false;
      chk.onchange = function () { state.settings.moduleVisibility[key] = this.checked; saveSettings(); applyModuleVisibility(); };
      lbl.appendChild(chk);
      var span = doc.createElement('span');
      span.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      span.textContent = names[key]; lbl.appendChild(span); row.appendChild(lbl);
      var btns = doc.createElement('div');
      btns.style.cssText = 'display:flex;gap:3px;flex-shrink:0;';
      ['▲','▼'].forEach(function (sym, di) {
        var btn = doc.createElement('button');
        btn.className = 'ds-btn ds-btn-sm ds-btn-normal';
        btn.style.cssText = 'padding:2px 5px;font-size:9px;line-height:1;';
        btn.innerHTML = sym;
        btn.disabled = di === 0 ? index === 0 : index === order.length - 1;
        btn.onclick = function (e) { e.preventDefault(); e.stopPropagation(); moveModule(index, di === 0 ? -1 : 1); };
        btns.appendChild(btn);
      });
      row.appendChild(btns); listEl.appendChild(row);
    });
  } catch (e) { console.warn('[DS] renderModuleOrderSettings:', e); }
}

function moveModule(index, direction) {
  try {
    var order = state.settings.moduleOrder || ['balance','stats','latest','history','diff'];
    var ti = index + direction;
    if (ti < 0 || ti >= order.length) return;
    var temp = order[index]; order[index] = order[ti]; order[ti] = temp;
    state.settings.moduleOrder = order;
    saveSettings();
    var doc = getDoc();
    renderModuleOrderSettings(doc);
    applyModuleOrder();
  } catch (e) { console.warn('[DS] moveModule:', e); }
}

// ─── Data loading + migration ──────────────────────────────────────────────────
async function loadSavedData() {
  try {
    // Load legacy fields for migration
    state.apiKey = decryptKey(await loadDataAsync(KEY_STORAGE)) || '';
    var bd = await loadDataAsync(BALANCE_STORAGE);
    if (bd) { try { state.balance = JSON.parse(bd); } catch (e) {} }
    var cbd = await loadDataAsync(CUSTOM_BALANCE_STORAGE);
    state.customBalance = (cbd && cbd !== '') ? cbd : null;

    var sd = await loadDataAsync(SAVES_STORAGE);
    if (sd) { try { state.saves = JSON.parse(sd); } catch (e) {} }

    var std = await loadDataAsync(SETTINGS_STORAGE);
    if (std) {
      try {
        var persisted = JSON.parse(std);
        state.settings = Object.assign({}, DEFAULT_SETTINGS, persisted);

        // Ensure moduleOrder
        var validModules = ['balance','stats','latest','history','diff'];
        if (!Array.isArray(state.settings.moduleOrder)) {
          state.settings.moduleOrder = ['balance','stats','latest','history','diff'];
        } else {
          state.settings.moduleOrder = state.settings.moduleOrder.filter(function (m) { return validModules.indexOf(m) !== -1; });
          validModules.forEach(function (m) { if (state.settings.moduleOrder.indexOf(m) === -1) state.settings.moduleOrder.push(m); });
        }
        // Ensure moduleVisibility
        if (!state.settings.moduleVisibility) {
          state.settings.moduleVisibility = { balance:true, stats:true, latest:true, history:true, diff:true };
        } else {
          validModules.forEach(function (m) { if (state.settings.moduleVisibility[m] === undefined) state.settings.moduleVisibility[m] = true; });
        }
        // Ensure statsVisibility
        if (!state.settings.statsVisibility) {
          state.settings.statsVisibility = Object.assign({}, DEFAULT_SETTINGS.statsVisibility);
        } else {
          Object.keys(DEFAULT_SETTINGS.statsVisibility).forEach(function (k) {
            if (state.settings.statsVisibility[k] === undefined) state.settings.statsVisibility[k] = DEFAULT_SETTINGS.statsVisibility[k];
          });
        }
      } catch (e) {}
    }

    var mc = await loadDataAsync(MESSAGE_COUNT_STORAGE);
    state.messageCount = parseInt(mc || '0', 10) || 0;
    state.lastRealSave = await loadDataAsync('ds_last_real_save') || '';
  } catch (e) { console.error('[DS] loadSavedData error:', e); }
}

// ─── Channel initialization & migration ───────────────────────────────────────
function makeNewChannelId() {
  return 'ch_' + Math.random().toString(36).slice(2, 10);
}

function makeNewRuleId() {
  return 'rule_' + Math.random().toString(36).slice(2, 10);
}

function initDefaultChannels() {
  if (state.settings.isDsOfficialDeleted) return;
  var channels = state.settings.channels;
  if (!Array.isArray(channels)) channels = [];

  // Check if DS official channel already exists
  var dsExists = channels.some(function (ch) { return ch.id === 'ch_ds_official'; });

  if (!dsExists) {
    // Migrate old single-channel data into DS official channel
    var dsChannel = {
      id: 'ch_ds_official',
      name: 'DS官方',
      color: '#6366f1',
      isDefault: true,
      apiKey: state.apiKey || '',
      balanceQueryType: 'deepseek',
      balanceQueryUrl: '',
      balance: state.balance || null,
      customBalance: state.customBalance || null,
      autoBalance: state.settings.autoBalance || false,
      balanceInterval: state.settings.balanceInterval || 10,
      messageCount: state.messageCount || 0,
      useNewPricing: state.settings.useNewPricing || false,
      newPricingDate: state.settings.newPricingDate || new Date('2026-07-15T00:00:00+08:00').getTime(),
      peakHours: [
        { start: '09:00', end: '12:00' },
        { start: '14:00', end: '18:00' }
      ],
      pricingRules: cloneDefaultRules(),
    };
    channels.unshift(dsChannel);
    state.settings.channels = channels;
    saveSettings();
    console.log('[DS] Migrated legacy data to DS official channel.');
    return;
  }

  // Ensure default DS official channel has all required default rules
  var dsChannel = channels.find(function (ch) { return ch.id === 'ch_ds_official'; });
  if (dsChannel) {
    if (!Array.isArray(dsChannel.pricingRules)) dsChannel.pricingRules = [];
    DS_DEFAULT_RULES.forEach(function (defRule) {
      var exists = dsChannel.pricingRules.some(function (r) { return r.id === defRule.id; });
      if (!exists) {
        dsChannel.pricingRules.push(Object.assign({}, defRule,
          { peak: Object.assign({}, defRule.peak), offpeak: Object.assign({}, defRule.offpeak) }));
      }
    });
  }

  state.settings.channels = channels;
}

// ─── Persistence ──────────────────────────────────────────────────────────────
function saveSaves() {
  _mergedStatsCache = null; _mergedStatsCacheKey = '';
  if (_saveSavesTimer) clearTimeout(_saveSavesTimer);
  _saveSavesTimer = setTimeout(async function () {
    _saveSavesTimer = null;
    await saveDataAsync(SAVES_STORAGE, JSON.stringify(state.saves));
  }, 500);
}
async function saveCurrentSaveKey()  { await saveDataAsync(CURRENT_SAVE_KEY, state.currentSave || ''); }
async function saveSettings()        { await saveDataAsync(SETTINGS_STORAGE, JSON.stringify(state.settings)); }
async function saveMessageCount()    { await saveDataAsync(MESSAGE_COUNT_STORAGE, String(state.messageCount)); }
async function saveLastRealSaveKey() { await saveDataAsync('ds_last_real_save', state.lastRealSave || ''); }

// ─── Save management ──────────────────────────────────────────────────────────
async function loadCurrentSave() {
  try {
    var k = await loadDataAsync(CURRENT_SAVE_KEY);
    if (k && state.saves[k]) { state.currentSave = k; }
    else if (Object.keys(state.saves).length > 0) {
      var keys = Object.keys(state.saves), latest = keys[0], lt = 0;
      keys.forEach(function (key) { if ((state.saves[key].startTime || 0) > lt) { lt = state.saves[key].startTime; latest = key; } });
      state.currentSave = latest;
    } else { createNewSave(); }
  } catch (e) { createNewSave(); }
}

function createNewSave() {
  var cn = ''; try { cn = getContext().name2 || ''; } catch (e) {}
  var n   = new Date();
  var key = n.getFullYear() + String(n.getMonth() + 1).padStart(2, '0') + String(n.getDate()).padStart(2, '0') + '_' +
            String(n.getHours()).padStart(2, '0') + String(n.getMinutes()).padStart(2, '0') + String(n.getSeconds()).padStart(2, '0') + '_' + (cn || 'unknown');
  state.saves[key] = {
    name: key, character: cn, startTime: n.getTime(),
    total_tokens: 0, total_cost: 0, input_tokens: 0, output_tokens: 0,
    cache_hit_tokens: 0, cache_miss_tokens: 0, input_cost: 0, output_cost: 0,
    rounds: 0, history: [],
  };
  state.currentSave = key; state.lastRealSave = key;
  saveSaves(); saveCurrentSaveKey(); saveLastRealSaveKey();
  return key;
}

function getRealCurrentSave() {
  if (state.currentSave === '__all__') {
    if (state.lastRealSave && state.saves[state.lastRealSave]) return state.saves[state.lastRealSave];
    var keys = Object.keys(state.saves);
    if (keys.length === 0) return null;
    var latest = keys[0], lt = 0;
    keys.forEach(function (k) { if ((state.saves[k].startTime || 0) > lt) { lt = state.saves[k].startTime; latest = k; } });
    return state.saves[latest] || null;
  }
  return state.saves[state.currentSave] || null;
}

function getSelectedSaveForDisplay() {
  if (state.currentSave === '__all__') return getMergedStats();
  return state.saves[state.currentSave] || null;
}

function getMergedStats() {
  var cacheKey = Object.keys(state.saves).map(function (k) { return k + ':' + (state.saves[k].rounds || 0); }).join('|');
  if (_mergedStatsCache && _mergedStatsCacheKey === cacheKey) return _mergedStatsCache;
  var m = { total_tokens:0, total_cost:0, input_tokens:0, output_tokens:0,
            cache_hit_tokens:0, cache_miss_tokens:0, input_cost:0, output_cost:0,
            rounds:0, history:[], startTime: Date.now() };
  var ah = [], es = Date.now();
  Object.keys(state.saves).forEach(function (k) {
    var s = state.saves[k];
    m.total_tokens      += s.total_tokens      || 0;
    m.total_cost        += s.total_cost        || 0;
    m.input_tokens      += s.input_tokens      || 0;
    m.output_tokens     += s.output_tokens     || 0;
    m.cache_hit_tokens  += s.cache_hit_tokens  || 0;
    m.cache_miss_tokens += s.cache_miss_tokens || 0;
    m.input_cost        += s.input_cost        || 0;
    m.output_cost       += s.output_cost       || 0;
    m.rounds            += s.rounds            || 0;
    if (s.startTime && s.startTime < es) es = s.startTime;
    ah = ah.concat(s.history || []);
  });
  m.startTime = es;
  ah.sort(function (a, b) { return b.timestamp - a.timestamp; });
  m.history = ah.slice(0, 1000);
  _mergedStatsCache = m; _mergedStatsCacheKey = cacheKey;
  return m;
}

async function deleteSave(key) {
  if (!key || key === '__all__') return;
  delete state.saves[key];
  _mergedStatsCache = null; _mergedStatsCacheKey = '';
  saveSaves();
  if (state.lastRealSave === key) {
    state.lastRealSave = '';
    var keys = Object.keys(state.saves);
    if (keys.length > 0) state.lastRealSave = keys[0];
    await saveLastRealSaveKey();
  }
  if (state.currentSave === key) {
    var keys2 = Object.keys(state.saves);
    state.currentSave = keys2.length > 0 ? keys2[0] : null;
    if (!state.currentSave) createNewSave();
    await saveCurrentSaveKey();
  }
}

async function handleChatChanged() {
  try {
    var cn = ''; try { cn = getContext().name2 || ''; } catch (e) {}
    if (!cn) return;
    var keys = Object.keys(state.saves), matchKey = null, matchTime = 0;
    keys.forEach(function (k) {
      var s = state.saves[k];
      if (s && s.character === cn && s.startTime > matchTime) { matchTime = s.startTime; matchKey = k; }
    });
    if (matchKey) {
      if (state.currentSave !== '__all__') { state.currentSave = matchKey; await saveCurrentSaveKey(); }
      state.lastRealSave = matchKey; await saveLastRealSaveKey();
    } else {
      var isAllMode = (state.currentSave === '__all__');
      var newKey = createNewSave();
      if (isAllMode) { state.currentSave = '__all__'; await saveCurrentSaveKey(); }
      state.lastRealSave = newKey; await saveLastRealSaveKey();
    }
    if (isInitDone) refreshUI();
  } catch (e) { console.warn('[DS] handleChatChanged:', e); }
}

// ─── Channel helpers ──────────────────────────────────────────────────────────
function getChannels() { return state.settings.channels || []; }

function getChannelById(id) {
  return getChannels().find(function (ch) { return ch.id === id; }) || null;
}

// Returns { channel, rule, prices, pricingType } or null
function getActiveAPIKey(source) {
  if (!source) return '';
  var key = '';
  try {
    if (local_SECRET_KEYS && local_secret_state) {
      var sKey = local_SECRET_KEYS[source.toUpperCase()];
      var secrets = local_secret_state[sKey];
      if (secrets) {
        if (Array.isArray(secrets)) {
          var activeSecret = secrets.find(function (s) { return s.active; }) || secrets[0];
          if (activeSecret) {
            key = activeSecret.id || activeSecret.value || '';
          }
        } else if (typeof secrets === 'string') {
          key = secrets;
        } else if (typeof secrets === 'object') {
          key = secrets.id || secrets.value || '';
        }
      }
    }
  } catch (e) {}
  if (!key) {
    try {
      var doc = getDoc();
      var id = 'api_key_' + source.toLowerCase();
      var el = doc.getElementById(id);
      if (el) key = el.value.trim();
    } catch (e) {}
  }
  return key;
}

// Returns { channel, rule, prices, pricingType } or null
function matchChannelForModel(model, timestamp, apiKey) {
  if (!model) return null;
  var m = model.toLowerCase();
  var ts = timestamp || Date.now();
  var channels = getChannels();

  if (apiKey) {
    for (var ci = 0; ci < channels.length; ci++) {
      var ch = channels[ci];
      if (ch.apiKey && ch.apiKey.trim() === apiKey.trim()) {
        var rules = ch.pricingRules || [];
        for (var ri = 0; ri < rules.length; ri++) {
          var rule = rules[ri];
          if (!rule.enabled) continue;
          if (!rule.pattern) continue;
          if (m.indexOf(rule.pattern.toLowerCase()) !== -1) {
            var p, pricingType = 'match';
            if (rule.peak && rule.offpeak && ch.useNewPricing) {
              var afterDate = !ch.newPricingDate || ts >= ch.newPricingDate;
              if (afterDate) {
                var peak = isPeakHour(ts, ch);
                p = peak ? rule.peak : rule.offpeak;
                pricingType = peak ? 'peak' : 'offpeak';
              } else {
                p = { hit: rule.hit, miss: rule.miss, output: rule.output };
              }
            } else if (ch.useNewPricing) {
              var afterDate = !ch.newPricingDate || ts >= ch.newPricingDate;
              if (afterDate && isPeakHour(ts, ch)) {
                var isChatOrReasoner = m.indexOf('chat') !== -1 || m.indexOf('reasoner') !== -1;
                var multiplier = isChatOrReasoner ? 1 : 2;
                p = { hit: rule.hit * multiplier, miss: rule.miss * multiplier, output: rule.output * multiplier };
                pricingType = 'peak';
              } else {
                p = { hit: rule.hit, miss: rule.miss, output: rule.output };
                pricingType = 'offpeak';
              }
            } else {
              p = { hit: rule.hit, miss: rule.miss, output: rule.output };
            }
            return { channel: ch, rule: rule, prices: p, pricingType: pricingType };
          }
        }
      }
    }
  }

  for (var ci = 0; ci < channels.length; ci++) {
    var ch = channels[ci];
    var rules = ch.pricingRules || [];
    for (var ri = 0; ri < rules.length; ri++) {
      var rule = rules[ri];
      if (!rule.enabled) continue;
      if (!rule.pattern) continue;
      if (m.indexOf(rule.pattern.toLowerCase()) === -1) continue;
      // Matched!
      var p, pricingType = 'match';
      if (rule.peak && rule.offpeak && ch.useNewPricing) {
        var afterDate = !ch.newPricingDate || ts >= ch.newPricingDate;
        if (afterDate) {
          var peak = isPeakHour(ts, ch);
          p = peak ? rule.peak : rule.offpeak;
          pricingType = peak ? 'peak' : 'offpeak';
        } else {
          p = { hit: rule.hit, miss: rule.miss, output: rule.output };
        }
      } else if (ch.useNewPricing) {
        var afterDate = !ch.newPricingDate || ts >= ch.newPricingDate;
        if (afterDate && isPeakHour(ts, ch)) {
          var isChatOrReasoner = m.indexOf('chat') !== -1 || m.indexOf('reasoner') !== -1;
          var multiplier = isChatOrReasoner ? 1 : 2;
          p = { hit: rule.hit * multiplier, miss: rule.miss * multiplier, output: rule.output * multiplier };
          pricingType = 'peak';
        } else {
          p = { hit: rule.hit, miss: rule.miss, output: rule.output };
          pricingType = 'offpeak';
        }
      } else {
        p = { hit: rule.hit, miss: rule.miss, output: rule.output };
      }
      return { channel: ch, rule: rule, prices: p, pricingType: pricingType };
    }
  }
  return null;
}

function parsePeakHours(str) {
  var ranges = [];
  if (!str) return ranges;
  var parts = str.split(',');
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (!part) continue;
    var sub = part.split('-');
    if (sub.length === 2) {
      var start = sub[0].trim();
      var end = sub[1].trim();
      if (/^\d{1,2}:\d{2}$/.test(start) && /^\d{1,2}:\d{2}$/.test(end)) {
        ranges.push({ start: start, end: end });
      }
    }
  }
  return ranges;
}

function formatPeakHours(ranges) {
  if (!Array.isArray(ranges) || ranges.length === 0) return '09:00-12:00, 14:00-18:00';
  return ranges.map(function (r) { return r.start + '-' + r.end; }).join(', ');
}

// ─── Peak hour detection ──────────────────────────────────────────────────────
function isPeakHour(timestamp, ch) {
  var d = new Date(timestamp);
  var currentMinutes = (d.getUTCHours() * 60 + d.getUTCMinutes() + 8 * 60) % 1440;

  var ranges = (ch && ch.peakHours) || [
    { start: '09:00', end: '12:00' },
    { start: '14:00', end: '18:00' }
  ];

  for (var i = 0; i < ranges.length; i++) {
    var r = ranges[i];
    var startParts = r.start.split(':');
    var endParts = r.end.split(':');
    var startMinutes = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10);
    var endMinutes = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10);
    if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
      return true;
    }
  }
  return false;
}

// ─── Cost calculation (uses channel rules) ────────────────────────────────────
function calcCost(u, apiKey) {
  var timestamp = u.timestamp || Date.now();
  var model = u.model || '';
  var match = matchChannelForModel(model, timestamp, apiKey);
  if (!match) {
    return { input: 0, output: 0, total: 0, pricingType: 'unknown',
             channelId: '', channelName: '', ruleName: '', hitPrice: 0, missPrice: 0, outputPrice: 0 };
  }
  var p = match.prices;
  var ih = (u.prompt_cache_hit_tokens  / 1e6) * p.hit;
  var im = (u.prompt_cache_miss_tokens / 1e6) * p.miss;
  var o  = (u.completion_tokens        / 1e6) * p.output;
  return {
    input:       ih + im,
    output:      o,
    total:       ih + im + o,
    pricingType: match.pricingType,
    channelId:   match.channel.id,
    channelName: match.channel.name,
    ruleName:    match.rule.label || match.rule.pattern,
    hitPrice:    p.hit,
    missPrice:   p.miss,
    outputPrice: p.output,
  };
}

// ─── Hash & dedup ─────────────────────────────────────────────────────────────
function createTextHash(text) {
  if (typeof text !== 'string') return '';
  var hash = 2166136261;
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul ? Math.imul(hash, 16777619) : (hash * 16777619) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ─── Usage processing ─────────────────────────────────────────────────────────
async function processUsage(usage, model, isDebug, messages, requestId, apiKey) {
  logDebug('开始处理用量统计: model=' + model + ', isDebug=' + isDebug);
  var modelName = (model && model.trim()) ? model.trim() : '';
  if (!modelName && !isDebug) { try { modelName = getContext().model || ''; } catch (e) {} }
  if (!modelName) modelName = 'deepseek-v4-flash';

  var totalPrompt = usage.prompt_tokens || 0;
  var hit = 0;
  if (usage.prompt_cache_hit_tokens !== undefined) {
    hit = usage.prompt_cache_hit_tokens || 0;
  } else if (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens !== undefined) {
    hit = usage.prompt_tokens_details.cached_tokens || 0;
  }
  var miss = usage.prompt_cache_miss_tokens !== undefined
    ? (usage.prompt_cache_miss_tokens || 0)
    : Math.max(0, totalPrompt - hit);
  var comp  = usage.completion_tokens || 0;
  var total = usage.total_tokens || (hit + miss + comp);

  logDebug('用量详情: hit=' + hit + ', miss=' + miss + ', comp=' + comp + ', total=' + total);

  // Deduplication
  if (requestId) {
    if (processedRequestIds.indexOf(requestId) !== -1) {
      logDebug('检测到重复的 requestId: ' + requestId + ', 略过');
      return;
    }
    processedRequestIds.push(requestId);
    if (processedRequestIds.length > 100) processedRequestIds.shift();
  } else {
    var msgSig = (messages && messages.length > 0) ? messages.map(function (m) { return m.hash || ''; }).join(',') : '';
    var signature = msgSig + '_' + hit + '_' + miss + '_' + comp + '_' + modelName;
    var now = Date.now();
    if (signature === lastProcessedSignature && (now - lastProcessedTime) < 5000) {
      logDebug('检测到重复的请求签名, 略过');
      return;
    }
    lastProcessedSignature = signature; lastProcessedTime = now;
  }

  var lu = {
    timestamp: Date.now(), model: modelName,
    prompt_tokens: hit + miss,
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens: miss,
    completion_tokens: comp,
    total_tokens: total,
  };
  try {
    lu.cost = calcCost(lu, apiKey);
    logDebug('计费成功: channel=' + lu.cost.channelName + ', total=' + lu.cost.total.toFixed(4) + '元, pricingType=' + lu.cost.pricingType);
  } catch (e) {
    logDebug('估算费用发生异常: ' + e.message);
  }
  state.lastUsage = lu;

  var s = getRealCurrentSave();
  if (!s) {
    logDebug('❌ 写入失败: 找不到当前的活跃存档 (currentSave=' + state.currentSave + ', savesKeys=' + Object.keys(state.saves).join(',') + ')');
    return;
  }

  s.total_tokens      += lu.total_tokens;
  s.total_cost        += lu.cost.total;
  s.input_tokens      += lu.prompt_tokens;
  s.output_tokens     += lu.completion_tokens;
  s.cache_hit_tokens  += lu.prompt_cache_hit_tokens;
  s.cache_miss_tokens += lu.prompt_cache_miss_tokens;
  s.input_cost        += lu.cost.input;
  s.output_cost       += lu.cost.output;
  s.rounds            += 1;

  s.history.unshift({
    timestamp:         lu.timestamp,
    model:             lu.model,
    prompt_tokens:     lu.prompt_tokens,
    cache_hit_tokens:  lu.prompt_cache_hit_tokens,
    cache_miss_tokens: lu.prompt_cache_miss_tokens,
    completion_tokens: lu.completion_tokens,
    total_tokens:      lu.total_tokens,
    input_cost:        lu.cost.input,
    output_cost:       lu.cost.output,
    cost:              lu.cost.total,
    pricingType:       lu.cost.pricingType,
    channelId:         lu.cost.channelId,
    channelName:       lu.cost.channelName,
    ruleName:          lu.cost.ruleName,
    hitPrice:          lu.cost.hitPrice,
    missPrice:         lu.cost.missPrice,
    cache_hit_rate:    lu.prompt_tokens > 0 ? (lu.prompt_cache_hit_tokens / lu.prompt_tokens * 100) : 0,
    messages:          messages || [],
  });

  for (var i = 10; i < s.history.length; i++) {
    if (s.history[i].messages) delete s.history[i].messages;
  }
  if (s.history.length > 1000) s.history = s.history.slice(0, 1000);

  saveSaves();

  // Deduct balance only for priced requests
  if (lu.cost.pricingType !== 'unknown' && lu.cost.channelId) {
    var ch = getChannelById(lu.cost.channelId);
    if (ch) {
      if (ch.customBalance !== null && ch.customBalance !== '') {
        ch.customBalance = String(parseFloat(ch.customBalance) - lu.cost.total);
        await saveSettings();
      } else if (ch.balance && ch.balance.balance != null) {
        ch.balance.balance = parseFloat(ch.balance.balance) - lu.cost.total;
        await saveSettings();
      }

      // Per-channel auto-balance
      ch.messageCount = (ch.messageCount || 0) + 1;
      if (ch.autoBalance && ch.apiKey && ch.messageCount >= (ch.balanceInterval || 10)) {
        ch.messageCount = 0;
        await saveSettings();
        fetchChannelBalance(ch, true);
      }
    }
  }

  state.messageCount++;
  await saveMessageCount();

  refreshUI();
}

// ─── Balance API (per-channel) ────────────────────────────────────────────────
async function fetchChannelBalance(ch, silent) {
  if (!ch) return;
  if (!ch.apiKey) {
    if (!silent) updateChannelBalanceStatus(ch.id, '请先输入API密钥', null);
    return;
  }
  if (ch.balanceQueryType !== 'deepseek' && ch.balanceQueryType !== 'openai') {
    if (!silent) updateChannelBalanceStatus(ch.id, '该渠道无余额查询接口', null);
    return;
  }

  if (!silent) updateChannelBalanceStatus(ch.id, '查询中...', null);

  try {
    var url = ch.balanceQueryType === 'deepseek'
      ? 'https://api.deepseek.com/user/balance'
      : (ch.balanceQueryUrl || '');
    if (!url) { if (!silent) updateChannelBalanceStatus(ch.id, '未配置查询地址', null); return; }

    var r = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + ch.apiKey, 'Content-Type': 'application/json' },
    });
    var d = await r.json();

    // DeepSeek format
    if (ch.balanceQueryType === 'deepseek' && d.is_available && d.balance_infos && d.balance_infos.length > 0) {
      var info = d.balance_infos[0];
      ch.balance = { balance: info.total_balance, currency: info.currency, available: d.is_available, timestamp: Date.now() };
      await saveSettings();
      if (!silent) updateChannelBalanceStatus(ch.id, '账户可用 | ' + new Date().toLocaleTimeString('zh-CN'), ch.balance);
    }
    // OpenAI format: no standard balance endpoint; just show error
    else if (!silent) {
      var msg = (d.error && d.error.message) ? d.error.message : '查询失败';
      updateChannelBalanceStatus(ch.id, msg, null);
    }
  } catch (e) {
    if (!silent) updateChannelBalanceStatus(ch.id, e.message || '网络错误', null);
  }

  refreshUI();
}

function updateChannelBalanceStatus(chId, statusText, balance) {
  // Status is shown in the balance cards, just trigger a refresh
  refreshUI();
}

// ─── Remaining rounds estimate (per-channel) ──────────────────────────────────
function calculateRemainingRoundsForChannel(chHistory, availBal) {
  if (!availBal || availBal <= 0 || !chHistory || chHistory.length === 0) return null;
  var alpha = 0.3;
  var costs = chHistory.filter(function (h) { return (h.cost || 0) > 0; });
  if (costs.length === 0) return null;
  var ewma = costs[costs.length - 1].cost || 0;
  for (var i = costs.length - 2; i >= 0; i--) ewma = alpha * (costs[i].cost || 0) + (1 - alpha) * ewma;
  return ewma > 0 ? Math.floor(availBal / ewma) : null;
}

// ─── XOR encryption ───────────────────────────────────────────────────────────
var XOR_KEY = 'ds-stats-v1-xor-key!@#$%^&*';
function encryptKey(plaintext) {
  if (!plaintext) return '';
  var result = '';
  for (var i = 0; i < plaintext.length; i++) result += String.fromCharCode(plaintext.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
  return btoa(result);
}
function decryptKey(ciphertext) {
  if (!ciphertext) return '';
  try {
    var decoded = atob(ciphertext), result = '';
    for (var i = 0; i < decoded.length; i++) result += String.fromCharCode(decoded.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length));
    return result;
  } catch (e) { return ciphertext; }
}

// ─── Diff utilities ───────────────────────────────────────────────────────────
function commonPrefixLength(left, right) {
  var max = Math.min(left.length, right.length), i = 0;
  while (i < max && left.charCodeAt(i) === right.charCodeAt(i)) i++;
  return i;
}
function commonSuffixLength(left, right, prefixLength) {
  var li = left.length - 1, ri = right.length - 1, len = 0;
  while (li >= prefixLength && ri >= prefixLength && left.charCodeAt(li) === right.charCodeAt(ri)) { li--; ri--; len++; }
  return len;
}
function buildDiffContext(beforeText, afterText, contextSize) {
  if (!contextSize) contextSize = 800;
  var pl = commonPrefixLength(beforeText, afterText);
  var sl = commonSuffixLength(beforeText, afterText, pl);
  var be = beforeText.length - sl, ae = afterText.length - sl;
  var ps = Math.max(0, pl - contextSize), se2 = Math.min(beforeText.length, be + contextSize);
  return {
    prefix: beforeText.slice(ps, pl),
    beforeChanged: beforeText.slice(pl, be).slice(0, contextSize * 2),
    afterChanged: afterText.slice(pl, ae).slice(0, contextSize * 2),
    suffix: beforeText.slice(be, se2),
    prefixLength: pl, suffixLength: sl,
    beforeChangedLength: beforeText.slice(pl, be).length,
    afterChangedLength:  afterText.slice(pl, ae).length,
    hasMorePrefix: ps > 0, hasMoreSuffix: se2 < beforeText.length,
  };
}
function comparePromptRecords(before, after, contextSize) {
  if (!contextSize) contextSize = 800;
  if (!before || !after) return { kind: 'same', summary: '请选择旧请求和新请求进行对比。', context: null };
  var bm = before.messages || [], am = after.messages || [];
  var filterEmpty = function (msgs) {
    return msgs.map(function (m, idx) { return { index: idx, message: m }; }).filter(function (item) { return item.message.text.trim().length > 0; });
  };
  var bc = filterEmpty(bm), ac = filterEmpty(am);
  var maxLen = Math.max(bc.length, ac.length);
  for (var i = 0; i < maxLen; i++) {
    var bi = bc[i], ai = ac[i];
    var bMsg = bi ? bi.message : null, aMsg = ai ? ai.message : null;
    if (!bMsg && aMsg) return { kind: 'message_added', summary: '第 ' + (ai.index + 1) + ' 条有效消息是新增的。', index: ai.index, beforeIndex: null, afterIndex: ai.index, beforeRole: null, afterRole: aMsg.role, beforeLength: 0, afterLength: aMsg.length, context: buildDiffContext('', aMsg.text, contextSize) };
    if (bMsg && !aMsg) return { kind: 'message_removed', summary: '第 ' + (bi.index + 1) + ' 条有效消息被移除。', index: bi.index, beforeIndex: bi.index, afterIndex: null, beforeRole: bMsg.role, afterRole: null, beforeLength: bMsg.length, afterLength: 0, context: buildDiffContext(bMsg.text, '', contextSize) };
    if (bMsg.role !== aMsg.role) return { kind: 'role_changed', summary: '第 ' + (ai.index + 1) + ' 条有效消息的角色从 ' + bMsg.role + ' 变更为 ' + aMsg.role + '。', index: ai.index, beforeIndex: bi.index, afterIndex: ai.index, beforeRole: bMsg.role, afterRole: aMsg.role, beforeLength: bMsg.length, afterLength: aMsg.length, context: buildDiffContext(bMsg.text, aMsg.text, contextSize) };
    if (bMsg.hash !== aMsg.hash || bMsg.text !== aMsg.text) return { kind: 'content_changed', summary: '第 ' + (ai.index + 1) + ' 条有效 ' + aMsg.role + ' 消息内容发生变化。', index: ai.index, beforeIndex: bi.index, afterIndex: ai.index, beforeRole: bMsg.role, afterRole: aMsg.role, beforeLength: bMsg.length, afterLength: aMsg.length, context: buildDiffContext(bMsg.text, aMsg.text, contextSize) };
  }
  return { kind: 'same', summary: '两次请求的有效消息内容完全一致。', index: null, beforeIndex: null, afterIndex: null, beforeRole: null, afterRole: null, beforeLength: 0, afterLength: 0, context: null };
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function formatStartTime(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}
function formatTokens(val) {
  var num = parseFloat(val) || 0;
  if (num >= 10000) return (num / 10000).toFixed(1) + '万';
  if (num >= 1000)  return (num / 1000).toFixed(1) + 'k';
  return String(Math.round(num));
}
function escapeHTML(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function formatYMD(ts) {
  try {
    var opts = { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' };
    var parts = new Intl.DateTimeFormat('zh-CN', opts).formatToParts(new Date(ts));
    var y = '', m = '', d2 = '';
    parts.forEach(function (p) { if (p.type === 'year') y = p.value; if (p.type === 'month') m = p.value; if (p.type === 'day') d2 = p.value; });
    return y + '-' + m + '-' + d2;
  } catch (e) {
    var d = new Date(ts + 8 * 3600000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2,'0') + '-' + String(d.getUTCDate()).padStart(2,'0');
  }
}
function makeId(prefix) { return (prefix || 'id') + '_' + Math.random().toString(36).slice(2, 8); }

// ─── Dynamic Theme Helpers ────────────────────────────────────────────────────
function getDoc() {
  try { if (window.parent && window.parent.document) return window.parent.document; } catch (e) {}
  return document;
}
function getWin() { return window.parent || window; }

function updateDynamicThemeColors() {
  try {
    var p = getWin(), doc = getDoc();
    var panel = doc.getElementById('ds-panel');
    if (!panel) return;
    var temp = doc.createElement('div');
    temp.style.color = 'var(--SmartThemeBlurTintColor, #080d14)';
    doc.body.appendChild(temp);
    var color = p.getComputedStyle(temp).color;
    doc.body.removeChild(temp);
    var opaqueColor = '#080d14';
    if (color && color !== 'transparent') {
      var match = color.match(/rgba?\((\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)(?:[,\s/]+(\d+(?:\.\d+)?%?))?/);
      if (match) {
        var r = Math.round(parseFloat(match[1]));
        var g = Math.round(parseFloat(match[2]));
        var b = Math.round(parseFloat(match[3]));
        var a = 1;
        if (match[4] !== undefined) {
          a = match[4].endsWith('%') ? parseFloat(match[4]) / 100 : parseFloat(match[4]);
        }
        if (a > 0) {
          opaqueColor = 'rgb(' + r + ', ' + g + ', ' + b + ')';
        }
      } else if (color.startsWith('#')) {
        opaqueColor = color;
      } else if (color.startsWith('oklch') || color.startsWith('color') || color.startsWith('hsl') || color.startsWith('hwb')) {
        opaqueColor = color.replace(/\s*\/\s*[\d.]+%?\s*\)/, ')');
      }
    }
    panel.style.setProperty('--ds-bg-opaque', opaqueColor);
    panel.style.setProperty('--ds-text-color', 'var(--SmartThemeBodyColor, #f3f4f6)');
    panel.style.setProperty('--ds-border-color', 'var(--SmartThemeBorderColor, #374151)');
    panel.style.setProperty('--ds-shadow-color', 'var(--SmartThemeShadowColor, rgba(0,0,0,0.5))');
  } catch (e) { console.warn('[DS] updateDynamicThemeColors:', e); }
}

function applyDisplayMode() {
  var mode = state.settings.displayMode || 'wand-modal';
  var doc = getDoc();
  var panel = doc.getElementById('ds-panel');
  if (panel) {
    panel.classList.remove('ds-fullscreen','ds-qr-top','ds-qr-bottom','ds-qr-left','ds-qr-right');
    if (mode === 'wand-fullscreen') panel.classList.add('ds-fullscreen');
    else if (mode === 'qr-top')    panel.classList.add('ds-qr-top');
    else if (mode === 'qr-bottom') panel.classList.add('ds-qr-bottom');
    else if (mode === 'qr-left')   panel.classList.add('ds-qr-left');
    else if (mode === 'qr-right')  panel.classList.add('ds-qr-right');
  }
  var wandBtn = doc.getElementById('ds_wand_container');
  if (wandBtn) {
    if (mode === 'wand-modal' || mode === 'wand-fullscreen') wandBtn.style.setProperty('display', 'flex', 'important');
    else wandBtn.style.setProperty('display', 'none', 'important');
  }
  ensureWalletButton();
}

function ensureWalletButton() {
  var mode = state.settings.displayMode || 'wand-modal';
  if (mode.indexOf('qr-') !== 0) { removeWalletButton(); return; }
  var doc = getDoc();
  var btnContainer = doc.querySelector('#qr--bar .qr--buttons') || doc.getElementById('qr--bar');
  if (!btnContainer) return;
  var btn = doc.getElementById('ds-qr-wallet-btn');
  if (btn) { if (!btnContainer.contains(btn)) btnContainer.appendChild(btn); return; }
  btn = doc.createElement('div');
  btn.id = 'ds-qr-wallet-btn';
  btn.className = 'qr--button menu_button interactable';
  btn.tabIndex = 0; btn.role = 'button'; btn.title = 'DeepSeek使用统计';
  btn.innerHTML = '<i class="fa-solid fa-wallet"></i>';
  btn.style.setProperty('display', 'inline-flex', 'important');
  btn.style.alignItems = 'center'; btn.style.justifyContent = 'center';
  btn.style.color = 'var(--SmartThemeBodyColor, #f3f4f6)';
  btn.style.transition = 'background-color 0.2s, transform 0.1s';
  btn.addEventListener('mouseenter', function () { btn.style.background = 'rgba(255,255,255,0.15)'; btn.style.transform = 'scale(1.05)'; });
  btn.addEventListener('mouseleave', function () { btn.style.background = 'transparent'; btn.style.transform = 'scale(1)'; });
  btn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); togglePanel(); });
  btnContainer.appendChild(btn);
}
function removeWalletButton() { var btn = getDoc().getElementById('ds-qr-wallet-btn'); if (btn) btn.remove(); }
function initWalletButtonObserver() {
  try {
    var doc = getDoc(), win = getWin();
    var MObs = win.MutationObserver || win.parent?.MutationObserver || window.MutationObserver;
    if (!MObs) return;
    if (walletBtnObserver) walletBtnObserver.disconnect();
    walletBtnObserver = new MObs(function () { if ((state.settings.displayMode || '').indexOf('qr-') === 0) ensureWalletButton(); });
    walletBtnObserver.observe(doc.body, { childList: true, subtree: true });
  } catch (e) { console.warn('[DS] initWalletButtonObserver:', e); }
}

// ─── Events + Fetch ───────────────────────────────────────────────────────────
function setupEvents() {
  logDebug('初始化事件监听中...');
  import('/scripts/secrets.js').then(function (m) {
    local_secret_state = m.secret_state;
    local_SECRET_KEYS = m.SECRET_KEYS;
    logDebug('secrets.js 动态导入成功');
  }).catch(function (e) {
    logDebug('secrets.js 动态导入失败: ' + e.message);
  });
  eventSource.on(event_types.MESSAGE_RECEIVED, function () {
    logDebug('收到消息接收事件 (MESSAGE_RECEIVED)');
    setTimeout(refreshUI, 500);
  });
  eventSource.on(event_types.CHAT_CHANGED, function () {
    logDebug('收到对话切换事件 (CHAT_CHANGED)');
    setTimeout(handleChatChanged, 500);
  });
}

function patchFetch() {
  var p = window.parent || window;
  if (p._ds_fetch_patched) return;
  var rawFetch = p.fetch;
  p.fetch = function () {
    var args = arguments;
    var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
    if (url && url.indexOf(TARGET_API) !== -1) {
      logDebug('拦截到 API 请求: ' + url);
      var capturedMessages = null;
      var req = null;
      try {
        if (args[1] && typeof args[1].body === 'string') {
          req = JSON.parse(args[1].body);
          if (req && Array.isArray(req.messages)) {
            capturedMessages = req.messages.map(function (m) {
              var t = m.content || m.text || '';
              return { role: m.role || 'unknown', text: t, length: t.length, hash: createTextHash(t) };
            });
            logDebug('解析请求体成功, 消息数: ' + capturedMessages.length);
          }
        }
      } catch (e) {
        logDebug('解析请求体异常: ' + e.message);
      }

      if (state.settings.debug) {
        logDebug('开启调试模式, 使用假数据生成模拟统计...');
        var fakeUsage = {
          prompt_cache_hit_tokens:  state.settings.debugHit,
          prompt_cache_miss_tokens: state.settings.debugMiss,
          completion_tokens:        state.settings.debugOutput,
          total_tokens: state.settings.debugHit + state.settings.debugMiss + state.settings.debugOutput,
        };
        setTimeout(function () { processUsage(fakeUsage, state.settings.debugModel, true, capturedMessages, 'debug-' + Date.now(), ''); }, 100);
        return rawFetch.apply(p, args);
      }

      logDebug('发送真实 Fetch 请求至服务器...');
      return rawFetch.apply(p, args).then(function (res) {
        logDebug('收到响应, 状态码: ' + res.status);
        var clone = res.clone();
        clone.text().then(function (text) {
          try {
            logDebug('读取响应体 text 成功 (长度: ' + text.length + ')');
            var data = null, trimmed = text.trim(), resId = '';
            if (trimmed.startsWith('{')) {
              data = JSON.parse(trimmed);
              if (data && data.id) resId = data.id;
              logDebug('解析非流式 JSON 响应成功');
            } else {
              var lines = text.split('\n');
              logDebug('解析流式 SSE 响应, 总行数: ' + lines.length);
              lines.forEach(function (line) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try {
                    var chunk = JSON.parse(line.substring(6));
                    if (chunk.id) resId = chunk.id;
                    if (chunk.usage) {
                      data = chunk;
                      logDebug('SSE 流中提取到 usage 数据');
                    }
                  } catch (e) {}
                }
              });
            }
            if (data && data.usage) {
              var source = req && req.chat_completion_source;
              logDebug('请求来源 backend: ' + source);
              var apiKey = getActiveAPIKey(source);
              logDebug('获取当前 backend 的 API 秘钥: ' + (apiKey ? '有 (长度:' + apiKey.length + ')' : '无'));
              processUsage(data.usage, data.model || '', false, capturedMessages, resId, apiKey);
            } else {
              logDebug('未匹配到有效的 usage 数据');
            }
          } catch (e) {
            logDebug('解析响应体出错: ' + e.message);
          }
        }).catch(function (e) {
          logDebug('读取克隆响应 text 失败: ' + e.message);
        });
        return res;
      });
    }
    return rawFetch.apply(p, args);
  };
  p._ds_fetch_patched = true;
  logDebug('Fetch hook 挂载完成');
}

// ─── UI Creation ──────────────────────────────────────────────────────────────
function createUI() {
  var p   = window.parent || window;
  var doc = p.document;

  ['ds-overlay','ds-panel'].forEach(function (id) { var el = doc.getElementById(id); if (el) el.remove(); });

  var overlay = doc.createElement('div');
  overlay.id = 'ds-overlay';
  overlay.addEventListener('click', function (e) { if (e.target === overlay) togglePanel(); });

  var panel = doc.createElement('div');
  panel.id = 'ds-panel';

  // Header
  var header = doc.createElement('div');
  header.className = 'ds-header';
  var titleEl = doc.createElement('div');
  titleEl.className = 'ds-header-title';
  titleEl.innerHTML = '<i class="fa-solid fa-fish" style="font-size: 18px;"></i>';
  header.appendChild(titleEl);
  var actionsEl = doc.createElement('div');
  actionsEl.style.cssText = 'display:flex;align-items:center;gap:8px;';
  var settingsIcon = doc.createElement('div');
  settingsIcon.id = 'ds-header-settings-btn';
  settingsIcon.className = 'ds-header-icon';
  settingsIcon.title = '设置';
  settingsIcon.innerHTML = '<i class="fa-solid fa-gear"></i>';
  actionsEl.appendChild(settingsIcon);
  var closeBtn = doc.createElement('div');
  closeBtn.className = 'ds-close-btn';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', function (e) { e.stopPropagation(); togglePanel(); });
  actionsEl.appendChild(closeBtn);
  header.appendChild(actionsEl);

  // Settings Dropdown
  var settingsDropdown = doc.createElement('div');
  settingsDropdown.id = 'ds-settings-dropdown';
  settingsDropdown.className = 'ds-settings-dropdown';
  settingsDropdown.innerHTML =
    '<details class="ds-dropdown-section">' +
      '<summary>界面入口及展示</summary>' +
      '<div class="ds-dropdown-section-content">' +
        ['wand-modal:魔法棒菜单 (当前形式)','wand-fullscreen:魔法棒菜单 (全屏)','qr-bar:QR 栏 (普通弹窗)',
         'qr-top:QR 栏 (自上方滑出)','qr-bottom:QR 栏 (自下方滑出)','qr-left:QR 栏 (自左侧滑出)','qr-right:QR 栏 (自右侧滑出)']
        .map(function (s) { var p2 = s.split(':'); return '<label class="ds-settings-dropdown-item"><input type="radio" name="ds-display-mode" value="' + p2[0] + '"><span>' + p2[1] + '</span></label>'; }).join('') +
      '</div>' +
    '</details>' +
    '<details class="ds-dropdown-section">' +
      '<summary>模块排序与显示</summary>' +
      '<div class="ds-dropdown-section-content"><div id="ds-module-order-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:6px;"></div></div>' +
    '</details>' +
    '<details class="ds-dropdown-section">' +
      '<summary>统计卡片定制</summary>' +
      '<div class="ds-dropdown-section-content"><div id="ds-stats-custom-list" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;"></div></div>' +
    '</details>' +
    '<details class="ds-dropdown-section" id="ds-channel-manager-section">' +
      '<summary>渠道管理</summary>' +
      '<div class="ds-dropdown-section-content"><div id="ds-channel-manager"></div></div>' +
    '</details>' +
    '<details class="ds-dropdown-section">' +
      '<summary>调试模式</summary>' +
      '<div class="ds-dropdown-section-content">' +
        '<div class="ds-flex-between ds-margin-b-8"><span class="ds-switch-label" style="font-size:12px">开启调试</span>' +
        '<label class="ds-switch"><input type="checkbox" id="ds-debug-mode"><span class="ds-switch-slider"></span></label></div>' +
        '<div id="ds-debug-panel" style="display:none;margin-top:6px;">' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:4px">' +
            '<div><div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px">命中 tokens</div>' +
            '<input id="ds-debug-hit" type="number" min="0" value="10000" class="ds-input-compact" style="height:22px;padding:2px 4px;font-size:11px;"></div>' +
            '<div><div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px">未命中 tokens</div>' +
            '<input id="ds-debug-miss" type="number" min="0" value="5000" class="ds-input-compact" style="height:22px;padding:2px 4px;font-size:11px;"></div>' +
            '<div><div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px">输出 tokens</div>' +
            '<input id="ds-debug-output" type="number" min="0" value="2000" class="ds-input-compact" style="height:22px;padding:2px 4px;font-size:11px;"></div>' +
            '<div><div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px">模型</div>' +
            '<input id="ds-debug-model" type="text" value="deepseek-v4-flash" class="ds-input-compact" style="height:22px;padding:2px 4px;font-size:11px;" placeholder="模型名"></div>' +
          '</div>' +
          '<div id="ds-debug-status" style="font-size:10px;color:var(--SmartThemeQuoteColor)"></div>' +
        '</div>' +
      '</div>' +
    '</details>' +
    '<details class="ds-dropdown-section">' +
      '<summary>运行日志</summary>' +
      '<div class="ds-dropdown-section-content">' +
        '<pre id="ds-debug-log-content" style="margin:0;padding:6px;font-family:monospace;font-size:10px;background:rgba(0,0,0,0.2);color:#9ca3af;border-radius:4px;white-space:pre-wrap;word-break:break-all;max-height:150px;overflow-y:auto;user-select:text;"></pre>' +
      '</div>' +
    '</details>' +
    '<div style="margin:8px 0;border-top:1px solid var(--SmartThemeBorderColor,#374151);"></div>' +
    '<button id="ds-btn-show-help" class="ds-btn ds-btn-sm ds-btn-normal" style="width:100%;display:flex;align-items:center;justify-content:center;gap:6px;">' +
      '<i class="fa-solid fa-circle-question"></i> 使用说明 &amp; 版本' +
    '</button>';

  // Content
  var content = doc.createElement('div');
  content.id = 'ds-content'; content.className = 'ds-content';
  content.innerHTML = PANEL_HTML;

  // Help Modal
  var helpModal = doc.createElement('div');
  helpModal.id = 'ds-help-modal'; helpModal.className = 'ds-help-modal';
  helpModal.innerHTML =
    '<div class="ds-help-modal-header">' +
      '<div class="ds-help-modal-title"><i class="fa-solid fa-circle-question"></i> 使用说明 &amp; 关于</div>' +
      '<div id="ds-help-modal-close" class="ds-close-btn">✕</div>' +
    '</div>' +
    '<div class="ds-help-modal-body">' +
      '<div class="ds-help-modal-version">版本：release1.62</div>' +
      '<div class="ds-help-block"><div class="ds-help-label-red">⚠️ 安全提示</div><div>在本插件中填入 API 密钥存在安全风险，建议使用权限受限的密钥。</div></div>' +
      '<div class="ds-help-block"><div class="ds-help-label-blue">ℹ️ 渠道说明</div><div class="ds-help-modal-list">' +
        '<div>1. 在"渠道管理"中配置各渠道的 API 密钥、余额和定价规则</div>' +
        '<div>2. 系统通过模型名关键字自动匹配渠道（如 deepseek-ai/ 匹配硅基流动）</div>' +
        '<div>3. 无定价规则的模型显示为"外部渠道"，费用记为0，不扣减余额</div>' +
        '<div>4. 统计页支持按模型过滤（含多模型时显示过滤器）</div>' +
      '</div></div>' +
      '<div class="ds-help-block"><div class="ds-help-label-purple">✨ 关于</div><div>本插件由 AI 编写、优化及修复，版本 release1.62</div></div>' +
    '</div>';

  panel.appendChild(header);
  panel.appendChild(settingsDropdown);
  panel.appendChild(content);
  panel.appendChild(helpModal);
  doc.body.appendChild(overlay);
  doc.body.appendChild(panel);

  setTimeout(function () { bindUIControls(doc); }, 100);
}

// ─── Bind UI Controls ─────────────────────────────────────────────────────────
function bindUIControls(doc) {
  function el(id) { return doc.getElementById(id); }

  // Save management
  var btnNewSave = el('ds-btn-new-save');
  if (btnNewSave) btnNewSave.onclick = function () { createNewSave(); refreshUI(); };

  var btnDeleteSave = el('ds-btn-delete-save');
  if (btnDeleteSave) btnDeleteSave.onclick = async function () {
    if (state.currentSave === '__all__') { alert('请先选择具体存档后再删除'); return; }
    if (confirm('确定删除当前存档？')) { await deleteSave(state.currentSave); refreshUI(); }
  };

  var btnDeleteAll = el('ds-btn-delete-all');
  if (btnDeleteAll) btnDeleteAll.onclick = async function () {
    if (confirm('确定清空全部存档？此操作不可恢复！')) {
      state.saves = {}; saveSaves(); createNewSave();
      await saveCurrentSaveKey(); refreshUI();
    }
  };

  var btnRefresh = el('ds-btn-refresh');
  if (btnRefresh) btnRefresh.onclick = function () { refreshUI(); };

  var btnClear = el('ds-btn-clear');
  if (btnClear) btnClear.onclick = function () {
    if (state.currentSave === '__all__') { alert('请先选择具体存档后再清空'); return; }
    var s = state.saves[state.currentSave]; if (!s) return;
    s.total_tokens = s.total_cost = s.input_tokens = s.output_tokens = 0;
    s.cache_hit_tokens = s.cache_miss_tokens = s.input_cost = s.output_cost = s.rounds = 0;
    s.history = []; saveSaves(); refreshUI();
  };

  // Balance layout toggle
  var btnBalLayout = el('ds-btn-balance-layout');
  if (btnBalLayout) btnBalLayout.onclick = function () {
    state.settings.balanceLayout = state.settings.balanceLayout === 'vertical' ? 'horizontal' : 'vertical';
    saveSettings(); refreshUI();
  };

  // Save selector
  var saveSelect = el('ds-save-select');
  if (saveSelect) {
    saveSelect.onchange = async function (e) {
      state.currentSave = e.target.value;
      if (state.currentSave !== '__all__') { state.lastRealSave = state.currentSave; await saveLastRealSaveKey(); }
      state.activeModelFilter = '__all__';
      state.activeChannelFilter = '__all__';
      await saveCurrentSaveKey(); refreshUI();
    };
  }

  // Debug mode
  var debugToggle = el('ds-debug-mode');
  var debugPanel  = el('ds-debug-panel');
  var debugStatus = el('ds-debug-status');
  if (debugToggle) {
    debugToggle.checked = state.settings.debug;
    if (debugPanel) debugPanel.style.display = state.settings.debug ? 'block' : 'none';
    if (debugStatus) debugStatus.textContent = state.settings.debug ? '调试模式已开启，下次对话将使用模拟参数' : '';
    debugToggle.onchange = function () {
      state.settings.debug = this.checked;
      if (debugPanel) debugPanel.style.display = this.checked ? 'block' : 'none';
      if (debugStatus) debugStatus.textContent = this.checked ? '调试模式已开启，下次对话将使用模拟参数' : '';
      saveSettings();
    };
  }
  ['hit','miss','output'].forEach(function (t) {
    var inp = el('ds-debug-' + t);
    if (inp) {
      inp.value = state.settings['debug' + t.charAt(0).toUpperCase() + t.slice(1)];
      inp.onchange = function () { state.settings['debug' + t.charAt(0).toUpperCase() + t.slice(1)] = parseInt(this.value, 10) || 0; saveSettings(); };
    }
  });
  var debugModelInp = el('ds-debug-model');
  if (debugModelInp) {
    debugModelInp.value = state.settings.debugModel;
    debugModelInp.onchange = function () { state.settings.debugModel = this.value.trim(); saveSettings(); };
  }

  // Header settings dropdown toggle
  var settingsBtn  = el('ds-header-settings-btn');
  var settingsDrop = el('ds-settings-dropdown');
  if (settingsBtn && settingsDrop) {
    settingsBtn.onclick = function (e) {
      e.stopPropagation();
      var isOpen = settingsDrop.style.display === 'block';
      settingsDrop.style.display = isOpen ? 'none' : 'block';
      if (!isOpen) {
        renderChannelManager(doc);
        var logEl = doc.getElementById('ds-debug-log-content');
        if (logEl) logEl.textContent = debugLogs.join('\n');
      }
    };
  }

  // Help modal
  var btnShowHelp = el('ds-btn-show-help');
  var helpModal   = el('ds-help-modal');
  if (btnShowHelp && helpModal) {
    btnShowHelp.onclick = function (e) {
      e.stopPropagation();
      if (settingsDrop) settingsDrop.style.display = 'none';
      helpModal.style.display = 'flex';
    };
  }
  var btnCloseHelp = el('ds-help-modal-close');
  if (btnCloseHelp && helpModal) {
    btnCloseHelp.onclick = function (e) { e.stopPropagation(); helpModal.style.display = 'none'; };
  }

  // Close dropdown on outside click
  if (_docClickListener) doc.removeEventListener('click', _docClickListener);
  _docClickListener = function (e) {
    var drop = el('ds-settings-dropdown');
    var btn  = el('ds-header-settings-btn');
    if (drop && btn && !drop.contains(e.target) && !btn.contains(e.target)) drop.style.display = 'none';
  };
  doc.addEventListener('click', _docClickListener);

  // Display mode radios
  var radios = doc.querySelectorAll('input[name="ds-display-mode"]');
  radios.forEach(function (radio) {
    if (radio.value === state.settings.displayMode) radio.checked = true;
    radio.onchange = async function () { state.settings.displayMode = this.value; await saveSettings(); applyDisplayMode(); };
  });

  // Panel diff/history delegation
  var panel = doc.getElementById('ds-panel');
  if (panel) {
    panel.addEventListener('click', function (e) {
      var beforeBtn = e.target.closest('.ds-diff-before-btn');
      var afterBtn  = e.target.closest('.ds-diff-after-btn');
      var fsBtn     = e.target.closest('#ds-btn-diff-fullscreen');
      var toggleBtn = e.target.closest('#ds-history-toggle');

      if (beforeBtn) {
        var ts = parseInt(beforeBtn.getAttribute('data-timestamp'), 10);
        selectedBeforeId = selectedBeforeId === ts ? null : ts;
        refreshUI();
      }
      if (afterBtn) {
        var ts2 = parseInt(afterBtn.getAttribute('data-timestamp'), 10);
        selectedAfterId = selectedAfterId === ts2 ? null : ts2;
        refreshUI();
      }
      if (fsBtn) {
        var dm = doc.getElementById('ds-module-diff');
        if (dm) {
          var isFS = dm.classList.toggle('ds-diff-fullscreen');
          fsBtn.innerHTML = isFS ? '<i class="fa-solid fa-compress"></i>' : '<i class="fa-solid fa-expand"></i>';
        }
      }
      if (toggleBtn) {
        var histEl = doc.getElementById('ds-history');
        if (histEl) {
          var expanded = histEl.getAttribute('data-expanded') === 'true';
          var next = !expanded;
          histEl.setAttribute('data-expanded', next ? 'true' : 'false');
          if (next) { histEl.classList.remove('ds-folded'); toggleBtn.textContent = '收起历史记录'; }
          else       { histEl.classList.add('ds-folded');    toggleBtn.textContent = '展开更多 (最多显示20条)...'; }
        }
      }
    });
  }

  applyDisplayMode();
  updateDynamicThemeColors();
  applyModuleOrder();
  applyModuleVisibility();
  applyStatsVisibility();
  renderModuleOrderSettings(doc);
  renderStatsCustomizerSettings(doc);

  refreshSaveSelect();
  refreshUI();
}

// ─── Channel Manager Rendering ────────────────────────────────────────────────
var _editingRule = null; // { channelId, ruleId } or null

function renderChannelManager(doc) {
  var container = doc.getElementById('ds-channel-manager');
  if (!container) return;

  var channels = getChannels();

  var html = '<div style="margin-bottom:8px;">' +
    '<button id="ds-cm-add-channel" class="ds-btn ds-btn-sm ds-btn-normal" style="width:100%;display:flex;align-items:center;justify-content:center;gap:4px;">' +
    '<i class="fa-solid fa-plus" style="font-size:10px;"></i> 新增渠道</button></div>';

  channels.forEach(function (ch) {
    html += renderChannelBlock(ch);
  });

  container.innerHTML = html;

  // Bind add-channel button
  var addChBtn = container.querySelector('#ds-cm-add-channel');
  if (addChBtn) addChBtn.onclick = function () { showAddChannelInlineForm(doc); };

  // Bind all channel controls
  bindChannelManagerControls(doc, container);
}

function renderChannelBlock(ch) {
  var color = escapeHTML(ch.color || '#6366f1');
  var chId  = escapeHTML(ch.id);

  var balText;
  if (ch.customBalance !== null && ch.customBalance !== '') {
    balText = '¥' + parseFloat(ch.customBalance).toFixed(2) + ' (自定义)';
  } else if (ch.balance && ch.balance.balance != null) {
    balText = '¥' + parseFloat(ch.balance.balance).toFixed(2) + ' ' + (ch.balance.currency || 'CNY');
  } else {
    balText = '未查询';
  }

  var canQuery = ch.balanceQueryType === 'deepseek' || ch.balanceQueryType === 'openai';

  var html = '<div class="ds-ch-block" data-chid="' + chId + '" style="border:1px solid var(--SmartThemeBorderColor,#374151);border-left:3px solid ' + color + ';border-radius:6px;margin-bottom:8px;overflow:hidden;">';

  // Channel header (click to collapse)
  html += '<div class="ds-ch-header" style="padding:6px 8px;display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.03);cursor:pointer;" data-chid="' + chId + '">';
  html += '<div style="display:flex;align-items:center;gap:6px;">';
  html += '<span style="width:8px;height:8px;border-radius:50%;background:' + color + ';display:inline-block;flex-shrink:0;"></span>';
  html += '<span style="font-size:12px;font-weight:600;color:var(--SmartThemeBodyColor)">' + escapeHTML(ch.name) + '</span>';
  if (ch.isDefault) html += '<span style="font-size:9px;padding:1px 4px;border-radius:3px;background:rgba(99,102,241,0.2);color:#818cf8;">系统默认</span>';
  html += '</div>';
  html += '<div style="display:flex;align-items:center;gap:6px;">';
  html += '<span style="font-size:10px;color:var(--SmartThemeEmColor)">' + escapeHTML(balText) + '</span>';
  html += '<i class="fa-solid fa-chevron-down ds-ch-chevron" style="font-size:9px;color:var(--SmartThemeEmColor);transition:none;" data-chid="' + chId + '"></i>';
  html += '</div></div>';

  // Channel body (collapsed by default)
  html += '<div class="ds-ch-body" data-chid="' + chId + '" style="display:none;padding:8px;">';

  // API key row
  html += '<div style="margin-bottom:6px;">';
  html += '<div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:3px;">API 密钥</div>';
  html += '<div style="display:flex;gap:4px;">';
  html += '<input type="password" class="ds-input ds-ch-apikey" data-chid="' + chId + '" value="' + escapeHTML(ch.apiKey || '') + '" placeholder="API 密钥（留空则无）" style="height:24px;padding:3px 6px;font-size:11px;flex:1;min-width:0;">';
  html += '<button class="ds-btn ds-btn-sm ds-btn-normal ds-ch-save-key" data-chid="' + chId + '" style="padding:2px 8px;font-size:11px;">保存</button>';
  if (canQuery) html += '<button class="ds-btn ds-btn-sm ds-btn-primary ds-ch-query-bal" data-chid="' + chId + '" style="padding:2px 6px;font-size:11px;">查询</button>';
  html += '</div></div>';

  // Balance query type
  html += '<div style="margin-bottom:6px;">';
  html += '<div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:3px;">余额查询方式</div>';
  html += '<select class="ds-input-compact ds-ch-qtype" data-chid="' + chId + '" style="height:22px;padding:2px 4px;font-size:11px;">';
  ['none:无','deepseek:DeepSeek 格式','openai:OpenAI 兼容 (需填 URL)'].forEach(function (opt) {
    var parts = opt.split(':'); var val = parts[0]; var lbl = parts[1];
    html += '<option value="' + val + '"' + (ch.balanceQueryType === val ? ' selected' : '') + '>' + lbl + '</option>';
  });
  html += '</select>';
  if (ch.balanceQueryType === 'openai') {
    html += '<input type="text" class="ds-input ds-ch-qurl" data-chid="' + chId + '" value="' + escapeHTML(ch.balanceQueryUrl || '') + '" placeholder="余额查询 URL" style="height:22px;padding:2px 6px;font-size:11px;width:100%;margin-top:3px;box-sizing:border-box;">';
  }
  html += '</div>';

  // Custom balance
  html += '<div style="margin-bottom:6px;">';
  html += '<div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:3px;">自定义余额</div>';
  html += '<div style="display:flex;gap:4px;">';
  html += '<input type="number" step="0.01" class="ds-input ds-ch-custom-bal" data-chid="' + chId + '" value="' + escapeHTML(ch.customBalance !== null ? ch.customBalance : '') + '" placeholder="留空使用 API 余额" style="height:24px;padding:3px 6px;font-size:11px;flex:1;min-width:0;">';
  html += '<button class="ds-btn ds-btn-sm ds-btn-success ds-ch-save-bal" data-chid="' + chId + '" style="padding:2px 6px;font-size:11px;">保存</button>';
  html += '<button class="ds-btn ds-btn-sm ds-btn-danger ds-ch-clear-bal" data-chid="' + chId + '" style="padding:2px 6px;font-size:11px;">清除</button>';
  html += '</div></div>';

  // Auto-balance toggle
  html += '<div style="margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;">';
  html += '<span style="font-size:11px;color:var(--SmartThemeEmColor)">自动校准余额</span>';
  html += '<label class="ds-switch" style="transform:scale(0.8);transform-origin:right center;"><input type="checkbox" class="ds-ch-auto-bal" data-chid="' + chId + '"' + (ch.autoBalance ? ' checked' : '') + '><span class="ds-switch-slider"></span></label>';
  html += '</div>';
  html += '<div class="ds-ch-auto-interval" data-chid="' + chId + '" style="margin-bottom:6px;display:' + (ch.autoBalance ? 'flex' : 'none') + ';align-items:center;gap:4px;">';
  html += '<span style="font-size:10px;color:var(--SmartThemeEmColor)">每</span>';
  html += '<input type="number" min="1" max="100" class="ds-input-compact ds-ch-interval" data-chid="' + chId + '" value="' + (ch.balanceInterval || 10) + '" style="width:40px;height:20px;padding:2px 4px;font-size:11px;text-align:center;">';
  html += '<span style="font-size:10px;color:var(--SmartThemeEmColor)">条自动查询</span></div>';

  // Peak pricing toggle (always show for all channels)
  var hasPeakRules = true;
  if (hasPeakRules) {
    html += '<div style="margin-bottom:6px;display:flex;align-items:center;justify-content:space-between;">';
    html += '<span style="font-size:11px;color:var(--SmartThemeEmColor)">新峰谷定价</span>';
    html += '<label class="ds-switch" style="transform:scale(0.8);transform-origin:right center;"><input type="checkbox" class="ds-ch-new-pricing" data-chid="' + chId + '"' + (ch.useNewPricing ? ' checked' : '') + '><span class="ds-switch-slider"></span></label>';
    html += '</div>';
    html += '<div class="ds-ch-pricing-date" data-chid="' + chId + '" style="margin-bottom:6px;display:' + (ch.useNewPricing ? 'flex' : 'none') + ';flex-direction:column;gap:4px;">';
    html += '<div style="display:flex;align-items:center;gap:4px;width:100%;">';
    html += '<span style="font-size:10px;color:var(--SmartThemeEmColor)">生效日</span>';
    html += '<input type="date" class="ds-input-compact ds-ch-pricing-date-inp" data-chid="' + chId + '" value="' + (ch.newPricingDate ? formatYMD(ch.newPricingDate) : '') + '" style="flex:1;height:20px;padding:2px 4px;font-size:10px;">';
    html += '<button class="ds-btn ds-btn-sm ds-btn-normal ds-ch-pricing-today" data-chid="' + chId + '" style="padding:1px 5px;font-size:10px;">今天</button>';
    html += '</div>';
    var peakStr = formatPeakHours(ch.peakHours);
    html += '<div style="display:flex;flex-direction:column;gap:2px;">';
    html += '<span style="font-size:9px;color:var(--SmartThemeEmColor)">高峰时间段 (北京时间)</span>';
    html += '<input type="text" class="ds-input-compact ds-ch-peak-hours-inp" data-chid="' + chId + '" value="' + escapeHTML(peakStr) + '" placeholder="例: 09:00-12:00, 14:00-18:00" style="height:20px;padding:2px 4px;font-size:10px;width:100%;box-sizing:border-box;">';
    html += '</div>';
    html += '</div>';
  }

  // Pricing rules
  html += '<div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:4px;margin-top:4px;">定价规则 <span style="color:var(--SmartThemeBodyColor);font-weight:600;">' + (ch.pricingRules || []).length + ' 条</span></div>';
  html += '<div class="ds-ch-rules-list" data-chid="' + chId + '">';
  (ch.pricingRules || []).forEach(function (rule) {
    html += renderRuleRow(ch.id, rule);
  });
  html += '</div>';
  html += '<button class="ds-btn ds-btn-sm ds-btn-normal ds-ch-add-rule" data-chid="' + chId + '" style="width:100%;margin-top:4px;display:flex;align-items:center;justify-content:center;gap:4px;padding:3px;font-size:11px;"><i class="fa-solid fa-plus" style="font-size:9px;"></i> 添加规则</button>';
  html += '<div class="ds-ch-rule-form" data-chid="' + chId + '" style="display:none;margin-top:6px;"></div>';

  // Channel rename + color
  html += '<div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--SmartThemeBorderColor,#374151);">';
  html += '<div style="display:flex;gap:4px;margin-bottom:4px;">';
  html += '<input type="text" class="ds-input ds-ch-rename" data-chid="' + chId + '" value="' + escapeHTML(ch.name) + '" placeholder="渠道名称" style="height:24px;padding:3px 6px;font-size:11px;flex:1;min-width:0;">';
  html += '<input type="color" class="ds-ch-color-pick" data-chid="' + chId + '" value="' + (ch.color || '#6366f1') + '" style="width:28px;height:24px;padding:1px;border:none;background:transparent;cursor:pointer;">';
  html += '<button class="ds-btn ds-btn-sm ds-btn-normal ds-ch-save-name" data-chid="' + chId + '" style="padding:2px 8px;font-size:11px;">保存</button>';
  html += '</div>';
  html += '<button class="ds-btn ds-btn-sm ds-btn-danger ds-ch-delete" data-chid="' + chId + '" style="width:100%;font-size:11px;">删除此渠道</button>';
  html += '</div>';

  html += '</div>'; // ds-ch-body
  html += '</div>'; // ds-ch-block
  return html;
}

function getRuleDisplayPrices(ch, rule) {
  var hasPeak = !!(rule.peak && rule.offpeak);
  var peak, offpeak;
  if (hasPeak) {
    peak = rule.peak;
    offpeak = rule.offpeak;
  } else {
    var m = (rule.pattern || '').toLowerCase();
    var isChatOrReasoner = m.indexOf('chat') !== -1 || m.indexOf('reasoner') !== -1;
    var multiplier = isChatOrReasoner ? 1 : 2;
    offpeak = { hit: rule.hit, miss: rule.miss, output: rule.output };
    peak = { hit: rule.hit * multiplier, miss: rule.miss * multiplier, output: rule.output * multiplier };
  }
  return { peak: peak, offpeak: offpeak };
}

function renderRuleRow(chId, rule) {
  var ruleId = escapeHTML(rule.id);
  var cid = escapeHTML(chId);
  var ch = getChannelById(chId);
  
  var pricesHtml = '';
  if (ch && ch.useNewPricing) {
    var dp = getRuleDisplayPrices(ch, rule);
    var isPeakNow = isPeakHour(Date.now(), ch);
    
    var offStr = '常规: h¥' + dp.offpeak.hit.toFixed(3).replace(/\.?0+$/, '') + 
                 ' m¥' + dp.offpeak.miss.toFixed(3).replace(/\.?0+$/, '') + 
                 ' o¥' + dp.offpeak.output.toFixed(3).replace(/\.?0+$/, '');
                 
    var peakStr = '高峰: h¥' + dp.peak.hit.toFixed(3).replace(/\.?0+$/, '') + 
                  ' m¥' + dp.peak.miss.toFixed(3).replace(/\.?0+$/, '') + 
                  ' o¥' + dp.peak.output.toFixed(3).replace(/\.?0+$/, '');
                  
    if (isPeakNow) {
      pricesHtml = '<span style="color:var(--SmartThemeEmColor);text-decoration:line-through;opacity:0.6;margin-right:6px;">' + escapeHTML(offStr) + '</span>' +
                   '<span style="color:#f97316;font-weight:600;">' + escapeHTML(peakStr) + ' ⚡ 高峰中</span>';
    } else {
      pricesHtml = '<span style="color:var(--SmartThemeQuoteColor);font-weight:600;">' + escapeHTML(offStr) + ' ✓ 活跃</span>' +
                   '<span style="color:var(--SmartThemeEmColor);opacity:0.6;margin-left:6px;">' + escapeHTML(peakStr) + '</span>';
    }
  } else {
    pricesHtml = 'h¥' + rule.hit + ' m¥' + rule.miss + ' o¥' + rule.output;
  }

  var html = '<div class="ds-rule-row" data-chid="' + cid + '" data-ruleid="' + ruleId + '" style="display:flex;align-items:center;gap:4px;padding:3px 0;font-size:11px;border-bottom:1px solid rgba(255,255,255,0.04);">';
  html += '<input type="checkbox" class="ds-rule-toggle" data-chid="' + cid + '" data-ruleid="' + ruleId + '"' + (rule.enabled ? ' checked' : '') + ' style="flex-shrink:0;">';
  html += '<div style="flex:1;min-width:0;">';
  html += '<div style="font-weight:500;color:var(--SmartThemeBodyColor);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + escapeHTML(rule.pattern) + '">' + escapeHTML(rule.label || rule.pattern) + '</div>';
  html += '<div style="font-size:9px;color:var(--SmartThemeEmColor);">' + pricesHtml + '</div>';
  html += '</div>';
  if (rule.isDefault) {
    html += '<span style="font-size:9px;padding:1px 3px;border-radius:2px;background:rgba(99,102,241,0.15);color:#818cf8;flex-shrink:0;">预置</span>';
  } else {
    html += '<button class="ds-btn ds-btn-sm ds-btn-normal ds-rule-edit" data-chid="' + cid + '" data-ruleid="' + ruleId + '" style="padding:1px 6px;font-size:10px;flex-shrink:0;">编辑</button>';
    html += '<button class="ds-btn ds-btn-sm ds-btn-danger ds-rule-delete" data-chid="' + cid + '" data-ruleid="' + ruleId + '" style="padding:1px 6px;font-size:10px;flex-shrink:0;">删除</button>';
  }
  html += '</div>';
  return html;
}

function renderRuleForm(chId, existingRule) {
  var r = existingRule || { pattern: '', label: '', hit: 0, miss: 0, output: 0 };
  var hasPeak = !!(r.peak && r.offpeak);
  var peakHit = hasPeak ? r.peak.hit : r.hit;
  var peakMiss = hasPeak ? r.peak.miss : r.miss;
  var peakOutput = hasPeak ? r.peak.output : r.output;
  var offHit = hasPeak ? r.offpeak.hit : r.hit;
  var offMiss = hasPeak ? r.offpeak.miss : r.miss;
  var offOutput = hasPeak ? r.offpeak.output : r.output;

  var html = '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--SmartThemeBorderColor,#374151);border-radius:6px;padding:8px;">';
  html += '<div style="font-size:10px;font-weight:600;color:var(--SmartThemeBodyColor);margin-bottom:6px;">' + (existingRule ? '编辑规则' : '添加规则') + '</div>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px;">';
  html += '<div><div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px;">匹配关键字 <span style="color:#f87171">*</span></div>' +
          '<input type="text" id="ds-rf-pattern" class="ds-input-compact" value="' + escapeHTML(r.pattern) + '" placeholder="如: gpt-4o" style="height:22px;padding:2px 4px;font-size:11px;width:100%;box-sizing:border-box;"></div>';
  html += '<div><div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px;">显示名称 (可选)</div>' +
          '<input type="text" id="ds-rf-label" class="ds-input-compact" value="' + escapeHTML(r.label || '') + '" placeholder="如: GPT-4o" style="height:22px;padding:2px 4px;font-size:11px;width:100%;box-sizing:border-box;"></div>';
  html += '</div>';

  html += '<div style="margin-bottom:6px;display:flex;align-items:center;gap:4px;">' +
          '<input type="checkbox" id="ds-rf-has-peak" ' + (hasPeak ? 'checked' : '') + ' style="margin:0;cursor:pointer;">' +
          '<label for="ds-rf-has-peak" style="font-size:10px;color:var(--SmartThemeBodyColor);cursor:pointer;user-select:none;">自定义峰谷定价</label>' +
          '</div>';

  html += '<div id="ds-rf-standard-pricing-group" style="display:' + (hasPeak ? 'none' : 'grid') + ';grid-template-columns:1fr 1fr 1fr;gap:4px;margin-bottom:6px;">';
  html += '<div><div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px;">命中价格</div>' +
          '<input type="number" step="any" id="ds-rf-hit" class="ds-input-compact" value="' + r.hit + '" style="height:22px;padding:2px 4px;font-size:11px;width:100%;box-sizing:border-box;"></div>';
  html += '<div><div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px;">未命中价格</div>' +
          '<input type="number" step="any" id="ds-rf-miss" class="ds-input-compact" value="' + r.miss + '" style="height:22px;padding:2px 4px;font-size:11px;width:100%;box-sizing:border-box;"></div>';
  html += '<div><div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px;">输出价格</div>' +
          '<input type="number" step="any" id="ds-rf-output" class="ds-input-compact" value="' + r.output + '" style="height:22px;padding:2px 4px;font-size:11px;width:100%;box-sizing:border-box;"></div>';
  html += '</div>';

  html += '<div id="ds-rf-peak-pricing-group" style="display:' + (hasPeak ? 'block' : 'none') + ';margin-bottom:6px;">';
  html += '<div style="font-size:9px;font-weight:600;color:var(--SmartThemeQuoteColor);margin-bottom:2px;">低谷/常规时段价格 (CNY/1M)</div>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-bottom:4px;">';
  html += '<div><div style="font-size:8px;color:var(--SmartThemeEmColor);margin-bottom:1px;">命中</div>' +
          '<input type="number" step="any" id="ds-rf-off-hit" class="ds-input-compact" value="' + offHit + '" style="height:20px;padding:1px 3px;font-size:10px;width:100%;box-sizing:border-box;"></div>';
  html += '<div><div style="font-size:8px;color:var(--SmartThemeEmColor);margin-bottom:1px;">未命中</div>' +
          '<input type="number" step="any" id="ds-rf-off-miss" class="ds-input-compact" value="' + offMiss + '" style="height:20px;padding:1px 3px;font-size:10px;width:100%;box-sizing:border-box;"></div>';
  html += '<div><div style="font-size:8px;color:var(--SmartThemeEmColor);margin-bottom:1px;">输出</div>' +
          '<input type="number" step="any" id="ds-rf-off-output" class="ds-input-compact" value="' + offOutput + '" style="height:20px;padding:1px 3px;font-size:10px;width:100%;box-sizing:border-box;"></div>';
  html += '</div>';
  html += '<div style="font-size:9px;font-weight:600;color:#f97316;margin-bottom:2px;">高峰时段价格 (CNY/1M)</div>';
  html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-bottom:4px;">';
  html += '<div><div style="font-size:8px;color:var(--SmartThemeEmColor);margin-bottom:1px;">命中</div>' +
          '<input type="number" step="any" id="ds-rf-peak-hit" class="ds-input-compact" value="' + peakHit + '" style="height:20px;padding:1px 3px;font-size:10px;width:100%;box-sizing:border-box;"></div>';
  html += '<div><div style="font-size:8px;color:var(--SmartThemeEmColor);margin-bottom:1px;">未命中</div>' +
          '<input type="number" step="any" id="ds-rf-peak-miss" class="ds-input-compact" value="' + peakMiss + '" style="height:20px;padding:1px 3px;font-size:10px;width:100%;box-sizing:border-box;"></div>';
  html += '<div><div style="font-size:8px;color:var(--SmartThemeEmColor);margin-bottom:1px;">输出</div>' +
          '<input type="number" step="any" id="ds-rf-peak-output" class="ds-input-compact" value="' + peakOutput + '" style="height:20px;padding:1px 3px;font-size:10px;width:100%;box-sizing:border-box;"></div>';
  html += '</div>';
  html += '</div>';

  html += '<div id="ds-rf-error" style="font-size:10px;color:#f87171;min-height:14px;margin-bottom:4px;"></div>';
  html += '<div style="display:flex;gap:4px;">';
  html += '<button id="ds-rf-save" class="ds-btn ds-btn-sm ds-btn-primary" style="flex:1;font-size:11px;">保存</button>';
  html += '<button id="ds-rf-cancel" class="ds-btn ds-btn-sm ds-btn-normal" style="flex:1;font-size:11px;">取消</button>';
  html += '</div></div>';
  return html;
}

function showAddChannelInlineForm(doc) {
  var container = doc.getElementById('ds-channel-manager');
  if (!container) return;

  // Check if form already exists
  var existing = container.querySelector('#ds-add-ch-form');
  if (existing) { existing.remove(); return; }

  var channels = getChannels();
  var copyOptionsHtml = '<option value="">-- 不复制定价规则 --</option>';
  channels.forEach(function (ch) {
    copyOptionsHtml += '<option value="' + ch.id + '">' + escapeHTML(ch.name) + '</option>';
  });

  var rulesHtml = DS_DEFAULT_RULES.map(function (r) {
    return '<label style="display:flex;align-items:center;gap:6px;font-size:10px;color:var(--SmartThemeBodyColor);cursor:pointer;margin-bottom:2px;">' +
      '<input type="checkbox" class="ds-nch-def-rule" value="' + r.id + '" checked style="margin:0;">' +
      '<span>' + escapeHTML(r.label) + '</span>' +
      '</label>';
  }).join('');

  var form = doc.createElement('div');
  form.id = 'ds-add-ch-form';
  form.style.cssText = 'background:rgba(255,255,255,0.03);border:1px solid var(--SmartThemeBorderColor,#374151);border-radius:6px;padding:8px;margin-bottom:8px;';
  form.innerHTML =
    '<div style="font-size:10px;font-weight:600;color:var(--SmartThemeBodyColor);margin-bottom:6px;">新增渠道</div>' +
    '<div style="margin-bottom:4px;"><div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px;">渠道名称 <span style="color:#f87171">*</span></div>' +
    '<input type="text" id="ds-nch-name" class="ds-input" placeholder="如: 硅基流动" style="height:24px;padding:3px 6px;font-size:11px;width:100%;box-sizing:border-box;"></div>' +
    '<div style="margin-bottom:6px;"><div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px;">标识颜色</div>' +
    '<input type="color" id="ds-nch-color" value="#10b981" style="width:28px;height:24px;padding:1px;border:none;background:transparent;cursor:pointer;"></div>' +
    '<div style="margin-bottom:6px;"><div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px;">余额查询方式</div>' +
    '<select id="ds-nch-qtype" class="ds-input-compact" style="height:22px;padding:2px 4px;font-size:11px;width:100%;box-sizing:border-box;">' +
    '<option value="none">无</option><option value="deepseek">DeepSeek 格式</option><option value="openai">OpenAI 兼容</option>' +
    '</select></div>' +
    
    '<div style="margin-bottom:6px;">' +
    '<div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px;">从已有渠道复制定价规则</div>' +
    '<select id="ds-nch-copy-src" class="ds-input-compact" style="height:22px;padding:2px 4px;font-size:11px;width:100%;box-sizing:border-box;">' +
    copyOptionsHtml +
    '</select></div>' +

    '<div id="ds-nch-preset-rules-group" style="margin-bottom:8px;">' +
    '<div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:3px;">或导入预置定价规则</div>' +
    '<div style="background:rgba(255,255,255,0.02);border:1px solid var(--SmartThemeBorderColor,#374151);border-radius:4px;padding:6px;display:flex;flex-direction:column;gap:4px;">' +
    rulesHtml +
    '</div>' +
    '</div>' +

    '<div id="ds-nch-error" style="font-size:10px;color:#f87171;min-height:14px;margin-bottom:4px;"></div>' +
    '<div style="display:flex;gap:4px;">' +
    '<button id="ds-nch-create" class="ds-btn ds-btn-sm ds-btn-primary" style="flex:1;font-size:11px;">创建</button>' +
    '<button id="ds-nch-cancel" class="ds-btn ds-btn-sm ds-btn-normal" style="flex:1;font-size:11px;">取消</button>' +
    '</div>';

  var addBtn = container.querySelector('#ds-cm-add-channel');
  if (addBtn) container.insertBefore(form, addBtn.nextSibling);
  else container.insertBefore(form, container.firstChild);

  var copySrcSelect = form.querySelector('#ds-nch-copy-src');
  var presetGroup   = form.querySelector('#ds-nch-preset-rules-group');
  if (copySrcSelect && presetGroup) {
    copySrcSelect.onchange = function () {
      presetGroup.style.display = this.value ? 'none' : 'block';
    };
  }

  var createBtn = form.querySelector('#ds-nch-create');
  var cancelBtn = form.querySelector('#ds-nch-cancel');
  var errEl     = form.querySelector('#ds-nch-error');

  if (cancelBtn) cancelBtn.onclick = function () { form.remove(); };
  if (createBtn) createBtn.onclick = function () {
    var name   = (form.querySelector('#ds-nch-name').value || '').trim();
    var color2 = form.querySelector('#ds-nch-color').value || '#10b981';
    var qtype  = form.querySelector('#ds-nch-qtype').value;
    if (!name) { if (errEl) errEl.textContent = '请填写渠道名称'; return; }

    var copySrcId = copySrcSelect ? copySrcSelect.value : '';
    var newRules = [];

    if (copySrcId) {
      var srcCh = getChannelById(copySrcId);
      if (srcCh && Array.isArray(srcCh.pricingRules)) {
        srcCh.pricingRules.forEach(function (r) {
          newRules.push({
            id: makeNewRuleId(),
            pattern: r.pattern,
            label: r.label,
            hit: r.hit,
            miss: r.miss,
            output: r.output,
            isDefault: r.isDefault,
            enabled: r.enabled,
            offpeak: r.offpeak ? Object.assign({}, r.offpeak) : undefined,
            peak: r.peak ? Object.assign({}, r.peak) : undefined,
          });
        });
      }
    } else {
      var chosenRuleIds = Array.from(form.querySelectorAll('.ds-nch-def-rule:checked')).map(function (el) { return el.value; });
      DS_DEFAULT_RULES.forEach(function (r) {
        if (chosenRuleIds.indexOf(r.id) !== -1) {
          newRules.push({
            id: makeNewRuleId(),
            pattern: r.pattern,
            label: r.label,
            hit: r.hit,
            miss: r.miss,
            output: r.output,
            isDefault: true,
            enabled: true,
            offpeak: Object.assign({}, r.offpeak),
            peak: Object.assign({}, r.peak),
          });
        }
      });
    }

    var newCh = {
      id: makeNewChannelId(), name: name, color: color2, isDefault: false,
      apiKey: '', balanceQueryType: qtype, balanceQueryUrl: '',
      balance: null, customBalance: null,
      autoBalance: false, balanceInterval: 10, messageCount: 0,
      useNewPricing: false, newPricingDate: new Date('2026-07-15T00:00:00+08:00').getTime(),
      peakHours: [
        { start: '09:00', end: '12:00' },
        { start: '14:00', end: '18:00' }
      ],
      pricingRules: newRules,
    };
    state.settings.channels.push(newCh);
    saveSettings();
    form.remove();
    renderChannelManager(doc);
  };
}

function bindChannelManagerControls(doc, container) {
  // Channel header toggle (collapse/expand)
  container.querySelectorAll('.ds-ch-header').forEach(function (header) {
    header.onclick = function () {
      var chId = header.getAttribute('data-chid');
      var body = container.querySelector('.ds-ch-body[data-chid="' + chId + '"]');
      var chev = container.querySelector('.ds-ch-chevron[data-chid="' + chId + '"]');
      if (!body) return;
      var isOpen = body.style.display !== 'none';
      body.style.display = isOpen ? 'none' : 'block';
      if (chev) chev.style.transform = isOpen ? '' : 'rotate(180deg)';
    };
  });

  // Save API key
  container.querySelectorAll('.ds-ch-save-key').forEach(function (btn) {
    btn.onclick = async function () {
      var chId = btn.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (!ch) return;
      var inp = container.querySelector('.ds-ch-apikey[data-chid="' + chId + '"]');
      ch.apiKey = encryptKey((inp ? inp.value.trim() : ''));
      // Store decrypted for runtime use
      ch.apiKey = inp ? inp.value.trim() : '';
      await saveSettings();
      btn.textContent = '✓'; setTimeout(function () { btn.textContent = '保存'; }, 1000);
    };
  });

  // Query balance
  container.querySelectorAll('.ds-ch-query-bal').forEach(function (btn) {
    btn.onclick = function () {
      var chId = btn.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (ch) fetchChannelBalance(ch, false);
    };
  });

  // Balance query type change
  container.querySelectorAll('.ds-ch-qtype').forEach(function (sel) {
    sel.onchange = async function () {
      var chId = sel.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (!ch) return;
      ch.balanceQueryType = sel.value;
      await saveSettings();
      renderChannelManager(doc);
    };
  });

  // Query URL
  container.querySelectorAll('.ds-ch-qurl').forEach(function (inp) {
    inp.onchange = async function () {
      var chId = inp.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (ch) { ch.balanceQueryUrl = inp.value.trim(); await saveSettings(); }
    };
  });

  // Custom balance save/clear
  container.querySelectorAll('.ds-ch-save-bal').forEach(function (btn) {
    btn.onclick = async function () {
      var chId = btn.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (!ch) return;
      var inp = container.querySelector('.ds-ch-custom-bal[data-chid="' + chId + '"]');
      var val = inp ? inp.value.trim() : '';
      if (!val || isNaN(parseFloat(val))) return;
      ch.customBalance = val;
      await saveSettings(); refreshUI();
    };
  });
  container.querySelectorAll('.ds-ch-clear-bal').forEach(function (btn) {
    btn.onclick = async function () {
      var chId = btn.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (!ch) return;
      ch.customBalance = null;
      var inp = container.querySelector('.ds-ch-custom-bal[data-chid="' + chId + '"]');
      if (inp) inp.value = '';
      await saveSettings(); refreshUI();
    };
  });

  // Auto-balance toggle
  container.querySelectorAll('.ds-ch-auto-bal').forEach(function (chk) {
    chk.onchange = async function () {
      var chId = chk.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (!ch) return;
      ch.autoBalance = chk.checked;
      var intervalDiv = container.querySelector('.ds-ch-auto-interval[data-chid="' + chId + '"]');
      if (intervalDiv) intervalDiv.style.display = chk.checked ? 'flex' : 'none';
      await saveSettings();
    };
  });
  container.querySelectorAll('.ds-ch-interval').forEach(function (inp) {
    inp.onchange = async function () {
      var chId = inp.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (ch) { ch.balanceInterval = parseInt(inp.value, 10) || 10; await saveSettings(); }
    };
  });

  // Peak pricing toggle
  container.querySelectorAll('.ds-ch-new-pricing').forEach(function (chk) {
    chk.onchange = async function () {
      var chId = chk.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (!ch) return;
      ch.useNewPricing = chk.checked;
      await saveSettings();
      renderChannelManager(doc);
      
      var body = container.querySelector('.ds-ch-body[data-chid="' + chId + '"]');
      var chev = container.querySelector('.ds-ch-chevron[data-chid="' + chId + '"]');
      if (body) body.style.display = 'block';
      if (chev) chev.style.transform = 'rotate(180deg)';
    };
  });
  container.querySelectorAll('.ds-ch-pricing-date-inp').forEach(function (inp) {
    inp.onchange = async function () {
      var chId = inp.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (ch && inp.value) { ch.newPricingDate = new Date(inp.value + 'T00:00:00+08:00').getTime(); await saveSettings(); }
    };
  });
  container.querySelectorAll('.ds-ch-pricing-today').forEach(function (btn) {
    btn.onclick = async function () {
      var chId = btn.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (!ch) return;
      var today = formatYMD(Date.now());
      var inp = container.querySelector('.ds-ch-pricing-date-inp[data-chid="' + chId + '"]');
      if (inp) inp.value = today;
      ch.newPricingDate = new Date(today + 'T00:00:00+08:00').getTime();
      await saveSettings();
    };
  });
  container.querySelectorAll('.ds-ch-peak-hours-inp').forEach(function (inp) {
    inp.onchange = async function () {
      var chId = inp.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (!ch) return;
      var val = inp.value.trim();
      var parsed = parsePeakHours(val);
      if (parsed.length > 0) {
        ch.peakHours = parsed;
        await saveSettings();
      } else {
        inp.value = formatPeakHours(ch.peakHours);
      }
    };
  });

  // Rule toggle
  container.querySelectorAll('.ds-rule-toggle').forEach(function (chk) {
    chk.onchange = async function () {
      var chId = chk.getAttribute('data-chid');
      var ruleId = chk.getAttribute('data-ruleid');
      var ch = getChannelById(chId);
      if (!ch) return;
      var rule = (ch.pricingRules || []).find(function (r) { return r.id === ruleId; });
      if (rule) { rule.enabled = chk.checked; await saveSettings(); }
    };
  });

  // Rule edit
  container.querySelectorAll('.ds-rule-edit').forEach(function (btn) {
    btn.onclick = function () {
      var chId   = btn.getAttribute('data-chid');
      var ruleId = btn.getAttribute('data-ruleid');
      var ch     = getChannelById(chId);
      if (!ch) return;
      var rule = (ch.pricingRules || []).find(function (r) { return r.id === ruleId; });
      if (!rule) return;
      var formContainer = container.querySelector('.ds-ch-rule-form[data-chid="' + chId + '"]');
      if (!formContainer) return;
      formContainer.style.display = 'block';
      formContainer.innerHTML = renderRuleForm(chId, rule);
      bindRuleForm(doc, formContainer, chId, rule);
    };
  });

  // Rule delete
  container.querySelectorAll('.ds-rule-delete').forEach(function (btn) {
    btn.onclick = async function () {
      var chId   = btn.getAttribute('data-chid');
      var ruleId = btn.getAttribute('data-ruleid');
      if (!confirm('确定删除此定价规则？')) return;
      var ch = getChannelById(chId);
      if (!ch) return;
      ch.pricingRules = (ch.pricingRules || []).filter(function (r) { return r.id !== ruleId; });
      await saveSettings();
      renderChannelManager(doc);
    };
  });

  // Add rule
  container.querySelectorAll('.ds-ch-add-rule').forEach(function (btn) {
    btn.onclick = function () {
      var chId = btn.getAttribute('data-chid');
      var formContainer = container.querySelector('.ds-ch-rule-form[data-chid="' + chId + '"]');
      if (!formContainer) return;
      if (formContainer.style.display !== 'none') { formContainer.style.display = 'none'; formContainer.innerHTML = ''; return; }
      formContainer.style.display = 'block';
      formContainer.innerHTML = renderRuleForm(chId, null);
      bindRuleForm(doc, formContainer, chId, null);
    };
  });

  // Rename + color
  container.querySelectorAll('.ds-ch-save-name').forEach(function (btn) {
    btn.onclick = async function () {
      var chId = btn.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (!ch) return;
      var nameInp  = container.querySelector('.ds-ch-rename[data-chid="' + chId + '"]');
      var colorInp = container.querySelector('.ds-ch-color-pick[data-chid="' + chId + '"]');
      if (nameInp && nameInp.value.trim()) ch.name = nameInp.value.trim();
      if (colorInp) ch.color = colorInp.value;
      await saveSettings();
      renderChannelManager(doc);
      refreshUI();
    };
  });

  // Delete channel
  container.querySelectorAll('.ds-ch-delete').forEach(function (btn) {
    btn.onclick = async function () {
      var chId = btn.getAttribute('data-chid');
      if (!confirm('确定删除此渠道？其定价规则将被清除。')) return;
      if (chId === 'ch_ds_official') {
        state.settings.isDsOfficialDeleted = true;
      }
      state.settings.channels = getChannels().filter(function (ch) { return ch.id !== chId; });
      await saveSettings();
      renderChannelManager(doc);
      refreshUI();
    };
  });
}

function bindRuleForm(doc, formContainer, chId, existingRule) {
  var saveBtn   = formContainer.querySelector('#ds-rf-save');
  var cancelBtn = formContainer.querySelector('#ds-rf-cancel');
  var errEl     = formContainer.querySelector('#ds-rf-error');
  var hasPeakChk = formContainer.querySelector('#ds-rf-has-peak');
  var stdGroup  = formContainer.querySelector('#ds-rf-standard-pricing-group');
  var peakGroup = formContainer.querySelector('#ds-rf-peak-pricing-group');

  if (hasPeakChk && stdGroup && peakGroup) {
    hasPeakChk.onchange = function () {
      stdGroup.style.display = this.checked ? 'none' : 'grid';
      peakGroup.style.display = this.checked ? 'block' : 'none';
    };
  }

  if (cancelBtn) cancelBtn.onclick = function () { formContainer.style.display = 'none'; formContainer.innerHTML = ''; };

  if (saveBtn) saveBtn.onclick = async function () {
    var pattern = (formContainer.querySelector('#ds-rf-pattern').value || '').trim();
    var label   = (formContainer.querySelector('#ds-rf-label').value || '').trim();
    if (!pattern) { if (errEl) errEl.textContent = '请填写匹配关键字'; return; }

    var hit, miss, output, peakObj = null, offpeakObj = null;
    var ch = getChannelById(chId);
    if (!ch) return;

    var usePeakInputs = hasPeakChk && hasPeakChk.checked;
    if (usePeakInputs) {
      var ph = parseFloat(formContainer.querySelector('#ds-rf-peak-hit').value) || 0;
      var pm = parseFloat(formContainer.querySelector('#ds-rf-peak-miss').value) || 0;
      var po = parseFloat(formContainer.querySelector('#ds-rf-peak-output').value) || 0;
      var oh = parseFloat(formContainer.querySelector('#ds-rf-off-hit').value) || 0;
      var om = parseFloat(formContainer.querySelector('#ds-rf-off-miss').value) || 0;
      var oo = parseFloat(formContainer.querySelector('#ds-rf-off-output').value) || 0;
      
      hit = oh; miss = om; output = oo;
      peakObj = { hit: ph, miss: pm, output: po };
      offpeakObj = { hit: oh, miss: om, output: oo };
    } else {
      hit = parseFloat(formContainer.querySelector('#ds-rf-hit').value) || 0;
      miss = parseFloat(formContainer.querySelector('#ds-rf-miss').value) || 0;
      output = parseFloat(formContainer.querySelector('#ds-rf-output').value) || 0;
    }

    if (existingRule) {
      // Edit existing
      var rule = (ch.pricingRules || []).find(function (r) { return r.id === existingRule.id; });
      if (rule) {
        rule.pattern = pattern;
        rule.label = label;
        rule.hit = hit;
        rule.miss = miss;
        rule.output = output;
        if (usePeakInputs) {
          rule.peak = peakObj;
          rule.offpeak = offpeakObj;
        } else {
          delete rule.peak;
          delete rule.offpeak;
        }
      }
    } else {
      // Add new
      if (!Array.isArray(ch.pricingRules)) ch.pricingRules = [];
      var newRule = {
        id: makeNewRuleId(),
        pattern: pattern,
        label: label,
        hit: hit,
        miss: miss,
        output: output,
        isDefault: false,
        enabled: true
      };
      if (usePeakInputs) {
        newRule.peak = peakObj;
        newRule.offpeak = offpeakObj;
      }
      ch.pricingRules.push(newRule);
    }

    await saveSettings();
    formContainer.style.display = 'none'; formContainer.innerHTML = '';
    renderChannelManager(doc);
  };
}

// ─── Save Selector ────────────────────────────────────────────────────────────
function refreshSaveSelect() {
  var doc    = (window.parent || window).document;
  var select = doc.getElementById('ds-save-select');
  if (!select) return;
  var keys = Object.keys(state.saves);
  var newHash = state.currentSave + '|' + keys.map(function (k) { return k + ':' + (state.saves[k].rounds || 0); }).join(',');
  if (newHash === _saveSelectHash) return;
  _saveSelectHash = newHash;
  var html = '<option value="__all__"' + (state.currentSave === '__all__' ? ' selected' : '') + '>全部存档 (合并统计)</option>';
  keys.sort(function (a, b) { return (state.saves[b].startTime || 0) - (state.saves[a].startTime || 0); })
      .forEach(function (k) {
        var s = state.saves[k];
        html += '<option value="' + k + '"' + (k === state.currentSave ? ' selected' : '') + '>' + s.name + ' (' + (s.rounds || 0) + '轮)</option>';
      });
  select.innerHTML = html;
}

// ─── Panel Toggle ─────────────────────────────────────────────────────────────
var _ds_last_toggle = 0;
function togglePanel() {
  if (!isInitDone) return;
  if (Date.now() - initTimestamp < 500) return;
  if (Date.now() - _ds_last_toggle < 300) return;
  _ds_last_toggle = Date.now();
  var p  = window.parent || window;
  var ov = p.document.getElementById('ds-overlay');
  var pn = p.document.getElementById('ds-panel');
  if (!ov || !pn) { createUI(); return; }
  if (state.panelOpen) {
    ov.style.display = 'none'; pn.classList.remove('ds-open'); state.panelOpen = false;
  } else {
    syncViewportHeight(); updateDynamicThemeColors();
    ov.style.display = 'block'; pn.classList.add('ds-open'); state.panelOpen = true;
    refreshUI();
  }
}

// ─── UI Refresh ───────────────────────────────────────────────────────────────
function refreshUI() {
  if (_refreshPending) return;
  _refreshPending = true;
  (window.parent || window).requestAnimationFrame(function () {
    _refreshPending = false;
    _doRefreshUI();
  });
}

// ─── Model filter: get filtered data ─────────────────────────────────────────
function getFilteredDisplayData(s) {
  if (!s) return s;
  var modelFilter = state.activeModelFilter || '__all__';
  var channelFilter = state.activeChannelFilter || '__all__';
  if (modelFilter === '__all__' && channelFilter === '__all__') return s;

  var history = (s.history || []).filter(function (h) {
    var matchModel = modelFilter === '__all__' || h.model === modelFilter;
    var matchChannel = channelFilter === '__all__' || h.channelId === channelFilter;
    return matchModel && matchChannel;
  });

  var fd = {
    rounds: history.length,
    total_tokens: 0, total_cost: 0, input_tokens: 0, output_tokens: 0,
    cache_hit_tokens: 0, cache_miss_tokens: 0, input_cost: 0, output_cost: 0,
    history: history, startTime: s.startTime,
  };
  history.forEach(function (item) {
    fd.total_tokens      += item.total_tokens      || 0;
    fd.total_cost        += item.cost              || 0;
    fd.input_tokens      += item.prompt_tokens     || 0;
    fd.output_tokens     += item.completion_tokens || 0;
    fd.cache_hit_tokens  += item.cache_hit_tokens  || 0;
    fd.cache_miss_tokens += item.cache_miss_tokens || 0;
    fd.input_cost        += item.input_cost        || 0;
    fd.output_cost       += item.output_cost       || 0;
  });
  return fd;
}

// ─── Savings computation (from history items) ─────────────────────────────────
function computeSavingsFromHistory(history) {
  var total = 0;
  (history || []).forEach(function (item) {
    if (!item.cache_hit_tokens || item.cache_hit_tokens <= 0) return;
    if (item.pricingType === 'unknown') return;
    // We stored hitPrice and missPrice at record time
    var hitP  = item.hitPrice  || 0;
    var missP = item.missPrice || 0;
    if (missP > hitP) {
      total += (item.cache_hit_tokens / 1e6) * (missP - hitP);
    }
  });
  return total;
}

// ─── Model Filter Render ──────────────────────────────────────────────────────
function renderModelFilter(doc, s) {
  var container = doc.getElementById('ds-model-filter');
  if (!container) return;

  if (!s || !s.history || s.history.length === 0) { container.innerHTML = ''; return; }

  // Collect unique models
  var models = [], seen = {};
  s.history.forEach(function (item) {
    if (item.model && !seen[item.model]) { seen[item.model] = true; models.push(item.model); }
  });

  if (models.length < 2) { container.innerHTML = ''; return; }

  var active = state.activeModelFilter || '__all__';
  var html = '<div style="display:flex;flex-wrap:wrap;gap:3px;">';
  html += '<button class="ds-btn ds-btn-sm ds-model-filter-btn ' + (active === '__all__' ? 'ds-btn-primary' : 'ds-btn-normal') + '" data-model="__all__" style="padding:1px 6px;font-size:10px;">全部</button>';
  models.forEach(function (m) {
    var shortName = m.length > 22 ? m.slice(0, 20) + '…' : m;
    html += '<button class="ds-btn ds-btn-sm ds-model-filter-btn ' + (active === m ? 'ds-btn-primary' : 'ds-btn-normal') + '" data-model="' + escapeHTML(m) + '" title="' + escapeHTML(m) + '" style="padding:1px 6px;font-size:10px;">' + escapeHTML(shortName) + '</button>';
  });
  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll('.ds-model-filter-btn').forEach(function (btn) {
    btn.onclick = function () { state.activeModelFilter = btn.getAttribute('data-model'); refreshUI(); };
  });
}

function renderChannelFilter(doc, s) {
  var container = doc.getElementById('ds-channel-filter');
  if (!container) return;

  if (!s || !s.history || s.history.length === 0) { container.innerHTML = ''; return; }

  // Collect unique channels
  var channelIds = [], seen = {};
  s.history.forEach(function (item) {
    if (item.channelId && !seen[item.channelId]) {
      seen[item.channelId] = true;
      channelIds.push({ id: item.channelId, name: item.channelName || '未知渠道' });
    }
  });

  if (channelIds.length < 2) { container.innerHTML = ''; return; }

  var active = state.activeChannelFilter || '__all__';
  var html = '<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:4px;">';
  html += '<button class="ds-btn ds-btn-sm ds-channel-filter-btn ' + (active === '__all__' ? 'ds-btn-primary' : 'ds-btn-normal') + '" data-chid="__all__" style="padding:1px 6px;font-size:10px;">全部渠道</button>';
  channelIds.forEach(function (ch) {
    var shortName = ch.name.length > 22 ? ch.name.slice(0, 20) + '…' : ch.name;
    html += '<button class="ds-btn ds-btn-sm ds-channel-filter-btn ' + (active === ch.id ? 'ds-btn-primary' : 'ds-btn-normal') + '" data-chid="' + escapeHTML(ch.id) + '" title="' + escapeHTML(ch.name) + '" style="padding:1px 6px;font-size:10px;">' + escapeHTML(shortName) + '</button>';
  });
  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll('.ds-channel-filter-btn').forEach(function (btn) {
    btn.onclick = function () { state.activeChannelFilter = btn.getAttribute('data-chid'); refreshUI(); };
  });
}

// ─── Balance Module Render ────────────────────────────────────────────────────
function renderBalanceModule(doc, displaySave) {
  var container = doc.getElementById('ds-balance-cards');
  if (!container) return;

  var channels = getChannels();
  if (channels.length === 0) { container.innerHTML = '<div class="ds-wait-text">暂无渠道配置</div>'; return; }

  var layout = state.settings.balanceLayout || 'vertical';
  var layoutIcon = doc.getElementById('ds-btn-balance-layout');
  if (layoutIcon) {
    layoutIcon.title = layout === 'vertical' ? '切换为横排' : '切换为竖排';
    layoutIcon.innerHTML = layout === 'vertical'
      ? '<i class="fa-solid fa-table-columns" style="font-size:11px;"></i>'
      : '<i class="fa-solid fa-table-cells-large" style="font-size:11px;"></i>';
  }

  var html = '';
  if (layout === 'horizontal') {
    html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:6px;">';
  } else {
    html = '<div style="display:flex;flex-direction:column;gap:6px;">';
  }

  channels.forEach(function (ch) {
    var bal;
    var balText, balSource;

    if (ch.customBalance !== null && ch.customBalance !== '') {
      bal = parseFloat(ch.customBalance);
      balText = '¥' + bal.toFixed(2) + ' CNY';
      balSource = '自定义余额';
    } else if (ch.balance && ch.balance.balance != null) {
      bal = parseFloat(ch.balance.balance);
      balText = '¥' + bal.toFixed(2) + ' ' + (ch.balance.currency || 'CNY');
      balSource = ch.balance.timestamp ? new Date(ch.balance.timestamp).toLocaleTimeString('zh-CN') : '账户可用';
    } else {
      bal = null;
      balText = '¥0.00 CNY';
      balSource = '未查询';
    }

    // Remaining rounds: use history items for this channel
    var remText = '';
    if (bal !== null && bal > 0 && displaySave) {
      var chHistory = (displaySave.history || []).filter(function (h) { return h.channelId === ch.id; });
      var rem = calculateRemainingRoundsForChannel(chHistory, bal);
      if (rem !== null) remText = '预计还可进行 ' + rem + ' 轮';
    }

    var color = ch.color || '#6366f1';
    var canQuery = (ch.balanceQueryType === 'deepseek' || ch.balanceQueryType === 'openai') && ch.apiKey;

    html += '<div style="border-left:3px solid ' + escapeHTML(color) + ';padding:7px 10px;background:rgba(255,255,255,0.03);border-radius:0 6px 6px 0;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">';
    html += '<span style="font-size:10px;font-weight:600;color:' + escapeHTML(color) + '">' + escapeHTML(ch.name) + '</span>';
    if (canQuery) {
      html += '<button class="ds-btn ds-btn-sm ds-btn-primary ds-query-ch-btn" data-chid="' + escapeHTML(ch.id) + '" style="padding:1px 6px;font-size:9px;">查询</button>';
    }
    html += '</div>';
    html += '<div style="font-size:16px;font-weight:700;color:var(--SmartThemeBodyColor);">' + escapeHTML(balText) + '</div>';
    if (balSource) html += '<div style="font-size:9px;color:var(--SmartThemeEmColor);margin-top:1px;">' + escapeHTML(balSource) + '</div>';
    if (remText)   html += '<div style="font-size:10px;color:var(--SmartThemeEmColor);margin-top:2px;">' + escapeHTML(remText) + '</div>';
    html += '</div>';
  });

  html += '</div>';
  container.innerHTML = html;

  container.querySelectorAll('.ds-query-ch-btn').forEach(function (btn) {
    btn.onclick = function () {
      var chId = btn.getAttribute('data-chid');
      var ch = getChannelById(chId);
      if (ch) fetchChannelBalance(ch, false);
    };
  });
}

// ─── Main Refresh ─────────────────────────────────────────────────────────────
function _doRefreshUI() {
  var doc = (window.parent || window).document;
  function el(id) { return doc.getElementById(id); }

  refreshSaveSelect();

  var rawSave = getSelectedSaveForDisplay();
  if (!rawSave) return;

  // Render model filter based on raw (unfiltered) save
  renderModelFilter(doc, rawSave);
  renderChannelFilter(doc, rawSave);

  // Get filtered data for stat display
  var s = getFilteredDisplayData(rawSave);
  if (!s) return;

  // Balance module
  renderBalanceModule(doc, rawSave);

  // Header timing
  if (el('ds-save-time')) {
    el('ds-save-time').textContent = state.currentSave === '__all__' ? '' : '开始于 ' + formatStartTime(s.startTime);
  }

  // Stats
  if (el('ds-total-tokens')) el('ds-total-tokens').textContent = formatTokens(s.total_tokens || 0);
  if (el('ds-total-cost'))   el('ds-total-cost').textContent   = '¥' + (s.total_cost || 0).toFixed(4);
  if (el('ds-rounds'))       el('ds-rounds').textContent       = '基于 ' + (s.rounds || 0) + ' 轮';

  // Weighted hit rate
  var tp = 0, th = 0;
  (s.history || []).forEach(function (item) { tp += item.prompt_tokens || 0; th += item.cache_hit_tokens || 0; });
  if (el('ds-weighted-rate')) el('ds-weighted-rate').textContent = (tp > 0 ? (th / tp * 100) : 0).toFixed(1) + '%';

  // Per-round averages
  if ((s.rounds || 0) > 0) {
    if (el('ds-avg-tokens')) el('ds-avg-tokens').textContent = formatTokens((s.total_tokens || 0) / s.rounds);
    if (el('ds-avg-cost'))   el('ds-avg-cost').textContent   = '¥' + ((s.total_cost || 0) / s.rounds).toFixed(4);
  } else {
    if (el('ds-avg-tokens')) el('ds-avg-tokens').textContent = '0';
    if (el('ds-avg-cost'))   el('ds-avg-cost').textContent   = '¥0.0000';
  }

  // Savings (computed from per-item prices)
  var sv = computeSavingsFromHistory(s.history);
  if (el('ds-savings'))        el('ds-savings').textContent        = '¥' + sv.toFixed(4);
  if (el('ds-savings-tokens')) el('ds-savings-tokens').textContent = formatTokens(s.cache_hit_tokens || 0);

  // Input/output cost
  if (el('ds-input-cost'))    el('ds-input-cost').textContent    = '¥' + (s.input_cost    || 0).toFixed(4);
  if (el('ds-input-tokens'))  el('ds-input-tokens').textContent  = formatTokens(s.input_tokens || 0);
  if (el('ds-output-cost'))   el('ds-output-cost').textContent   = '¥' + (s.output_cost   || 0).toFixed(4);
  if (el('ds-output-tokens')) el('ds-output-tokens').textContent = formatTokens(s.output_tokens || 0);

  // Extended stats cards
  var roundsCount   = s.rounds || 0;
  var totalTokens   = s.total_tokens || 0;
  var hitTokens     = s.cache_hit_tokens || 0;
  var missTokens    = s.cache_miss_tokens || 0;
  var inputTokens   = s.input_tokens || 0;
  var outputTokens  = s.output_tokens || 0;
  var avgTotalTokens  = roundsCount > 0 ? Math.round(totalTokens / roundsCount) : 0;
  var avgInputTokens  = roundsCount > 0 ? Math.round(inputTokens / roundsCount) : 0;
  var avgOutputTokens = roundsCount > 0 ? Math.round(outputTokens / roundsCount) : 0;
  var hitRatePct  = inputTokens > 0 ? (hitTokens  / inputTokens * 100).toFixed(1) : '0.0';
  var missRatePct = inputTokens > 0 ? (missTokens / inputTokens * 100).toFixed(1) : '0.0';

  var maxCost = 0, maxCostModel = '暂无数据', minCost = 999999, minCostModel = '暂无数据';
  var maxTurnTok = 0, maxTTIn = 0, maxTTOut = 0, minTurnTok = 999999, minTTIn = 0, minTTOut = 0;
  if (s.history && s.history.length > 0) {
    s.history.forEach(function (item) {
      var c = item.cost || 0;
      if (c > maxCost)  { maxCost = c; maxCostModel = item.model || '未知模型'; }
      if (c < minCost)  { minCost = c; minCostModel = item.model || '未知模型'; }
      var t = item.total_tokens || 0;
      if (t > maxTurnTok) { maxTurnTok = t; maxTTIn = item.prompt_tokens || 0; maxTTOut = item.completion_tokens || 0; }
      if (t < minTurnTok) { minTurnTok = t; minTTIn = item.prompt_tokens || 0; minTTOut = item.completion_tokens || 0; }
    });
  }
  if (minCost === 999999) minCost = 0;
  if (minTurnTok === 999999) minTurnTok = 0;

  if (el('ds-stat-total-tokens'))     el('ds-stat-total-tokens').textContent     = formatTokens(totalTokens);
  if (el('ds-stat-total-tokens-sub')) el('ds-stat-total-tokens-sub').textContent = '单轮平均 ' + formatTokens(avgTotalTokens);
  if (el('ds-stat-hit-tokens'))       el('ds-stat-hit-tokens').textContent       = formatTokens(hitTokens);
  if (el('ds-stat-hit-tokens-sub'))   el('ds-stat-hit-tokens-sub').textContent   = '占输入 ' + hitRatePct + '%';
  if (el('ds-stat-miss-tokens'))      el('ds-stat-miss-tokens').textContent      = formatTokens(missTokens);
  if (el('ds-stat-miss-tokens-sub'))  el('ds-stat-miss-tokens-sub').textContent  = '占输入 ' + missRatePct + '%';
  if (el('ds-stat-rounds-count'))     el('ds-stat-rounds-count').textContent     = roundsCount;
  if (el('ds-stat-rounds-count-sub')) el('ds-stat-rounds-count-sub').textContent = '轮对话';
  if (el('ds-stat-max-turn-cost'))    el('ds-stat-max-turn-cost').textContent    = '¥' + maxCost.toFixed(4);
  if (el('ds-stat-max-turn-cost-sub'))el('ds-stat-max-turn-cost-sub').textContent= maxCostModel;
  if (el('ds-stat-avg-turn-tokens'))  el('ds-stat-avg-turn-tokens').textContent  = formatTokens(avgTotalTokens);
  if (el('ds-stat-avg-turn-tokens-sub'))el('ds-stat-avg-turn-tokens-sub').textContent = '输 ' + formatTokens(avgInputTokens) + ' · 出 ' + formatTokens(avgOutputTokens);

  // Latest hit rate
  var lhrVal = '-', lhrSub = '暂无数据';
  if (s.history && s.history.length > 0) {
    var lr = s.history[0];
    lhrVal = lr.prompt_tokens > 0 ? (lr.cache_hit_tokens / lr.prompt_tokens * 100).toFixed(1) + '%' : '0.0%';
    lhrSub = lr.model || '未知模型';
  }
  if (el('ds-stat-latest-hit-rate'))     el('ds-stat-latest-hit-rate').textContent     = lhrVal;
  if (el('ds-stat-latest-hit-rate-sub')) el('ds-stat-latest-hit-rate-sub').textContent = lhrSub;

  // Hit/miss ratio bar
  var totalInput = hitTokens + missTokens;
  var hitPct  = totalInput > 0 ? (hitTokens / totalInput * 100) : 0;
  var missPct = totalInput > 0 ? (missTokens / totalInput * 100) : 0;
  if (el('ds-stat-hit-miss-ratio'))     el('ds-stat-hit-miss-ratio').textContent     = formatTokens(hitTokens) + ' / ' + formatTokens(missTokens);
  if (el('ds-stat-hit-miss-ratio-sub')) el('ds-stat-hit-miss-ratio-sub').textContent = '输出 ' + formatTokens(outputTokens);
  var hitBarEl = el('ds-hit-miss-bar-hit'), missBarEl = el('ds-hit-miss-bar-miss');
  var hitLblEl = el('ds-hit-miss-lbl-hit'), missLblEl = el('ds-hit-miss-lbl-miss');
  if (hitBarEl)  hitBarEl.style.width  = hitPct.toFixed(1) + '%';
  if (missBarEl) missBarEl.style.width = (totalInput > 0 ? (100 - hitPct) : 0).toFixed(1) + '%';
  if (hitLblEl)  hitLblEl.textContent  = '命中: ' + hitPct.toFixed(1) + '%';
  if (missLblEl) missLblEl.textContent = '未命中: ' + missPct.toFixed(1) + '%';

  // Avg input/output tokens
  var avgHit  = roundsCount > 0 ? Math.round(hitTokens  / roundsCount) : 0;
  var avgMiss = roundsCount > 0 ? Math.round(missTokens / roundsCount) : 0;
  if (el('ds-stat-avg-input-tokens'))     el('ds-stat-avg-input-tokens').textContent     = formatTokens(avgInputTokens);
  if (el('ds-stat-avg-input-tokens-sub')) el('ds-stat-avg-input-tokens-sub').textContent = '命中 ' + formatTokens(avgHit) + ' · 未命中 ' + formatTokens(avgMiss);
  var avgOutPct = avgTotalTokens > 0 ? (avgOutputTokens / avgTotalTokens * 100).toFixed(1) : '0.0';
  if (el('ds-stat-avg-output-tokens'))     el('ds-stat-avg-output-tokens').textContent     = formatTokens(avgOutputTokens);
  if (el('ds-stat-avg-output-tokens-sub')) el('ds-stat-avg-output-tokens-sub').textContent = '占总数 ' + avgOutPct + '%';

  // Savings rate
  var totalPotentialCost = (s.total_cost || 0) + sv;
  var savingsRateVal = totalPotentialCost > 0 ? (sv / totalPotentialCost * 100).toFixed(1) + '%' : '0.0%';
  if (el('ds-stat-savings-rate'))     el('ds-stat-savings-rate').textContent     = savingsRateVal;
  if (el('ds-stat-savings-rate-sub')) el('ds-stat-savings-rate-sub').textContent = '节省 ¥' + sv.toFixed(4);

  // Min turn cost
  if (el('ds-stat-min-turn-cost'))     el('ds-stat-min-turn-cost').textContent     = '¥' + minCost.toFixed(4);
  if (el('ds-stat-min-turn-cost-sub')) el('ds-stat-min-turn-cost-sub').textContent = minCostModel;

  // Max/min turn tokens
  if (el('ds-stat-max-turn-tokens'))     el('ds-stat-max-turn-tokens').textContent     = formatTokens(maxTurnTok);
  if (el('ds-stat-max-turn-tokens-sub')) el('ds-stat-max-turn-tokens-sub').textContent = '输 ' + formatTokens(maxTTIn) + ' · 出 ' + formatTokens(maxTTOut);
  if (el('ds-stat-min-turn-tokens'))     el('ds-stat-min-turn-tokens').textContent     = formatTokens(minTurnTok);
  if (el('ds-stat-min-turn-tokens-sub')) el('ds-stat-min-turn-tokens-sub').textContent = '输 ' + formatTokens(minTTIn) + ' · 出 ' + formatTokens(minTTOut);

  // ── Latest entry ────────────────────────────────────────────────────────────
  var latestEl = el('ds-latest');
  if (s.history && s.history.length > 0 && latestEl) {
    var u  = s.history[0];
    var hr = u.prompt_tokens > 0 ? (u.cache_hit_tokens / u.prompt_tokens * 100).toFixed(1) : '0.0';
    latestEl.innerHTML = buildEntryHTML(u, hr);
  } else if (latestEl) {
    latestEl.innerHTML = '<div class="ds-wait-text">等待第一次对话...</div>';
  }

  // ── History list ────────────────────────────────────────────────────────────
  var histEl = el('ds-history');
  if (s.history && s.history.length > 1 && histEl) {
    var isExpanded = histEl.getAttribute('data-expanded') === 'true';
    histEl.setAttribute('data-expanded', isExpanded ? 'true' : 'false');
    if (isExpanded) histEl.classList.remove('ds-folded'); else histEl.classList.add('ds-folded');

    var itemsHTML = s.history.slice(1, 21).map(function (item, idx) {
      var t  = new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      var hr = item.prompt_tokens > 0 ? (item.cache_hit_tokens / item.prompt_tokens * 100) : 0;
      var extraClass = idx >= 3 ? ' ds-history-collapsed' : '';
      return buildHistoryEntryHTML(item, idx, s.history.length, t, hr, extraClass);
    }).join('');

    if (s.history.length > 4) {
      var toggleText = isExpanded ? '收起历史记录' : '展开更多 (最多显示20条)...';
      itemsHTML += '<div id="ds-history-toggle" style="text-align:center;padding:8px;cursor:pointer;color:var(--SmartThemeUnderlineColor,#818cf8);font-size:12px;font-weight:500;text-decoration:underline;">' + toggleText + '</div>';
    }
    histEl.innerHTML = itemsHTML;
  } else if (histEl) {
    histEl.innerHTML = '<div class="ds-wait-text">暂无历史记录</div>';
  }

  // ── Diff ────────────────────────────────────────────────────────────────────
  var diffEl = el('ds-diff');
  if (diffEl) {
    if (!selectedBeforeId || !selectedAfterId) {
      diffEl.innerHTML = '<div class="ds-wait-text">请在下方历史记录中选择"旧请求"和"新请求"进行对比</div>';
    } else {
      var beforeRecord = null, afterRecord = null;
      if (s.history) {
        s.history.forEach(function (item) {
          if (item.timestamp === selectedBeforeId) beforeRecord = item;
          if (item.timestamp === selectedAfterId)  afterRecord  = item;
        });
      }
      if (!beforeRecord || !afterRecord) {
        diffEl.innerHTML = '<div class="ds-wait-text">所选记录的快照已过期或不存在</div>';
      } else {
        var diffResult = comparePromptRecords(beforeRecord, afterRecord, 600);
        var html = '<div class="ds-diff-summary ds-diff-kind-' + diffResult.kind + '" style="margin-bottom:12px;"><strong>对比结论: </strong>' + escapeHTML(diffResult.summary) + '</div>';
        if (diffResult.context) {
          var ctx = diffResult.context;
          var fdt = function (prefix, changed, suffix, hmp, hms, isDel) {
            var t2 = '';
            if (hmp) t2 += '<span class="ds-diff-context-dim">…</span>';
            t2 += '<span class="ds-diff-context-normal">' + escapeHTML(prefix) + '</span>';
            t2 += '<mark class="' + (isDel ? 'ds-diff-del' : 'ds-diff-ins') + '">' + (changed ? escapeHTML(changed) : '∅') + '</mark>';
            t2 += '<span class="ds-diff-context-normal">' + escapeHTML(suffix) + '</span>';
            if (hms) t2 += '<span class="ds-diff-context-dim">…</span>';
            return t2;
          };
          html += '<div class="ds-diff-grid">';
          html += '<div class="ds-diff-side"><div class="ds-diff-side-title">旧请求 · ' + beforeRecord.prompt_tokens + ' tokens (' + diffResult.beforeLength + ' 字)</div>' +
                  '<pre class="ds-diff-pre">' + fdt(ctx.prefix, ctx.beforeChanged, ctx.suffix, ctx.hasMorePrefix, ctx.hasMoreSuffix, true) + '</pre></div>';
          html += '<div class="ds-diff-side"><div class="ds-diff-side-title">新请求 · ' + afterRecord.prompt_tokens + ' tokens (' + diffResult.afterLength + ' 字)</div>' +
                  '<pre class="ds-diff-pre">' + fdt(ctx.prefix, ctx.afterChanged, ctx.suffix, ctx.hasMorePrefix, ctx.hasMoreSuffix, false) + '</pre></div>';
          html += '</div>';
        } else {
          html += '<div class="ds-wait-text">没有发现有效消息内容的差异。</div>';
        }
        diffEl.innerHTML = html;
      }
    }
  }
}

// ─── HTML Builders ────────────────────────────────────────────────────────────
function getPricingBadge(u) {
  var type = u.pricingType;
  if (type === 'peak') {
    return '<span style="font-size:9px;padding:1px 5px;border-radius:3px;color:var(--SmartThemeQuoteColor);border:1px solid var(--SmartThemeQuoteColor);font-weight:600;margin-left:4px;">高峰</span>';
  }
  if (type === 'offpeak') {
    return '<span style="font-size:9px;padding:1px 5px;border-radius:3px;color:var(--SmartThemeQuoteColor);border:1px solid var(--SmartThemeQuoteColor);font-weight:600;margin-left:4px;">平时</span>';
  }
  if (type === 'unknown') {
    return '<span style="font-size:9px;padding:1px 5px;border-radius:3px;color:#f97316;border:1px solid #f97316;font-weight:600;margin-left:4px;">外部渠道</span>';
  }
  return '';
}

function getChannelBadge(u) {
  if (!u.channelName || u.pricingType === 'unknown') return '';
  var ch = getChannelById(u.channelId);
  var color = ch ? escapeHTML(ch.color || '#6366f1') : '#6366f1';
  return '<span style="font-size:9px;padding:1px 5px;border-radius:3px;border:1px solid ' + color + ';color:' + color + ';font-weight:500;margin-left:4px;">' + escapeHTML(u.channelName) + '</span>';
}

function _buildEntryBodyHTML(u, hitRate, diffBtns) {
  var isUnknown = u.pricingType === 'unknown';
  var costText  = isUnknown ? '<span style="color:#f97316;font-size:11px;">¥-- (无定价)</span>' : '<span style="font-size:13px;color:var(--SmartThemeBodyColor);font-weight:600;">¥' + (u.cost ? u.cost.toFixed(4) : '0.0000') + '</span>';
  var hasSnapshot = u.messages && u.messages.length > 0;
  return '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
      '<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">' +
        diffBtns.title +
        '<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:var(--SmartThemeBorderColor);color:var(--SmartThemeBodyColor);font-weight:500">' + escapeHTML(u.model) + '</span>' +
        getPricingBadge(u) +
        getChannelBadge(u) +
      '</div>' +
      costText +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      buildTokenCell('tokens', 'var(--SmartThemeEmColor)',          '16px', u.total_tokens)      +
      buildTokenCell('输入',   'var(--SmartThemeUnderlineColor)',   '13px', u.prompt_tokens)     +
      buildTokenCell('输出',   'var(--SmartThemeQuoteColor)',       '13px', u.completion_tokens) +
    '</div>' +
    buildHitBar(hitRate) +
    '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<span style="font-size:10px;color:var(--SmartThemeQuoteColor);font-weight:500">' + parseFloat(hitRate).toFixed(1) + '% 命中</span>' +
      (isUnknown
        ? '<span style="font-size:10px;color:#f97316;">外部渠道 · 不计费用</span>'
        : '<span style="font-size:10px;color:var(--SmartThemeEmColor)">¥' + (u.input_cost ? u.input_cost.toFixed(4) : '0.0000') + ' 输入 · ¥' + (u.output_cost ? u.output_cost.toFixed(4) : '0.0000') + ' 输出</span>') +
    '</div>' +
    (hasSnapshot ?
      '<div style="display:flex;gap:6px;margin-top:8px;justify-content:flex-end;">' +
        '<button class="ds-diff-btn ds-diff-before-btn' + (u.timestamp === selectedBeforeId ? ' active' : '') + '" data-timestamp="' + u.timestamp + '">旧</button>' +
        '<button class="ds-diff-btn ds-diff-after-btn'  + (u.timestamp === selectedAfterId  ? ' active' : '') + '" data-timestamp="' + u.timestamp + '">新</button>' +
      '</div>' : '');
}

function buildEntryHTML(u, hitRate) {
  var time = new Date(u.timestamp).toLocaleTimeString('zh-CN');
  return '<div style="padding:12px;font-family:system-ui,-apple-system,sans-serif">' +
    _buildEntryBodyHTML(u, hitRate, { title: '<span style="font-size:11px;color:var(--SmartThemeEmColor);font-weight:500">' + time + '</span>' }) +
  '</div>';
}

function buildHistoryEntryHTML(item, idx, totalLen, timeStr, hitRate, extraClass) {
  var roundNum = totalLen - 1 - idx;
  return '<div class="ds-card' + (extraClass || '') + '" style="padding:12px;margin-bottom:8px;font-family:system-ui,-apple-system,sans-serif">' +
    _buildEntryBodyHTML(item, hitRate, { title: '<span style="font-size:11px;color:var(--SmartThemeEmColor);font-weight:500">#' + roundNum + ' · ' + timeStr + '</span>' }) +
  '</div>';
}

function buildTokenCell(label, color, fontSize, value) {
  return '<div style="text-align:center">' +
    '<div style="font-size:10px;color:' + color + ';margin-bottom:2px">' + label + '</div>' +
    '<div style="font-size:' + fontSize + ';font-weight:700;color:' + color + '">' + String(value || 0) + '</div>' +
  '</div>';
}

function buildHitBar(pct) {
  var width = Math.min(100, Math.max(0, parseFloat(pct) || 0));
  return '<div style="background:rgba(0,0,0,0.15);border-radius:4px;height:4px;overflow:hidden;margin-bottom:4px">' +
    '<div style="background:linear-gradient(90deg,var(--SmartThemeQuoteColor),var(--SmartThemeUnderlineColor));width:' + width + '%;height:100%;border-radius:4px;transition:width 0.3s"></div>' +
  '</div>';
}

// ─── Extension Entry-Point ────────────────────────────────────────────────────
export async function init() {
  logDebug('SillyTavern DeepSeek Extension 初始化中...');
  await migrateLocalStorageToIndexedDB();
  await loadSavedData();
  initDefaultChannels();
  await loadCurrentSave();
  await handleChatChanged();

  setupEvents();
  createUI();
  patchFetch();
  state.panelOpen = false;
  initTimestamp   = Date.now();
  isInitDone      = true;
  syncViewportHeight();

  // Register in SillyTavern Extensions menu
  try {
    var wp   = window.parent || window;
    var wdoc = wp.document;
    var menu = wdoc.getElementById('extensionsMenu');
    if (menu && !wdoc.getElementById('ds_wand_container')) {
      var container2 = wdoc.createElement('div');
      container2.id = 'ds_wand_container'; container2.className = 'extension_container';
      container2.innerHTML = '<div id="ds_wand_entry" class="list-group-item flex-container flexGap5"><div class="fa-solid fa-wallet extensionsMenuExtensionButton"></div>钱包</div>';
      menu.appendChild(container2);
      var wandBtn = wdoc.getElementById('ds_wand_entry');
      if (wandBtn) wandBtn.addEventListener('click', togglePanel);
    }
  } catch (e) {}

  applyDisplayMode();
  initWalletButtonObserver();
  setTimeout(ensureWalletButton, 1000);

  // Viewport sync
  try {
    var p2 = window.parent || window;
    if (p2.visualViewport) {
      p2.visualViewport.addEventListener('resize', syncViewportHeight, { passive: true });
      p2.visualViewport.addEventListener('scroll', syncViewportHeight, { passive: true });
    }
    p2.addEventListener('resize', syncViewportHeight, { passive: true });
  } catch (e) {}

  // Responsive layout guard
  try {
    var pw = window.parent || window;
    var vw = (pw.innerWidth || 768) > 760 ? 'desktop' : 'mobile';
    pw.addEventListener('resize', function () {
      var nv = (pw.innerWidth || 768) > 760 ? 'desktop' : 'mobile';
      if (vw !== nv) {
        vw = nv;
        var pn = pw.document.getElementById('ds-panel');
        if (pn && pn.classList.contains('ds-open')) {
          pn.classList.add('ds-no-animation');
          setTimeout(function () { pn.classList.remove('ds-no-animation'); }, 30);
        }
      }
    }, { passive: true });
  } catch (e) {}
}

// ─── Public API ───────────────────────────────────────────────────────────────
window.DeepSeekStats = {
  state:        state,
  togglePanel:  togglePanel,
  refreshUI:    refreshUI,
  getChannels:  getChannels,
};
