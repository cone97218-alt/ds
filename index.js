import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';

// ─── Pricing table (CNY per 1M tokens) ────────────────────────────────────────
var PRICING = {
  'deepseek-v4-flash':  { hit: 0.02,  miss: 1,    output: 2    },
  'deepseek-v4-pro':    { hit: 0.025, miss: 3,     output: 6    },
  'deepseek-chat':      { hit: 1.0,   miss: 2.0,   output: 8.0  },
  'deepseek-reasoner':  { hit: 2.0,   miss: 4.0,   output: 16.0 },
};

// Default settings — used as fallback when merging persisted settings
var DEFAULT_SETTINGS = {
  autoBalance: false,
  balanceInterval: 10,
  debug: false,
  debugHit: 10000,
  debugMiss: 5000,
  debugOutput: 2000,
  debugModel: 'deepseek-v4-flash',
  displayMode: 'wand-modal', // 'wand-modal', 'wand-fullscreen', 'qr-bar', 'qr-top', 'qr-bottom', 'qr-left', or 'qr-right'
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
  }
};

var state = {
  currentSave: null,
  saves: {},
  lastUsage: null,
  panelOpen: false,
  apiKey: '',
  balance: null,
  customBalance: null,
  // Settings are spread from DEFAULT_SETTINGS so new keys are never missing
  settings: Object.assign({}, DEFAULT_SETTINGS),
  messageCount: 0,
};

var isInitDone   = false;
var initTimestamp = 0;
var selectedBeforeId = null;
var selectedAfterId = null;
var lastProcessedSignature = '';
var lastProcessedTime = 0;

// ─── Storage keys ──────────────────────────────────────────────────────────────
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
  <select id="ds-save-select" class="ds-select" style="height:36px; padding:6px 10px; box-sizing:border-box;">
    <option value="">加载中...</option>
  </select>
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
        <button id="ds-btn-query-balance" class="ds-btn ds-btn-sm ds-btn-primary">查询</button>
      </div>
    </div>
    <div id="ds-balance-box" class="ds-balance-box">
      <div id="ds-balance" class="ds-balance-val">¥0.00 CNY</div>
      <div id="ds-balance-remaining" class="ds-balance-remaining ds-margin-t-4"></div>
      <div id="ds-balance-status"    class="ds-balance-status ds-margin-t-4"></div>
    </div>
  </div>

  <!-- 统计概览模块 -->
  <div id="ds-module-stats" class="ds-margin-b-16">
    <div class="ds-flex-between ds-margin-b-12">
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
            <div id="ds-hit-miss-bar-hit" style="background:var(--SmartThemeQuoteColor); width:0%; height:100%; transition:width 0.3s;"></div>
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
      <div class="ds-wait-text">请在下方历史记录中选择“旧请求”和“新请求”进行对比</div>
    </div>
  </div>

</div>
`;

// ─── Persistence helpers ───────────────────────────────────────────────────────
// Bug fix #9: The original script called getAllVariables()/replaceVariables() which are
// SillyTavern globals not guaranteed in extension scope.  Fall back to localStorage only;
// the retry wrappers are kept for API compatibility but now only touch localStorage.

function saveToLS(key, value) {
  try {
    localStorage.setItem('ds_ext_' + key, value);
  } catch (e) {
    console.warn('[DS] localStorage write failed:', e);
  }
}

function loadFromLS(key) {
  try {
    return localStorage.getItem('ds_ext_' + key);
  } catch (e) {
    return null;
  }
}

// Attempt SillyTavern variable API first, fall back to localStorage
function saveData(key, value) {
  try {
    if (typeof getAllVariables === 'function' && typeof replaceVariables === 'function') {
      var v = getAllVariables();
      v[key] = value;
      replaceVariables(v);
    }
  } catch (e) { /* not available in this context */ }
  saveToLS(key, value);
}

function loadData(key) {
  try {
    if (typeof getAllVariables === 'function') {
      var v = getAllVariables();
      if (v && v[key] != null) return v[key];
    }
  } catch (e) { /* not available */ }
  return loadFromLS(key);
}

// ─── Viewport helper ───────────────────────────────────────────────────────────
function syncViewportHeight() {
  try {
    var p = window.parent || window;
    var h = (p.visualViewport && p.visualViewport.height) || p.innerHeight || 640;
    p.document.documentElement.style.setProperty('--ds-vvh', Math.max(320, Math.round(h)) + 'px');
  } catch (e) {}
}

// ─── Module ordering helper ───────────────────────────────────────────────────
function applyModuleOrder() {
  try {
    var doc = getDoc();
    var container = doc.getElementById('ds-modules-container');
    if (!container) return;
    var order = state.settings.moduleOrder || ['balance', 'stats', 'latest', 'history', 'diff'];
    order.forEach(function (key) {
      var el = doc.getElementById('ds-module-' + key);
      if (el) {
        container.appendChild(el);
      }
    });
  } catch (e) {
    console.warn('[DS] applyModuleOrder error:', e);
  }
}

function applyModuleVisibility() {
  try {
    var doc = getDoc();
    var validModules = ['balance', 'stats', 'latest', 'history', 'diff'];
    var visibility = state.settings.moduleVisibility || {};
    validModules.forEach(function (key) {
      var el = doc.getElementById('ds-module-' + key);
      if (el) {
        var isVisible = visibility[key] !== false;
        el.style.setProperty('display', isVisible ? '' : 'none', isVisible ? '' : 'important');
      }
    });
  } catch (e) {
    console.warn('[DS] applyModuleVisibility error:', e);
  }
}

function applyStatsVisibility() {
  try {
    var doc = getDoc();
    var visibility = state.settings.statsVisibility || {};
    var keys = [
      'total-cost', 'hit-rate', 'avg-cost', 'savings', 'input-cost', 'output-cost',
      'total-tokens', 'hit-tokens', 'miss-tokens', 'rounds-count', 'max-turn-cost', 'avg-turn-tokens',
      'latest-hit-rate', 'hit-miss-ratio', 'avg-input-tokens', 'avg-output-tokens', 'savings-rate',
      'min-turn-cost', 'max-turn-tokens', 'min-turn-tokens'
    ];
    keys.forEach(function (k) {
      var el = doc.getElementById('ds-stat-card-' + k);
      if (el) {
        var isVisible = visibility[k] !== false;
        el.style.setProperty('display', isVisible ? '' : 'none', isVisible ? '' : 'important');
      }
    });
  } catch (e) {
    console.warn('[DS] applyStatsVisibility error:', e);
  }
}

function renderStatsCustomizerSettings(doc) {
  try {
    var listEl = doc.getElementById('ds-stats-custom-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    var visibility = state.settings.statsVisibility || {};
    var keys = [
      'total-cost', 'hit-rate', 'avg-cost', 'savings', 'input-cost', 'output-cost',
      'total-tokens', 'hit-tokens', 'miss-tokens', 'rounds-count', 'max-turn-cost', 'avg-turn-tokens',
      'latest-hit-rate', 'hit-miss-ratio', 'avg-input-tokens', 'avg-output-tokens', 'savings-rate',
      'min-turn-cost', 'max-turn-tokens', 'min-turn-tokens'
    ];
    var names = {
      'total-cost': '总消耗',
      'hit-rate': '加权缓存命中率',
      'avg-cost': '平均每轮',
      'savings': '预计节省',
      'input-cost': '输入费用',
      'output-cost': '输出费用',
      'total-tokens': '总Tokens',
      'hit-tokens': '命中Tokens',
      'miss-tokens': '未命中Tokens',
      'rounds-count': '对话轮数',
      'max-turn-cost': '单轮最大',
      'avg-turn-tokens': '单轮平均',
      'latest-hit-rate': '最新命中率',
      'hit-miss-ratio': '命中 / 未命中',
      'avg-input-tokens': '单轮平均输入',
      'avg-output-tokens': '单轮平均输出',
      'savings-rate': '节省比例',
      'min-turn-cost': '单轮最小',
      'max-turn-tokens': '单轮最大 Tokens',
      'min-turn-tokens': '单轮最小 Tokens'
    };

    keys.forEach(function (key) {
      var lbl = doc.createElement('label');
      lbl.style.display = 'flex';
      lbl.style.alignItems = 'center';
      lbl.style.gap = '4px';
      lbl.style.cursor = 'pointer';
      lbl.style.margin = '0';
      lbl.style.fontSize = '11px';
      lbl.style.minWidth = '0';
      lbl.style.padding = '2px 0';

      var chk = doc.createElement('input');
      chk.type = 'checkbox';
      chk.style.margin = '0';
      chk.style.cursor = 'pointer';
      chk.checked = visibility[key] !== false;
      chk.onchange = function () {
        state.settings.statsVisibility[key] = this.checked;
        saveSettings();
        applyStatsVisibility();
      };
      lbl.appendChild(chk);

      var span = doc.createElement('span');
      span.style.overflow = 'hidden';
      span.style.textOverflow = 'ellipsis';
      span.style.whiteSpace = 'nowrap';
      span.textContent = names[key];
      lbl.appendChild(span);

      listEl.appendChild(lbl);
    });
  } catch (e) {
    console.warn('[DS] renderStatsCustomizerSettings error:', e);
  }
}

function renderModuleOrderSettings(doc) {
  try {
    var listEl = doc.getElementById('ds-module-order-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    var order = state.settings.moduleOrder || ['balance', 'stats', 'latest', 'history', 'diff'];
    var visibility = state.settings.moduleVisibility || {};
    var names = {
      balance: '钱包余额',
      stats: '统计概览',
      latest: '最新一条',
      history: '历史记录',
      diff: '缓存断点'
    };

    order.forEach(function (key, index) {
      var row = doc.createElement('div');
      row.className = 'ds-flex-between';
      row.style.background = 'rgba(255,255,255,0.03)';
      row.style.padding = '4px 6px';
      row.style.borderRadius = '6px';
      row.style.border = '1px solid var(--SmartThemeBorderColor, #374151)';
      row.style.fontSize = '12px';
      row.style.alignItems = 'center';
      row.style.marginBottom = '4px';
      row.style.gap = '6px';

      // Left: checkbox + label
      var lbl = doc.createElement('label');
      lbl.style.display = 'flex';
      lbl.style.alignItems = 'center';
      lbl.style.gap = '6px';
      lbl.style.cursor = 'pointer';
      lbl.style.margin = '0';
      lbl.style.flex = '1';
      lbl.style.minWidth = '0';

      var chk = doc.createElement('input');
      chk.type = 'checkbox';
      chk.style.margin = '0';
      chk.style.cursor = 'pointer';
      chk.checked = visibility[key] !== false;
      chk.onchange = function () {
        state.settings.moduleVisibility[key] = this.checked;
        saveSettings();
        applyModuleVisibility();
      };
      lbl.appendChild(chk);

      var span = doc.createElement('span');
      span.style.overflow = 'hidden';
      span.style.textOverflow = 'ellipsis';
      span.style.whiteSpace = 'nowrap';
      span.textContent = names[key];
      lbl.appendChild(span);
      row.appendChild(lbl);

      // Right: Up/Down buttons
      var btns = doc.createElement('div');
      btns.style.display = 'flex';
      btns.style.gap = '3px';
      btns.style.flexShrink = '0';

      // Up button
      var btnUp = doc.createElement('button');
      btnUp.className = 'ds-btn ds-btn-sm ds-btn-normal';
      btnUp.style.padding = '2px 5px';
      btnUp.style.fontSize = '9px';
      btnUp.style.lineHeight = '1';
      btnUp.innerHTML = '▲';
      btnUp.disabled = index === 0;
      btnUp.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        moveModule(index, -1);
      };
      btns.appendChild(btnUp);

      // Down button
      var btnDown = doc.createElement('button');
      btnDown.className = 'ds-btn ds-btn-sm ds-btn-normal';
      btnDown.style.padding = '2px 5px';
      btnDown.style.fontSize = '9px';
      btnDown.style.lineHeight = '1';
      btnDown.innerHTML = '▼';
      btnDown.disabled = index === order.length - 1;
      btnDown.onclick = function (e) {
        e.preventDefault();
        e.stopPropagation();
        moveModule(index, 1);
      };
      btns.appendChild(btnDown);

      row.appendChild(btns);
      listEl.appendChild(row);
    });
  } catch (e) {
    console.warn('[DS] renderModuleOrderSettings error:', e);
  }
}

function moveModule(index, direction) {
  try {
    var order = state.settings.moduleOrder || ['balance', 'stats', 'latest', 'history', 'diff'];
    var targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= order.length) return;
    
    // Swap
    var temp = order[index];
    order[index] = order[targetIndex];
    order[targetIndex] = temp;
    state.settings.moduleOrder = order;
    saveSettings();

    var doc = getDoc();
    renderModuleOrderSettings(doc);
    applyModuleOrder();
  } catch (e) {
    console.warn('[DS] moveModule error:', e);
  }
}

// ─── Data loading ──────────────────────────────────────────────────────────────
function loadSavedData() {
  try {
    state.apiKey = decryptKey(loadData(KEY_STORAGE)) || '';

    var bd = loadData(BALANCE_STORAGE);
    if (bd) {
      try { state.balance = JSON.parse(bd); } catch (e) {}
    }

    var cbd = loadData(CUSTOM_BALANCE_STORAGE);
    // Bug fix: empty string should be treated as null (no custom balance)
    if (cbd && cbd !== '') {
      state.customBalance = cbd;
    } else {
      state.customBalance = null;
    }

    var sd = loadData(SAVES_STORAGE);
    if (sd) {
      try { state.saves = JSON.parse(sd); } catch (e) {}
    }

    var std = loadData(SETTINGS_STORAGE);
    if (std) {
      try {
        // Bug fix #5: merge persisted settings over defaults so new keys are never missing
        var persisted = JSON.parse(std);
        state.settings = Object.assign({}, DEFAULT_SETTINGS, persisted);

        // Ensure moduleOrder contains all 5 modules (handles migrations)
        var validModules = ['balance', 'stats', 'latest', 'history', 'diff'];
        if (!Array.isArray(state.settings.moduleOrder)) {
          state.settings.moduleOrder = ['balance', 'stats', 'latest', 'history', 'diff'];
        } else {
          state.settings.moduleOrder = state.settings.moduleOrder.filter(function (m) {
            return validModules.indexOf(m) !== -1;
          });
          validModules.forEach(function (m) {
            if (state.settings.moduleOrder.indexOf(m) === -1) {
              state.settings.moduleOrder.push(m);
            }
          });
        }

        // Ensure moduleVisibility is defined and has entries for all 5 modules
        if (!state.settings.moduleVisibility) {
          state.settings.moduleVisibility = { balance: true, stats: true, latest: true, history: true, diff: true };
        } else {
          validModules.forEach(function (m) {
            if (state.settings.moduleVisibility[m] === undefined) {
              state.settings.moduleVisibility[m] = true;
            }
          });
        }

        // Ensure statsVisibility is defined and has entries for all 12 cards
        if (!state.settings.statsVisibility) {
          state.settings.statsVisibility = Object.assign({}, DEFAULT_SETTINGS.statsVisibility);
        } else {
          var validKeys = Object.keys(DEFAULT_SETTINGS.statsVisibility);
          validKeys.forEach(function (k) {
            if (state.settings.statsVisibility[k] === undefined) {
              state.settings.statsVisibility[k] = DEFAULT_SETTINGS.statsVisibility[k];
            }
          });
        }
      } catch (e) {}
    }

    var mc = loadData(MESSAGE_COUNT_STORAGE);
    state.messageCount = parseInt(mc || '0', 10) || 0;
  } catch (e) {
    console.error('[DS] loadSavedData error:', e);
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────────
function saveSaves()           { saveData(SAVES_STORAGE,          JSON.stringify(state.saves)); }
function saveCurrentSaveKey()  { saveData(CURRENT_SAVE_KEY,       state.currentSave || ''); }
function saveSettings()        { saveData(SETTINGS_STORAGE,       JSON.stringify(state.settings)); }
function saveMessageCount()    { saveData(MESSAGE_COUNT_STORAGE,  String(state.messageCount)); }

// ─── Save management ───────────────────────────────────────────────────────────
function loadCurrentSave() {
  try {
    var k = loadData(CURRENT_SAVE_KEY);
    if (k && state.saves[k]) {
      state.currentSave = k;
    } else if (Object.keys(state.saves).length > 0) {
      // pick the most recently created save
      var keys  = Object.keys(state.saves);
      var latest = keys[0];
      var lt     = 0;
      keys.forEach(function (key) {
        if ((state.saves[key].startTime || 0) > lt) {
          lt     = state.saves[key].startTime;
          latest = key;
        }
      });
      state.currentSave = latest;
    } else {
      createNewSave();
    }
  } catch (e) {
    createNewSave();
  }
}

function createNewSave() {
  var cn = '';
  try { cn = getContext().name2 || ''; } catch (e) {}
  var n   = new Date();
  var key = n.getFullYear() +
            String(n.getMonth()  + 1).padStart(2, '0') +
            String(n.getDate()      ).padStart(2, '0') + '_' +
            String(n.getHours()     ).padStart(2, '0') +
            String(n.getMinutes()   ).padStart(2, '0') +
            String(n.getSeconds()   ).padStart(2, '0') + '_' +
            (cn || 'unknown');
  state.saves[key] = {
    name:             key,
    character:        cn,
    startTime:        n.getTime(),
    total_tokens:     0,
    total_cost:       0,
    input_tokens:     0,
    output_tokens:    0,
    cache_hit_tokens: 0,
    cache_miss_tokens:0,
    input_cost:       0,
    output_cost:      0,
    rounds:           0,
    history:          [],
  };
  state.currentSave = key;
  saveSaves();
  saveCurrentSaveKey();
  return key;
}

// Bug fix #1: getSelectedSave now returns the REAL save object (not the merged
// virtual object) even when __all__ is the display mode.  processUsage always
// writes to the real current save; __all__ is only used for display in refreshUI.
function getRealCurrentSave() {
  if (state.currentSave === '__all__') {
    // Write to the save that was current before switching to __all__
    // Fall back to the most recent real save
    var keys = Object.keys(state.saves);
    if (keys.length === 0) return null;
    var latest = keys[0];
    var lt     = 0;
    keys.forEach(function (k) {
      if ((state.saves[k].startTime || 0) > lt) {
        lt     = state.saves[k].startTime;
        latest = k;
      }
    });
    return state.saves[latest] || null;
  }
  return state.saves[state.currentSave] || null;
}

// Used only for UI display — may return virtual merged object
function getSelectedSaveForDisplay() {
  if (state.currentSave === '__all__') return getMergedStats();
  return state.saves[state.currentSave] || null;
}

function getMergedStats() {
  var m = {
    total_tokens:     0,
    total_cost:       0,
    input_tokens:     0,
    output_tokens:    0,
    cache_hit_tokens: 0,
    cache_miss_tokens:0,
    input_cost:       0,
    output_cost:      0,
    rounds:           0,
    history:          [],
    startTime:        Date.now(),
  };
  var ah = [];
  var es = Date.now();
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
  m.history = ah.slice(0, 200);
  return m;
}

function deleteSave(key) {
  if (!key || key === '__all__') return;
  delete state.saves[key];
  saveSaves();
  if (state.currentSave === key) {
    var keys = Object.keys(state.saves);
    state.currentSave = keys.length > 0 ? keys[0] : null;
    if (!state.currentSave) createNewSave();
    saveCurrentSaveKey();
  }
}

// ─── Remaining-rounds estimator ───────────────────────────────────────────────
function calculateRemainingRounds(displaySave) {
  var bal;
  if (state.customBalance !== null && state.customBalance !== '') {
    bal = parseFloat(state.customBalance);
  } else if (state.balance && state.balance.balance != null) {
    bal = parseFloat(state.balance.balance);
  } else {
    return null;
  }
  if (isNaN(bal) || bal <= 0) return null;

  var s = displaySave;
  if (!s || (s.rounds || 0) === 0) return null;

  var history = s.history || [];
  if (history.length === 0) {
    var avg = (s.total_cost || 0) / s.rounds;
    return avg > 0 ? Math.floor(bal / avg) : null;
  }

  // EWMA from oldest to newest (history[0] is newest)
  var alpha = 0.3;
  var ewma  = history[history.length - 1].cost || 0;
  for (var i = history.length - 2; i >= 0; i--) {
    ewma = alpha * (history[i].cost || 0) + (1 - alpha) * ewma;
  }
  return ewma > 0 ? Math.floor(bal / ewma) : null;
}

// ─── Dynamic Theme and Display Mode Helpers ────────────────────────────────────
function getDoc() {
  try {
    if (window.parent && window.parent.document) {
      return window.parent.document;
    }
  } catch (e) {
    console.warn("[DS] Cannot access window.parent.document", e);
  }
  return document;
}

function getWin() {
  return window.parent || window;
}



function updateDynamicThemeColors() {
  try {
    var p = getWin();
    var doc = getDoc();
    var panel = doc.getElementById('ds-panel');
    if (!panel) return;

    var temp = doc.createElement('div');
    temp.style.color = 'var(--SmartThemeBlurTintColor)';
    doc.body.appendChild(temp);
    var color = p.getComputedStyle(temp).color;
    doc.body.removeChild(temp);

    var opaqueColor = '#080d14'; // fallback
    var match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      opaqueColor = 'rgb(' + match[1] + ', ' + match[2] + ', ' + match[3] + ')';
    } else if (color.startsWith('#')) {
      opaqueColor = color;
    }

    panel.style.setProperty('--ds-bg-opaque', opaqueColor);
    panel.style.setProperty('--ds-text-color', 'var(--SmartThemeBodyColor, #f3f4f6)');
    panel.style.setProperty('--ds-border-color', 'var(--SmartThemeBorderColor, #374151)');
    panel.style.setProperty('--ds-shadow-color', 'var(--SmartThemeShadowColor, rgba(0,0,0,0.5))');
  } catch (e) {
    console.warn('[DS] updateDynamicThemeColors error:', e);
  }
}

function applyDisplayMode() {
  var mode = state.settings.displayMode || 'wand-modal';
  var doc = getDoc();
  var panel = doc.getElementById('ds-panel');
  if (panel) {
    panel.classList.remove('ds-fullscreen', 'ds-qr-top', 'ds-qr-bottom', 'ds-qr-left', 'ds-qr-right');
    if (mode === 'wand-fullscreen') {
      panel.classList.add('ds-fullscreen');
    } else if (mode === 'qr-top') {
      panel.classList.add('ds-qr-top');
    } else if (mode === 'qr-bottom') {
      panel.classList.add('ds-qr-bottom');
    } else if (mode === 'qr-left') {
      panel.classList.add('ds-qr-left');
    } else if (mode === 'qr-right') {
      panel.classList.add('ds-qr-right');
    }
  }

  var wandBtn = doc.getElementById('ds_wand_container');
  if (wandBtn) {
    if (mode.indexOf('qr-') === 0) {
      wandBtn.style.setProperty('display', 'none', 'important');
    } else {
      wandBtn.style.setProperty('display', 'flex', 'important');
    }
  }

  ensureWalletButton();
}

function ensureWalletButton() {
  var mode = state.settings.displayMode || 'wand-modal';
  if (mode.indexOf('qr-') !== 0) {
    removeWalletButton();
    return;
  }

  var doc = getDoc();
  var btn = doc.getElementById('ds-qr-wallet-btn');
  if (btn) return;

  btn = doc.createElement('div');
  btn.id = 'ds-qr-wallet-btn';
  btn.className = 'qr--button menu_button interactable';
  btn.tabIndex = 0;
  btn.role = 'button';
  btn.title = 'DeepSeek使用统计';
  btn.innerHTML = '<i class="fa-solid fa-wallet"></i>';
  
  // Adaptive style
  btn.style.setProperty('display', 'inline-flex', 'important');
  btn.style.alignItems = 'center';
  btn.style.justifyContent = 'center';
  btn.style.color = 'var(--SmartThemeBodyColor, #f3f4f6)';
  btn.style.transition = 'background-color 0.2s, transform 0.1s';
  
  btn.addEventListener('mouseenter', function() {
    btn.style.background = 'rgba(255, 255, 255, 0.15)';
    btn.style.transform = 'scale(1.05)';
  });
  btn.addEventListener('mouseleave', function() {
    btn.style.background = 'transparent';
    btn.style.transform = 'scale(1)';
  });
  btn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    togglePanel();
  });

  // Query container in ST
  var btnContainer = doc.querySelector('#qr--bar .qr--buttons') || doc.getElementById('qr--bar');
  if (btnContainer) {
    btnContainer.appendChild(btn); // Changed to appendBtn (appendChild)
  }
}

function removeWalletButton() {
  var doc = getDoc();
  var btn = doc.getElementById('ds-qr-wallet-btn');
  if (btn) btn.remove();
}



// ─── Event setup ──────────────────────────────────────────────────────────────
function setupEvents() {
  eventSource.on(event_types.MESSAGE_RECEIVED, function () {
    setTimeout(refreshUI, 500);
  });
}

// ─── Fetch interception ───────────────────────────────────────────────────────
function patchFetch() {
  var p = window.parent || window;
  if (p._ds_fetch_patched) return;
  var rawFetch = p.fetch;

  p.fetch = function () {
    var args = arguments;
    var url  = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);

    if (url && url.indexOf(TARGET_API) !== -1) {
      // Parse request body for messages snapshot
      var capturedMessages = null;
      try {
        if (args[1] && typeof args[1].body === 'string') {
          var reqPayload = JSON.parse(args[1].body);
          if (reqPayload && Array.isArray(reqPayload.messages)) {
            capturedMessages = reqPayload.messages.map(function (m) {
              var t = m.content || m.text || '';
              return {
                role: m.role || 'unknown',
                text: t,
                length: t.length,
                hash: createTextHash(t)
              };
            });
          }
        }
      } catch (e) {
        console.warn('[DS] Failed to parse request body for messages:', e);
      }

      // Bug fix #10 (debug mode): do NOT fake a Response that SillyTavern tries
      // to parse — instead still call the real fetch but inject usage afterwards
      // via setTimeout so the real response flow is unaffected.
      if (state.settings.debug) {
        var fakeUsage = {
          prompt_cache_hit_tokens:  state.settings.debugHit,
          prompt_cache_miss_tokens: state.settings.debugMiss,
          completion_tokens:        state.settings.debugOutput,
          total_tokens: state.settings.debugHit + state.settings.debugMiss + state.settings.debugOutput,
        };
        // Bug fix #2 (model override): pass the debug model explicitly and
        // DO NOT let processUsage override it from getContext().model
        setTimeout(function () {
          processUsage(fakeUsage, state.settings.debugModel, true /*isDebug*/, capturedMessages);
        }, 100);
        // Still let the real request through so SillyTavern works normally
        return rawFetch.apply(p, args);
      }

      return rawFetch.apply(p, args).then(function (res) {
        var clone = res.clone();
        clone.text().then(function (text) {
          try {
            var data    = null;
            var trimmed = text.trim();
            if (trimmed.startsWith('{')) {
              data = JSON.parse(trimmed);
            } else {
              // SSE stream — take the LAST chunk that contains usage
              text.split('\n').forEach(function (line) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                  try {
                    var chunk = JSON.parse(line.substring(6));
                    if (chunk.usage) data = chunk;
                  } catch (e) {}
                }
              });
            }
            if (data && data.usage) {
              // Bug fix #2: pass model from API response; processUsage will not
              // override it from getContext() when it is already valid
              processUsage(data.usage, data.model || '', false, capturedMessages);
            }
          } catch (e) {}
        }).catch(function () {});
        return res;
      });
    }

    return rawFetch.apply(p, args);
  };

  p._ds_fetch_patched = true;
}

// ─── Usage processing ─────────────────────────────────────────────────────────
// Bug fix #1 + #2: write to the REAL current save (not the virtual merged object)
// and respect the model passed in rather than always overriding from getContext()
function processUsage(usage, model, isDebug, messages) {
  // Resolve model name: prefer what the API returned, then context, then fallback
  var modelName = (model && model.trim()) ? model.trim() : '';
  if (!modelName && !isDebug) {
    try { modelName = getContext().model || ''; } catch (e) {}
  }
  if (!modelName) modelName = 'deepseek-v4-flash';

  var hit   = usage.prompt_cache_hit_tokens  || 0;
  var miss  = usage.prompt_cache_miss_tokens || 0;
  var comp  = usage.completion_tokens        || 0;
  var total = usage.total_tokens || (hit + miss + comp);

  // Deduplicate double-triggered requests
  var msgSig = '';
  if (messages && messages.length > 0) {
    msgSig = messages.map(function (m) { return m.hash || ''; }).join(',');
  }
  var signature = msgSig + '_' + hit + '_' + miss + '_' + comp + '_' + modelName;
  var now = Date.now();
  if (signature === lastProcessedSignature && (now - lastProcessedTime) < 2000) {
    console.log('[DS] Duplicate usage processing skipped for signature:', signature);
    return;
  }
  lastProcessedSignature = signature;
  lastProcessedTime = now;

  var lu = {
    timestamp:               Date.now(),
    model:                   modelName,
    prompt_tokens:           hit + miss,
    prompt_cache_hit_tokens: hit,
    prompt_cache_miss_tokens:miss,
    completion_tokens:       comp,
    total_tokens:            total,
  };
  lu.cost    = calcCost(lu);
  state.lastUsage = lu;

  // Bug fix #1: always write to the REAL save, not the virtual __all__ object
  var s = getRealCurrentSave();
  if (!s) return;

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
    timestamp:        lu.timestamp,
    model:            lu.model,
    prompt_tokens:    lu.prompt_tokens,
    cache_hit_tokens: lu.prompt_cache_hit_tokens,
    cache_miss_tokens:lu.prompt_cache_miss_tokens,
    completion_tokens:lu.completion_tokens,
    total_tokens:     lu.total_tokens,
    input_cost:       lu.cost.input,
    output_cost:      lu.cost.output,
    cost:             lu.cost.total,
    cache_hit_rate:   lu.prompt_tokens > 0
                        ? (lu.prompt_cache_hit_tokens / lu.prompt_tokens * 100)
                        : 0,
    messages:         messages || [],
  });

  // Prune older history items to only keep prompt messages for the last 10 rounds
  for (var i = 10; i < s.history.length; i++) {
    if (s.history[i].messages) {
      delete s.history[i].messages;
    }
  }

  if (s.history.length > 200) s.history = s.history.slice(0, 200);

  saveSaves();

  // Deduct from whichever balance is active
  if (state.customBalance !== null && state.customBalance !== '') {
    var newCB = parseFloat(state.customBalance) - lu.cost.total;
    state.customBalance = String(newCB);
    saveData(CUSTOM_BALANCE_STORAGE, state.customBalance);
  } else if (state.balance && state.balance.balance != null) {
    state.balance.balance = parseFloat(state.balance.balance) - lu.cost.total;
    saveData(BALANCE_STORAGE, JSON.stringify(state.balance));
  }

  state.messageCount++;
  saveMessageCount();

  if (state.settings.autoBalance && state.apiKey &&
      state.messageCount >= state.settings.balanceInterval) {
    state.messageCount = 0;
    saveMessageCount();
    autoQueryBalance();
  }

  refreshUI();
}

// ─── Cost calculation ─────────────────────────────────────────────────────────
function calcCost(u) {
  var p  = PRICING[u.model] || PRICING['deepseek-v4-flash'];
  var ih = (u.prompt_cache_hit_tokens  / 1e6) * p.hit;
  var im = (u.prompt_cache_miss_tokens / 1e6) * p.miss;
  var o  = (u.completion_tokens        / 1e6) * p.output;
  return { input: ih + im, output: o, total: ih + im + o };
}

function createTextHash(text) {
  if (typeof text !== 'string') return '';
  var hash = 2166136261;
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul ? Math.imul(hash, 16777619) : (hash * 16777619) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function commonPrefixLength(left, right) {
  var maxLength = Math.min(left.length, right.length);
  var index = 0;
  while (index < maxLength && left.charCodeAt(index) === right.charCodeAt(index)) {
    index += 1;
  }
  return index;
}

function commonSuffixLength(left, right, prefixLength) {
  var leftIndex = left.length - 1;
  var rightIndex = right.length - 1;
  var length = 0;

  while (leftIndex >= prefixLength && rightIndex >= prefixLength && left.charCodeAt(leftIndex) === right.charCodeAt(rightIndex)) {
    leftIndex -= 1;
    rightIndex -= 1;
    length += 1;
  }

  return length;
}

function buildDiffContext(beforeText, afterText, contextSize) {
  if (!contextSize) contextSize = 800;
  var prefixLength = commonPrefixLength(beforeText, afterText);
  var suffixLength = commonSuffixLength(beforeText, afterText, prefixLength);
  var beforeEnd = beforeText.length - suffixLength;
  var afterEnd = afterText.length - suffixLength;
  var beforeChanged = beforeText.slice(prefixLength, beforeEnd);
  var afterChanged = afterText.slice(prefixLength, afterEnd);
  var prefixStart = Math.max(0, prefixLength - contextSize);
  var suffixEnd = Math.min(beforeText.length, beforeEnd + contextSize);

  return {
    prefix: beforeText.slice(prefixStart, prefixLength),
    beforeChanged: beforeChanged.slice(0, contextSize * 2),
    afterChanged: afterChanged.slice(0, contextSize * 2),
    suffix: beforeText.slice(beforeEnd, suffixEnd),
    prefixLength: prefixLength,
    suffixLength: suffixLength,
    beforeChangedLength: beforeChanged.length,
    afterChangedLength: afterChanged.length,
    hasMorePrefix: prefixStart > 0,
    hasMoreSuffix: suffixEnd < beforeText.length,
  };
}

function comparePromptRecords(before, after, contextSize) {
  if (!contextSize) contextSize = 800;
  if (!before || !after) {
    return { kind: 'same', summary: '请选择旧请求和新请求进行对比。', context: null };
  }

  var beforeMessages = before.messages || [];
  var afterMessages = after.messages || [];

  var filterEmpty = function (msgs) {
    return msgs.map(function (m, idx) { return { index: idx, message: m }; })
               .filter(function (item) { return item.message.text.trim().length > 0; });
  };

  var beforeComp = filterEmpty(beforeMessages);
  var afterComp = filterEmpty(afterMessages);

  var maxLength = Math.max(beforeComp.length, afterComp.length);

  for (var i = 0; i < maxLength; i++) {
    var beforeItem = beforeComp[i];
    var afterItem = afterComp[i];
    var beforeMsg = beforeItem ? beforeItem.message : null;
    var afterMsg = afterItem ? afterItem.message : null;

    if (!beforeMsg && afterMsg) {
      return {
        kind: 'message_added',
        summary: '第 ' + (afterItem.index + 1) + ' 条有效消息是新增的。',
        index: afterItem.index,
        beforeIndex: null,
        afterIndex: afterItem.index,
        beforeRole: null,
        afterRole: afterMsg.role,
        beforeLength: 0,
        afterLength: afterMsg.length,
        context: buildDiffContext('', afterMsg.text, contextSize)
      };
    }

    if (beforeMsg && !afterMsg) {
      return {
        kind: 'message_removed',
        summary: '第 ' + (beforeItem.index + 1) + ' 条有效消息被移除。',
        index: beforeItem.index,
        beforeIndex: beforeItem.index,
        afterIndex: null,
        beforeRole: beforeMsg.role,
        afterRole: null,
        beforeLength: beforeMsg.length,
        afterLength: 0,
        context: buildDiffContext(beforeMsg.text, '', contextSize)
      };
    }

    if (beforeMsg.role !== afterMsg.role) {
      return {
        kind: 'role_changed',
        summary: '第 ' + (afterItem.index + 1) + ' 条有效消息的角色从 ' + beforeMsg.role + ' 变更为 ' + afterMsg.role + '。',
        index: afterItem.index,
        beforeIndex: beforeItem.index,
        afterIndex: afterItem.index,
        beforeRole: beforeMsg.role,
        afterRole: afterMsg.role,
        beforeLength: beforeMsg.length,
        afterLength: afterMsg.length,
        context: buildDiffContext(beforeMsg.text, afterMsg.text, contextSize)
      };
    }

    if (beforeMsg.hash !== afterMsg.hash || beforeMsg.text !== afterMsg.text) {
      return {
        kind: 'content_changed',
        summary: '第 ' + (afterItem.index + 1) + ' 条有效 ' + afterMsg.role + ' 消息内容发生变化。',
        index: afterItem.index,
        beforeIndex: beforeItem.index,
        afterIndex: afterItem.index,
        beforeRole: beforeMsg.role,
        afterRole: afterMsg.role,
        beforeLength: beforeMsg.length,
        afterLength: afterMsg.length,
        context: buildDiffContext(beforeMsg.text, afterMsg.text, contextSize)
      };
    }
  }

  return {
    kind: 'same',
    summary: '两次请求的有效消息内容完全一致。',
    index: null,
    beforeIndex: null,
    afterIndex: null,
    beforeRole: null,
    afterRole: null,
    beforeLength: 0,
    afterLength: 0,
    context: null
  };
}

// ─── XOR key encryption (obfuscation, NOT security) ───────────────────────────
var XOR_KEY = 'ds-stats-v1-xor-key!@#$%^&*';

function encryptKey(plaintext) {
  if (!plaintext) return '';
  var result = '';
  for (var i = 0; i < plaintext.length; i++) {
    result += String.fromCharCode(
      plaintext.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length)
    );
  }
  return btoa(result);
}

function decryptKey(ciphertext) {
  if (!ciphertext) return '';
  try {
    var decoded = atob(ciphertext);
    var result  = '';
    for (var i = 0; i < decoded.length; i++) {
      result += String.fromCharCode(
        decoded.charCodeAt(i) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length)
      );
    }
    return result;
  } catch (e) {
    return ciphertext; // already plaintext (legacy)
  }
}

function saveApiKey(key) {
  saveData(KEY_STORAGE, encryptKey(key));
  state.apiKey = key;
}

function saveBalanceData(data) {
  state.balance = data;
  saveData(BALANCE_STORAGE, JSON.stringify(data));
}

// ─── Balance API ──────────────────────────────────────────────────────────────
async function queryBalance() {
  var doc = (window.parent || window).document;
  var seEl  = doc.getElementById('ds-balance-status');
  var beEl  = doc.getElementById('ds-balance');
  var btn   = doc.getElementById('ds-btn-query-balance');

  if (!state.apiKey) {
    if (seEl) seEl.textContent = '请先输入API密钥';
    return;
  }

  if (btn) btn.textContent = '查询中...';
  if (seEl) seEl.textContent = '正在查询...';

  try {
    var r = await fetch('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + state.apiKey,
        'Content-Type':  'application/json',
      },
    });
    var d = await r.json();

    if (d.is_available && d.balance_infos && d.balance_infos.length > 0) {
      var info = d.balance_infos[0];
      saveBalanceData({
        balance:   info.total_balance,
        currency:  info.currency,
        available: d.is_available,
        timestamp: Date.now(),
      });
      if (state.customBalance === null || state.customBalance === '') {
        if (beEl) beEl.textContent = '¥' + info.total_balance + ' ' + info.currency;
        if (seEl) seEl.textContent = '账户可用 | ' + new Date().toLocaleTimeString('zh-CN');
      } else {
        if (seEl) seEl.textContent = '自定义余额略过 | API: ¥' + info.total_balance;
      }
    } else {
      if (beEl) beEl.textContent = '查询失败';
      if (seEl) seEl.textContent = d.error ? d.error.message : '请检查密钥';
    }
  } catch (e) {
    if (beEl) beEl.textContent = '网络错误';
    if (seEl) seEl.textContent = e.message;
  }

  if (btn) btn.textContent = '查询';
}

async function autoQueryBalance() {
  if (!state.apiKey) return;
  try {
    var r = await fetch('https://api.deepseek.com/user/balance', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + state.apiKey,
        'Content-Type':  'application/json',
      },
    });
    var d = await r.json();
    if (d.is_available && d.balance_infos && d.balance_infos.length > 0) {
      var info = d.balance_infos[0];
      saveBalanceData({
        balance:   info.total_balance,
        currency:  info.currency,
        available: d.is_available,
        timestamp: Date.now(),
      });
      if (state.customBalance === null || state.customBalance === '') {
        var doc  = (window.parent || window).document;
        var beEl = doc.getElementById('ds-balance');
        var seEl = doc.getElementById('ds-balance-status');
        if (beEl) beEl.textContent = '¥' + info.total_balance + ' ' + info.currency;
        if (seEl) seEl.textContent = '账户可用 | ' + new Date().toLocaleTimeString('zh-CN');
      }
    }
  } catch (e) {}
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function formatStartTime(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  return d.toLocaleDateString('zh-CN') + ' ' +
         d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

// ─── UI creation ──────────────────────────────────────────────────────────────
function createUI() {
  var p   = window.parent || window;
  var doc = p.document;

  // Bug fix #15: always tear down existing elements to ensure event bindings
  // are fresh (handles hot-reload / re-init scenarios correctly)
  ['ds-overlay', 'ds-panel'].forEach(function (id) {
    var el = doc.getElementById(id);
    if (el) el.remove();
  });

  // Overlay
  var overlay = doc.createElement('div');
  overlay.id  = 'ds-overlay';
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) togglePanel();
  });

  // Panel shell
  var panel = doc.createElement('div');
  panel.id  = 'ds-panel';

  // Header
  var header = doc.createElement('div');
  header.className = 'ds-header';
  
  var titleEl = doc.createElement('div');
  titleEl.className = 'ds-header-title';
  titleEl.innerHTML = '<i class="fa-solid fa-fish" style="font-size: 18px;"></i>';
  header.appendChild(titleEl);

  var actionsEl = doc.createElement('div');
  actionsEl.style.display = 'flex';
  actionsEl.style.alignItems = 'center';
  actionsEl.style.gap = '8px';

  // Settings Gear Icon
  var settingsIcon = doc.createElement('div');
  settingsIcon.id = 'ds-header-settings-btn';
  settingsIcon.className = 'ds-header-icon';
  settingsIcon.title = '界面入口设置';
  settingsIcon.innerHTML = '<i class="fa-solid fa-gear"></i>';
  actionsEl.appendChild(settingsIcon);

  // Close Button
  var closeBtn = doc.createElement('div');
  closeBtn.className = 'ds-close-btn';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    togglePanel();
  });
  actionsEl.appendChild(closeBtn);
  header.appendChild(actionsEl);

  // Dropdown Menu Container (absolute inside panel)
  var settingsDropdown = doc.createElement('div');
  settingsDropdown.id = 'ds-settings-dropdown';
  settingsDropdown.className = 'ds-settings-dropdown';
  settingsDropdown.innerHTML = 
    '<details class="ds-dropdown-section">' +
      '<summary>界面入口及展示</summary>' +
      '<div class="ds-dropdown-section-content">' +
        '<label class="ds-settings-dropdown-item">' +
          '<input type="radio" name="ds-display-mode" value="wand-modal">' +
          '<span>魔法棒菜单 (当前形式)</span>' +
        '</label>' +
        '<label class="ds-settings-dropdown-item">' +
          '<input type="radio" name="ds-display-mode" value="wand-fullscreen">' +
          '<span>魔法棒菜单 (全屏)</span>' +
        '</label>' +
        '<label class="ds-settings-dropdown-item">' +
          '<input type="radio" name="ds-display-mode" value="qr-bar">' +
          '<span>QR 栏 (普通弹窗)</span>' +
        '</label>' +
        '<label class="ds-settings-dropdown-item">' +
          '<input type="radio" name="ds-display-mode" value="qr-top">' +
          '<span>QR 栏 (自上方滑出)</span>' +
        '</label>' +
        '<label class="ds-settings-dropdown-item">' +
          '<input type="radio" name="ds-display-mode" value="qr-bottom">' +
          '<span>QR 栏 (自下方滑出)</span>' +
        '</label>' +
        '<label class="ds-settings-dropdown-item">' +
          '<input type="radio" name="ds-display-mode" value="qr-left">' +
          '<span>QR 栏 (自左侧滑出)</span>' +
        '</label>' +
        '<label class="ds-settings-dropdown-item">' +
          '<input type="radio" name="ds-display-mode" value="qr-right">' +
          '<span>QR 栏 (自右侧滑出)</span>' +
        '</label>' +
      '</div>' +
    '</details>' +
    '<details class="ds-dropdown-section">' +
      '<summary>模块排序与显示</summary>' +
      '<div class="ds-dropdown-section-content">' +
        '<div id="ds-module-order-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:6px;"></div>' +
      '</div>' +
    '</details>' +
    '<details class="ds-dropdown-section">' +
      '<summary>统计卡片定制</summary>' +
      '<div class="ds-dropdown-section-content">' +
        '<div id="ds-stats-custom-list" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;"></div>' +
      '</div>' +
    '</details>' +
    '<details class="ds-dropdown-section">' +
      '<summary>API密钥与余额</summary>' +
      '<div class="ds-dropdown-section-content">' +
        '<div class="ds-margin-b-8">' +
          '<div style="font-size:10px;color:var(--SmartThemeEmColor);margin-bottom:4px">API密钥</div>' +
          '<div class="ds-flex-row">' +
            '<input id="ds-api-key" type="password" placeholder="API密钥" class="ds-input" style="height:28px;padding:4px 8px;font-size:12px;width:0;min-width:0;flex:1;">' +
            '<button id="ds-btn-save-key" class="ds-btn ds-btn-sm ds-btn-normal" style="padding:2px 8px;">保存</button>' +
          '</div>' +
        '</div>' +
        '<div class="ds-margin-b-8">' +
          '<div class="ds-flex-between">' +
            '<span class="ds-switch-label" style="font-size:12px">自动校准余额</span>' +
            '<label class="ds-switch">' +
              '<input type="checkbox" id="ds-auto-balance">' +
              '<span class="ds-switch-slider"></span>' +
            '</label>' +
          '</div>' +
          '<div id="ds-auto-balance-interval" style="display:none;margin-top:6px;">' +
            '<div class="ds-flex-between">' +
              '<span class="ds-switch-label" style="font-size:11px;color:var(--SmartThemeEmColor)">校准间隔</span>' +
              '<div style="display:flex;align-items:center;gap:4px">' +
                '<input type="number" id="ds-balance-interval" min="1" max="100" value="10" ' +
                       'class="ds-input-compact" style="width:50px;text-align:center;height:22px;padding:2px 4px;">' +
                '<span style="font-size:11px;color:var(--SmartThemeEmColor)">条消息</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="ds-margin-b-8">' +
          '<div style="font-size:10px;color:var(--SmartThemeEmColor);margin-bottom:4px">自定义余额</div>' +
          '<div class="ds-flex-row">' +
            '<input id="ds-custom-balance" type="number" step="0.01" placeholder="余额金额" class="ds-input" style="height:28px;padding:4px 8px;font-size:12px;width:0;min-width:0;flex:1;">' +
            '<button id="ds-btn-save-balance" class="ds-btn ds-btn-sm ds-btn-success" style="padding:2px 8px;">保存</button>' +
            '<button id="ds-btn-clear-balance" class="ds-btn ds-btn-sm ds-btn-danger" style="padding:2px 8px;">清除</button>' +
          '</div>' +
          '<div id="ds-custom-balance-status" style="font-size:10px;color:var(--SmartThemeEmColor);margin-top:2px"></div>' +
        '</div>' +
      '</div>' +
    '</details>' +
    '<details class="ds-dropdown-section" open>' +
      '<summary>调试模式</summary>' +
      '<div class="ds-dropdown-section-content">' +
        '<div class="ds-flex-between ds-margin-b-8">' +
          '<span class="ds-switch-label" style="font-size:12px">开启调试</span>' +
          '<label class="ds-switch">' +
            '<input type="checkbox" id="ds-debug-mode">' +
            '<span class="ds-switch-slider"></span>' +
          '</label>' +
        '</div>' +
        '<div id="ds-debug-panel" style="display:none;margin-top:6px;">' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:4px">' +
            '<div>' +
              '<div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px">命中 tokens</div>' +
              '<input id="ds-debug-hit" type="number" min="0" value="10000" class="ds-input-compact" style="height:22px;padding:2px 4px;font-size:11px;">' +
            '</div>' +
            '<div>' +
              '<div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px">未命中 tokens</div>' +
              '<input id="ds-debug-miss" type="number" min="0" value="5000" class="ds-input-compact" style="height:22px;padding:2px 4px;font-size:11px;">' +
            '</div>' +
            '<div>' +
              '<div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px">输出 tokens</div>' +
              '<input id="ds-debug-output" type="number" min="0" value="2000" class="ds-input-compact" style="height:22px;padding:2px 4px;font-size:11px;">' +
            '</div>' +
            '<div>' +
              '<div style="font-size:9px;color:var(--SmartThemeEmColor);margin-bottom:2px">模型</div>' +
              '<select id="ds-debug-model" class="ds-input-compact" style="height:22px;padding:2px 4px;font-size:11px;">' +
                '<option value="deepseek-v4-flash">deepseek-v4-flash</option>' +
                '<option value="deepseek-v4-pro">deepseek-v4-pro</option>' +
                '<option value="deepseek-chat">deepseek-chat</option>' +
                '<option value="deepseek-reasoner">deepseek-reasoner</option>' +
              '</select>' +
            '</div>' +
          '</div>' +
          '<div id="ds-debug-status" style="font-size:10px;color:var(--SmartThemeQuoteColor)"></div>' +
        '</div>' +
      '</div>' +
    '</details>' +
    '<div class="ds-settings-dropdown-divider" style="margin: 8px 0; border-top: 1px solid var(--SmartThemeBorderColor, #374151);"></div>' +
    '<button id="ds-btn-show-help" class="ds-btn ds-btn-sm ds-btn-normal" style="width: 100%; display: flex; align-items: center; justify-content: center; gap: 6px;">' +
      '<i class="fa-solid fa-circle-question"></i> 使用说明 & 版本' +
    '</button>';

  // Content
  var content = doc.createElement('div');
  content.id        = 'ds-content';
  content.className = 'ds-content';
  content.innerHTML = PANEL_HTML;

  // Help Modal Container
  var helpModal = doc.createElement('div');
  helpModal.id = 'ds-help-modal';
  helpModal.className = 'ds-help-modal';
  helpModal.innerHTML = 
    '<div class="ds-help-modal-header">' +
      '<div class="ds-help-modal-title">' +
        '<i class="fa-solid fa-circle-question"></i> 使用说明 & 关于' +
      '</div>' +
      '<div id="ds-help-modal-close" class="ds-close-btn">✕</div>' +
    '</div>' +
    '<div class="ds-help-modal-body">' +
      '<div class="ds-help-modal-version">版本：release1.61</div>' +
      '<div class="ds-help-block">' +
        '<div class="ds-help-label-red">⚠️ 安全提示</div>' +
        '<div>在本插件中填入 API 密钥存在安全风险。密钥存储在浏览器 localStorage 中，建议使用权限受限的 API 密钥。</div>' +
      '</div>' +
      '<div class="ds-help-block">' +
        '<div class="ds-help-label-blue">ℹ️ 使用方法</div>' +
        '<div class="ds-help-modal-list">' +
          '<div>1. 输入 API 密钥并保存</div>' +
          '<div>2. 点击“查询”获取余额</div>' +
          '<div>3. 正常进行聊天对话，插件将自动统计数据</div>' +
          '<div>4. 可新建、切换或删除具体聊天存档</div>' +
          '<div>5. 选择“全部存档”可查看全局合并统计</div>' +
        '</div>' +
      '</div>' +
      '<div class="ds-help-block">' +
        '<div class="ds-help-label-purple">✨ 关于</div>' +
        '<div>本插件由 AI 编写、优化及修复，版本 release1.61</div>' +
      '</div>' +
    '</div>';

  panel.appendChild(header);
  panel.appendChild(settingsDropdown);
  panel.appendChild(content);
  panel.appendChild(helpModal);
  doc.body.appendChild(overlay);
  doc.body.appendChild(panel);

  // Bind controls after DOM is in place
  // Bug fix #14: all declarations are contained in a single block scope via let
  // (emulated here via a self-contained function to avoid var hoisting confusion)
  setTimeout(function () {
    bindUIControls(doc);
  }, 100);
}

function bindUIControls(doc) {
  // Helper
  function el(id) { return doc.getElementById(id); }

  // ── Restore persisted values into inputs ──────────────────────────────────
  var apiKeyInput = el('ds-api-key');
  if (apiKeyInput && state.apiKey) apiKeyInput.value = state.apiKey;

  var customBalanceInput = el('ds-custom-balance');
  if (state.customBalance !== null && state.customBalance !== '') {
    var beEl = el('ds-balance');
    var seEl = el('ds-balance-status');
    if (beEl) beEl.textContent = '¥' + parseFloat(state.customBalance).toFixed(2) + ' CNY';
    if (seEl) seEl.textContent = '自定义余额';
    if (customBalanceInput) customBalanceInput.value = state.customBalance;
    var cbStatusEl = el('ds-custom-balance-status');
    if (cbStatusEl) cbStatusEl.textContent = '已设置';
  } else if (state.balance) {
    var beEl2 = el('ds-balance');
    var seEl2 = el('ds-balance-status');
    if (beEl2) beEl2.textContent = '¥' + state.balance.balance + ' ' + state.balance.currency;
    if (seEl2) seEl2.textContent = '账户可用';
  }

  // ── Save management buttons ───────────────────────────────────────────────
  var btnNewSave = el('ds-btn-new-save');
  if (btnNewSave) {
    btnNewSave.onclick = function () {
      createNewSave();
      refreshUI();
    };
  }

  var btnDeleteSave = el('ds-btn-delete-save');
  if (btnDeleteSave) {
    btnDeleteSave.onclick = function () {
      // Prevent deletion when viewing __all__
      if (state.currentSave === '__all__') {
        alert('请先选择具体存档后再删除');
        return;
      }
      if (confirm('确定删除当前存档？')) {
        deleteSave(state.currentSave);
        refreshUI();
      }
    };
  }

  var btnDeleteAll = el('ds-btn-delete-all');
  if (btnDeleteAll) {
    btnDeleteAll.onclick = function () {
      if (confirm('确定清空全部存档？此操作不可恢复！')) {
        state.saves = {};
        saveSaves();
        createNewSave();
        refreshUI();
      }
    };
  }

  var btnRefresh = el('ds-btn-refresh');
  if (btnRefresh) {
    btnRefresh.onclick = function () { refreshUI(); };
  }

  var btnClear = el('ds-btn-clear');
  if (btnClear) {
    btnClear.onclick = function () {
      // Bug fix #4: disallow clear when __all__ is selected (no real save to clear)
      if (state.currentSave === '__all__') {
        alert('请先选择具体存档后再清空');
        return;
      }
      var s = state.saves[state.currentSave];
      if (!s) return;
      s.total_tokens      = 0;
      s.total_cost        = 0;
      s.input_tokens      = 0;
      s.output_tokens     = 0;
      s.cache_hit_tokens  = 0;
      s.cache_miss_tokens = 0;
      s.input_cost        = 0;
      s.output_cost       = 0;
      s.rounds            = 0;
      s.history           = [];
      saveSaves();
      refreshUI();
    };
  }

  // ── API key ───────────────────────────────────────────────────────────────
  var btnSaveKey = el('ds-btn-save-key');
  if (btnSaveKey) {
    btnSaveKey.onclick = function () {
      var key = apiKeyInput ? apiKeyInput.value.trim() : '';
      saveApiKey(key);
      var statusEl = el('ds-balance-status');
      if (statusEl) statusEl.textContent = key ? '密钥已保存' : '密钥已清空';
    };
  }

  var btnQueryBal = el('ds-btn-query-balance');
  if (btnQueryBal) {
    btnQueryBal.onclick = function () { queryBalance(); };
  }



  // ── Auto-balance toggle ───────────────────────────────────────────────────
  var autoBalChk      = el('ds-auto-balance');
  var autoBalInterval = el('ds-auto-balance-interval');
  var balIntervalInp  = el('ds-balance-interval');
  if (autoBalChk) {
    autoBalChk.checked = state.settings.autoBalance;
    if (autoBalInterval) autoBalInterval.style.display = state.settings.autoBalance ? 'block' : 'none';
    if (balIntervalInp)  balIntervalInp.value = state.settings.balanceInterval;

    autoBalChk.onchange = function () {
      state.settings.autoBalance = this.checked;
      if (autoBalInterval) autoBalInterval.style.display = this.checked ? 'block' : 'none';
      saveSettings();
    };
  }
  if (balIntervalInp) {
    balIntervalInp.onchange = function () {
      state.settings.balanceInterval = parseInt(this.value, 10) || 10;
      saveSettings();
    };
  }

  // ── Custom balance ────────────────────────────────────────────────────────
  var btnSaveBal  = el('ds-btn-save-balance');
  var btnClearBal = el('ds-btn-clear-balance');
  var cbStatus    = el('ds-custom-balance-status');

  if (btnSaveBal) {
    btnSaveBal.onclick = function () {
      var val = customBalanceInput ? customBalanceInput.value.trim() : '';
      if (val === '' || isNaN(parseFloat(val))) {
        if (cbStatus) { cbStatus.textContent = '请输入有效金额'; cbStatus.style.color = '#f87171'; }
        return;
      }
      state.customBalance = val;
      saveData(CUSTOM_BALANCE_STORAGE, val);
      if (cbStatus) { cbStatus.textContent = '已保存'; cbStatus.style.color = '#34d399'; }
      var beEl3 = el('ds-balance');
      var seEl3 = el('ds-balance-status');
      if (beEl3) beEl3.textContent = '¥' + parseFloat(val).toFixed(2) + ' CNY';
      if (seEl3) seEl3.textContent = '自定义余额';
      refreshUI();
    };
  }

  if (btnClearBal) {
    btnClearBal.onclick = function () {
      state.customBalance = null;
      saveData(CUSTOM_BALANCE_STORAGE, '');
      if (customBalanceInput) customBalanceInput.value = '';
      if (cbStatus) { cbStatus.textContent = '已清除，恢复使用API余额'; cbStatus.style.color = '#9ca3af'; }
      var beEl4 = el('ds-balance');
      var seEl4 = el('ds-balance-status');
      if (state.balance) {
        if (beEl4) beEl4.textContent = '¥' + state.balance.balance + ' ' + state.balance.currency;
        if (seEl4) seEl4.textContent = '账户可用';
      } else {
        if (beEl4) beEl4.textContent = '¥0.00 CNY';
        if (seEl4) seEl4.textContent = '';
      }
      refreshUI();
    };
  }

  // ── Debug mode ────────────────────────────────────────────────────────────
  var debugToggle = el('ds-debug-mode');
  var debugPanel  = el('ds-debug-panel');
  var debugHitEl  = el('ds-debug-hit');
  var debugMissEl = el('ds-debug-miss');
  var debugOutEl  = el('ds-debug-output');
  var debugMdlEl  = el('ds-debug-model');
  var debugStatus = el('ds-debug-status');

  if (debugToggle) {
    debugToggle.checked = state.settings.debug;
    if (debugPanel)  debugPanel.style.display  = state.settings.debug ? 'block' : 'none';
    if (debugHitEl)  debugHitEl.value  = state.settings.debugHit;
    if (debugMissEl) debugMissEl.value = state.settings.debugMiss;
    if (debugOutEl)  debugOutEl.value  = state.settings.debugOutput;
    if (debugMdlEl)  debugMdlEl.value  = state.settings.debugModel;
    if (debugStatus) debugStatus.textContent = state.settings.debug
      ? '调试模式已开启，下次对话将使用模拟参数，不会产生API费用' : '';

    debugToggle.onchange = function () {
      state.settings.debug = this.checked;
      if (debugPanel) debugPanel.style.display = this.checked ? 'block' : 'none';
      if (debugStatus) debugStatus.textContent = this.checked
        ? '调试模式已开启，下次对话将使用模拟参数，不会产生API费用' : '';
      saveSettings();
    };
  }
  if (debugHitEl) {
    debugHitEl.onchange = function () {
      state.settings.debugHit = parseInt(this.value, 10) || 0;
      saveSettings();
    };
  }
  if (debugMissEl) {
    debugMissEl.onchange = function () {
      state.settings.debugMiss = parseInt(this.value, 10) || 0;
      saveSettings();
    };
  }
  if (debugOutEl) {
    debugOutEl.onchange = function () {
      state.settings.debugOutput = parseInt(this.value, 10) || 0;
      saveSettings();
    };
  }
  if (debugMdlEl) {
    debugMdlEl.onchange = function () {
      state.settings.debugModel = this.value;
      saveSettings();
    };
  }

  // ── Save selector ─────────────────────────────────────────────────────────
  var saveSelect = el('ds-save-select');
  if (saveSelect) {
    saveSelect.onchange = function (e) {
      state.currentSave = e.target.value;
      saveCurrentSaveKey();
      refreshUI();
    };
  }

  // ── Header settings gear dropdown ─────────────────────────────────────────
  var settingsBtn = el('ds-header-settings-btn');
  var settingsDrop = el('ds-settings-dropdown');
  if (settingsBtn && settingsDrop) {
    settingsBtn.onclick = function (e) {
      e.stopPropagation();
      var isOpen = settingsDrop.style.display === 'block';
      settingsDrop.style.display = isOpen ? 'none' : 'block';
    };
  }

  // Show help modal from settings dropdown
  var btnShowHelp = el('ds-btn-show-help');
  var helpModal = el('ds-help-modal');
  if (btnShowHelp && helpModal) {
    btnShowHelp.onclick = function (e) {
      e.stopPropagation();
      if (settingsDrop) settingsDrop.style.display = 'none';
      helpModal.style.display = 'flex';
    };
  }

  // Close help modal
  var btnCloseHelp = el('ds-help-modal-close');
  if (btnCloseHelp && helpModal) {
    btnCloseHelp.onclick = function (e) {
      e.stopPropagation();
      helpModal.style.display = 'none';
    };
  }

  // Close dropdown on click outside
  doc.addEventListener('click', function (e) {
    var drop = el('ds-settings-dropdown');
    var btn = el('ds-header-settings-btn');
    if (drop && btn && !drop.contains(e.target) && !btn.contains(e.target)) {
      drop.style.display = 'none';
    }
  });

  // Display mode change binding
  var displayModeRadios = doc.querySelectorAll('input[name="ds-display-mode"]');
  displayModeRadios.forEach(function (radio) {
    if (radio.value === state.settings.displayMode) {
      radio.checked = true;
    }
    radio.onchange = function () {
      state.settings.displayMode = this.value;
      saveSettings();
      applyDisplayMode();
    };
  });

  // Call theme and mode initialization
  applyDisplayMode();
  updateDynamicThemeColors();
  applyModuleOrder();
  applyModuleVisibility();
  applyStatsVisibility();
  renderModuleOrderSettings(doc);
  renderStatsCustomizerSettings(doc);

  // Bind click handlers for prompt diff buttons via event delegation on ds-panel
  var panel = doc.getElementById('ds-panel');
  if (panel) {
    panel.addEventListener('click', function (e) {
      var beforeBtn = e.target.closest('.ds-diff-before-btn');
      var afterBtn = e.target.closest('.ds-diff-after-btn');
      var fullscreenBtn = e.target.closest('#ds-btn-diff-fullscreen');

      if (beforeBtn) {
        var timestamp = parseInt(beforeBtn.getAttribute('data-timestamp'), 10);
        if (selectedBeforeId === timestamp) {
          selectedBeforeId = null; // Toggle off
        } else {
          selectedBeforeId = timestamp;
        }
        refreshUI();
      }

      if (afterBtn) {
        var timestamp = parseInt(afterBtn.getAttribute('data-timestamp'), 10);
        if (selectedAfterId === timestamp) {
          selectedAfterId = null; // Toggle off
        } else {
          selectedAfterId = timestamp;
        }
        refreshUI();
      }

      if (fullscreenBtn) {
        var diffModule = doc.getElementById('ds-module-diff');
        if (diffModule) {
          var isFS = diffModule.classList.toggle('ds-diff-fullscreen');
          fullscreenBtn.innerHTML = isFS ? '<i class="fa-solid fa-compress"></i>' : '<i class="fa-solid fa-expand"></i>';
        }
      }

      var toggleBtn = e.target.closest('#ds-history-toggle');
      if (toggleBtn) {
        var histEl = doc.getElementById('ds-history');
        if (histEl) {
          var isExpanded = histEl.getAttribute('data-expanded') === 'true';
          var nextExpanded = !isExpanded;
          histEl.setAttribute('data-expanded', nextExpanded ? 'true' : 'false');
          if (nextExpanded) {
            histEl.classList.remove('ds-folded');
            toggleBtn.textContent = '收起历史记录';
          } else {
            histEl.classList.add('ds-folded');
            toggleBtn.textContent = '展开更多 (最多显示20条)...';
          }
        }
      }
    });
  }

  refreshSaveSelect();
  refreshUI();
}

// ─── Save selector refresh ────────────────────────────────────────────────────
function refreshSaveSelect() {
  var doc    = (window.parent || window).document;
  var select = doc.getElementById('ds-save-select');
  if (!select) return;

  var html = '<option value="__all__"' +
    (state.currentSave === '__all__' ? ' selected' : '') +
    '>全部存档 (合并统计)</option>';

  Object.keys(state.saves)
    .sort(function (a, b) {
      return (state.saves[b].startTime || 0) - (state.saves[a].startTime || 0);
    })
    .forEach(function (k) {
      var s = state.saves[k];
      html += '<option value="' + k + '"' +
        (k === state.currentSave ? ' selected' : '') + '>' +
        s.name + ' (' + (s.rounds || 0) + '轮)</option>';
    });

  select.innerHTML = html;
}

// ─── Panel toggle ─────────────────────────────────────────────────────────────
var _ds_last_toggle = 0;
function togglePanel() {
  if (!isInitDone) return;
  // Bug fix #12: use a shorter guard (500ms) — 3s was too conservative and
  // prevented opening the panel shortly after page load
  if (Date.now() - initTimestamp < 500) return;
  if (Date.now() - _ds_last_toggle < 300) return;
  _ds_last_toggle = Date.now();

  var p   = window.parent || window;
  var ov  = p.document.getElementById('ds-overlay');
  var pn  = p.document.getElementById('ds-panel');
  if (!ov || !pn) { createUI(); return; }

  if (state.panelOpen) {
    ov.style.display = 'none';
    pn.classList.remove('ds-open');
    state.panelOpen = false;
  } else {
    syncViewportHeight();
    updateDynamicThemeColors();
    ov.style.display = 'block';
    pn.classList.add('ds-open');
    state.panelOpen = true;
    refreshUI();
  }
}

// ─── UI refresh ───────────────────────────────────────────────────────────────
function refreshUI() {
  var doc = (window.parent || window).document;
  function el(id) { return doc.getElementById(id); }

  refreshSaveSelect();

  // Bug fix #1 / display: use the display-safe accessor
  var s = getSelectedSaveForDisplay();
  if (!s) return;

  // Header timing
  if (el('ds-save-time')) {
    el('ds-save-time').textContent = state.currentSave === '__all__'
      ? '' : '开始于 ' + formatStartTime(s.startTime);
  }

  // Overview stats
  if (el('ds-total-tokens')) el('ds-total-tokens').textContent = formatTokens(s.total_tokens || 0);
  if (el('ds-total-cost'))   el('ds-total-cost').textContent   = '¥' + (s.total_cost || 0).toFixed(4);
  if (el('ds-rounds'))       el('ds-rounds').textContent       = '基于 ' + (s.rounds || 0) + ' 轮';

  // Weighted cache hit rate over full history
  var tp = 0, th = 0;
  (s.history || []).forEach(function (item) {
    tp += item.prompt_tokens    || 0;
    th += item.cache_hit_tokens || 0;
  });
  if (el('ds-weighted-rate')) {
    el('ds-weighted-rate').textContent = (tp > 0 ? (th / tp * 100) : 0).toFixed(1) + '%';
  }

  // Per-round averages
  if ((s.rounds || 0) > 0) {
    if (el('ds-avg-tokens')) el('ds-avg-tokens').textContent = formatTokens((s.total_tokens || 0) / s.rounds);
    if (el('ds-avg-cost'))   el('ds-avg-cost').textContent   = '¥' + ((s.total_cost   || 0) / s.rounds).toFixed(4);
  }

  // Savings estimate (cache hit tokens billed at ~2% of miss price for deepseek-v4-flash)
  var sv = (s.cache_hit_tokens || 0) * 0.98 / 1e6;
  if (el('ds-savings'))        el('ds-savings').textContent        = '¥' + sv.toFixed(4);
  if (el('ds-savings-tokens')) el('ds-savings-tokens').textContent = formatTokens(s.cache_hit_tokens || 0);

  // Input / output cost breakdown
  if (el('ds-input-cost'))    el('ds-input-cost').textContent    = '¥' + (s.input_cost    || 0).toFixed(4);
  if (el('ds-input-tokens'))  el('ds-input-tokens').textContent  = formatTokens(s.input_tokens || 0);
  if (el('ds-output-cost'))   el('ds-output-cost').textContent   = '¥' + (s.output_cost   || 0).toFixed(4);
  if (el('ds-output-tokens')) el('ds-output-tokens').textContent = formatTokens(s.output_tokens || 0);

  // New 6 cards calculations
  var roundsCount = s.rounds || 0;
  var totalTokens = s.total_tokens || 0;
  var hitTokens = s.cache_hit_tokens || 0;
  var missTokens = s.cache_miss_tokens || 0;
  var inputTokens = s.input_tokens || 0;
  var outputTokens = s.output_tokens || 0;

  var avgTotalTokens = roundsCount > 0 ? Math.round(totalTokens / roundsCount) : 0;
  var avgInputTokens = roundsCount > 0 ? Math.round(inputTokens / roundsCount) : 0;
  var avgOutputTokens = roundsCount > 0 ? Math.round(outputTokens / roundsCount) : 0;

  var hitRatePct = inputTokens > 0 ? (hitTokens / inputTokens * 100).toFixed(1) : '0.0';
  var missRatePct = inputTokens > 0 ? (missTokens / inputTokens * 100).toFixed(1) : '0.0';

  // Find max cost in history
  var maxCost = 0;
  var maxCostModel = '暂无数据';
  if (s.history && s.history.length > 0) {
    s.history.forEach(function (item) {
      var c = item.cost || 0;
      if (c > maxCost) {
        maxCost = c;
        maxCostModel = item.model || '未知模型';
      }
    });
  }

  // Set text content for new cards
  if (el('ds-stat-total-tokens')) el('ds-stat-total-tokens').textContent = formatTokens(totalTokens);
  if (el('ds-stat-total-tokens-sub')) el('ds-stat-total-tokens-sub').textContent = '单轮平均 ' + formatTokens(avgTotalTokens);

  if (el('ds-stat-hit-tokens')) el('ds-stat-hit-tokens').textContent = formatTokens(hitTokens);
  if (el('ds-stat-hit-tokens-sub')) el('ds-stat-hit-tokens-sub').textContent = '占输入 ' + hitRatePct + '%';

  if (el('ds-stat-miss-tokens')) el('ds-stat-miss-tokens').textContent = formatTokens(missTokens);
  if (el('ds-stat-miss-tokens-sub')) el('ds-stat-miss-tokens-sub').textContent = '占输入 ' + missRatePct + '%';

  if (el('ds-stat-rounds-count')) el('ds-stat-rounds-count').textContent = roundsCount;
  if (el('ds-stat-rounds-count-sub')) el('ds-stat-rounds-count-sub').textContent = '轮对话';

  if (el('ds-stat-max-turn-cost')) el('ds-stat-max-turn-cost').textContent = '¥' + maxCost.toFixed(4);
  if (el('ds-stat-max-turn-cost-sub')) el('ds-stat-max-turn-cost-sub').textContent = maxCostModel;

  if (el('ds-stat-avg-turn-tokens')) el('ds-stat-avg-turn-tokens').textContent = formatTokens(avgTotalTokens);
  if (el('ds-stat-avg-turn-tokens-sub')) el('ds-stat-avg-turn-tokens-sub').textContent = '输 ' + formatTokens(avgInputTokens) + ' · 出 ' + formatTokens(avgOutputTokens);

  // Latest hit rate
  var latestHitRateVal = '-';
  var latestHitRateSub = '暂无数据';
  if (s.history && s.history.length > 0) {
    var lastRound = s.history[0];
    latestHitRateVal = lastRound.prompt_tokens > 0 
      ? (lastRound.cache_hit_tokens / lastRound.prompt_tokens * 100).toFixed(1) + '%' 
      : '0.0%';
    latestHitRateSub = lastRound.model || '未知模型';
  }

  // Hit / Miss ratio
  var hitMissRatioVal = formatTokens(hitTokens) + ' / ' + formatTokens(missTokens);
  var hitMissRatioSub = '输出 ' + formatTokens(outputTokens);

  // Average Input Tokens
  var avgHit = roundsCount > 0 ? Math.round(hitTokens / roundsCount) : 0;
  var avgMiss = roundsCount > 0 ? Math.round(missTokens / roundsCount) : 0;
  var avgInputTokensVal = avgInputTokens;
  var avgInputTokensSub = '命中 ' + formatTokens(avgHit) + ' · 未命中 ' + formatTokens(avgMiss);

  // Average Output Tokens
  var avgOutputTokensVal = avgOutputTokens;
  var avgOutputPct = avgTotalTokens > 0 ? (avgOutputTokens / avgTotalTokens * 100).toFixed(1) : '0.0';
  var avgOutputTokensSub = '占总数 ' + avgOutputPct + '%';

  // Savings rate
  var totalPotentialCost = (s.total_cost || 0) + sv;
  var savingsRateVal = totalPotentialCost > 0 ? (sv / totalPotentialCost * 100).toFixed(1) + '%' : '0.0%';
  var savingsRateSub = '节省 ¥' + sv.toFixed(4);

  // Min turn cost, max/min turn tokens
  var minCost = 999999;
  var minCostModel = '暂无数据';
  var maxTurnTok = 0;
  var maxTurnTokInput = 0;
  var maxTurnTokOutput = 0;
  var minTurnTok = 999999;
  var minTurnTokInput = 0;
  var minTurnTokOutput = 0;

  if (s.history && s.history.length > 0) {
    s.history.forEach(function (item) {
      var c = item.cost || 0;
      if (c < minCost) {
        minCost = c;
        minCostModel = item.model || '未知模型';
      }
      var t = item.total_tokens || 0;
      if (t > maxTurnTok) {
        maxTurnTok = t;
        maxTurnTokInput = item.prompt_tokens || 0;
        maxTurnTokOutput = item.completion_tokens || 0;
      }
      if (t < minTurnTok) {
        minTurnTok = t;
        minTurnTokInput = item.prompt_tokens || 0;
        minTurnTokOutput = item.completion_tokens || 0;
      }
    });
  }
  if (minCost === 999999) minCost = 0;
  if (minTurnTok === 999999) minTurnTok = 0;

  var minCostVal = '¥' + minCost.toFixed(4);
  var minCostSub = minCostModel;

  var maxTurnTokVal = maxTurnTok;
  var maxTurnTokSub = '输 ' + formatTokens(maxTurnTokInput) + ' · 出 ' + formatTokens(maxTurnTokOutput);

  var minTurnTokVal = minTurnTok;
  var minTurnTokSub = '输 ' + formatTokens(minTurnTokInput) + ' · 出 ' + formatTokens(minTurnTokOutput);

  // Set text content for new cards
  if (el('ds-stat-latest-hit-rate')) el('ds-stat-latest-hit-rate').textContent = latestHitRateVal;
  if (el('ds-stat-latest-hit-rate-sub')) el('ds-stat-latest-hit-rate-sub').textContent = latestHitRateSub;

  if (el('ds-stat-hit-miss-ratio')) el('ds-stat-hit-miss-ratio').textContent = hitMissRatioVal;
  if (el('ds-stat-hit-miss-ratio-sub')) el('ds-stat-hit-miss-ratio-sub').textContent = hitMissRatioSub;

  // Update visual hit-miss ratio bar
  var totalInput = hitTokens + missTokens;
  var hitPct = totalInput > 0 ? (hitTokens / totalInput * 100) : 0;
  var missPct = totalInput > 0 ? (missTokens / totalInput * 100) : 0;
  var hitBarEl = el('ds-hit-miss-bar-hit');
  var missBarEl = el('ds-hit-miss-bar-miss');
  var hitLblEl = el('ds-hit-miss-lbl-hit');
  var missLblEl = el('ds-hit-miss-lbl-miss');
  if (hitBarEl) hitBarEl.style.width = hitPct.toFixed(1) + '%';
  if (missBarEl) missBarEl.style.width = (totalInput > 0 ? (100 - hitPct) : 0).toFixed(1) + '%';
  if (hitLblEl) hitLblEl.textContent = '命中: ' + hitPct.toFixed(1) + '%';
  if (missLblEl) missLblEl.textContent = '未命中: ' + missPct.toFixed(1) + '%';

  if (el('ds-stat-avg-input-tokens')) el('ds-stat-avg-input-tokens').textContent = formatTokens(avgInputTokensVal);
  if (el('ds-stat-avg-input-tokens-sub')) el('ds-stat-avg-input-tokens-sub').textContent = avgInputTokensSub;

  if (el('ds-stat-avg-output-tokens')) el('ds-stat-avg-output-tokens').textContent = formatTokens(avgOutputTokensVal);
  if (el('ds-stat-avg-output-tokens-sub')) el('ds-stat-avg-output-tokens-sub').textContent = avgOutputTokensSub;

  if (el('ds-stat-savings-rate')) el('ds-stat-savings-rate').textContent = savingsRateVal;
  if (el('ds-stat-savings-rate-sub')) el('ds-stat-savings-rate-sub').textContent = savingsRateSub;

  if (el('ds-stat-min-turn-cost')) el('ds-stat-min-turn-cost').textContent = minCostVal;
  if (el('ds-stat-min-turn-cost-sub')) el('ds-stat-min-turn-cost-sub').textContent = minCostSub;

  if (el('ds-stat-max-turn-tokens')) el('ds-stat-max-turn-tokens').textContent = formatTokens(maxTurnTokVal);
  if (el('ds-stat-max-turn-tokens-sub')) el('ds-stat-max-turn-tokens-sub').textContent = maxTurnTokSub;

  if (el('ds-stat-min-turn-tokens')) el('ds-stat-min-turn-tokens').textContent = formatTokens(minTurnTokVal);
  if (el('ds-stat-min-turn-tokens-sub')) el('ds-stat-min-turn-tokens-sub').textContent = minTurnTokSub;

  // Balance display
  var beEl = el('ds-balance');
  if (beEl) {
    if (state.customBalance !== null && state.customBalance !== '') {
      beEl.textContent = '¥' + parseFloat(state.customBalance).toFixed(2) + ' CNY';
    } else if (state.balance && state.balance.balance != null) {
      beEl.textContent = '¥' + parseFloat(state.balance.balance).toFixed(2) + ' ' + state.balance.currency;
    } else {
      beEl.textContent = '¥0.00 CNY';
    }
  }

  // Remaining rounds estimate
  var remEl = el('ds-balance-remaining');
  if (remEl) {
    var r = calculateRemainingRounds(s);
    remEl.textContent = r !== null ? '预计还可进行 ' + r + ' 轮对话' : '';
  }

  // ── Latest entry ──────────────────────────────────────────────────────────
  var latestEl = el('ds-latest');
  if (s.history && s.history.length > 0 && latestEl) {
    var u  = s.history[0];
    var hr = u.prompt_tokens > 0 ? (u.cache_hit_tokens / u.prompt_tokens * 100).toFixed(1) : '0.0';
    latestEl.innerHTML = buildEntryHTML(u, hr, true);
  } else if (latestEl) {
    latestEl.innerHTML = '<div class="ds-wait-text">等待第一次对话...</div>';
  }

  // ── History list ──────────────────────────────────────────────────────────
  var histEl = el('ds-history');
  if (s.history && s.history.length > 1 && histEl) {
    // Check if it was previously expanded
    var isExpanded = histEl.getAttribute('data-expanded') === 'true';
    histEl.setAttribute('data-expanded', isExpanded ? 'true' : 'false');
    if (isExpanded) {
      histEl.classList.remove('ds-folded');
    } else {
      histEl.classList.add('ds-folded');
    }

    // Only render the most recent 20 items in the DOM
    var itemsHTML = s.history.slice(1, 21).map(function (item, idx) {
      var t  = new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      var hr = item.prompt_tokens > 0 ? (item.cache_hit_tokens / item.prompt_tokens * 100) : 0;
      
      // Default hide items from index 3 onwards (the 4th item or later)
      var extraClass = idx >= 3 ? ' ds-history-collapsed' : '';
      return buildHistoryEntryHTML(item, idx, s.history.length, t, hr, extraClass);
    }).join('');

    // If there are more than 3 items, append a toggle button
    if (s.history.length > 4) {
      var toggleText = isExpanded ? '收起历史记录' : '展开更多 (最多显示20条)...';
      itemsHTML += '<div id="ds-history-toggle" style="text-align: center; padding: 8px; cursor: pointer; color: var(--SmartThemeUnderlineColor, #818cf8); font-size: 12px; font-weight: 500; text-decoration: underline;">' + toggleText + '</div>';
    }

    histEl.innerHTML = itemsHTML;
  } else if (histEl) {
    histEl.innerHTML = '<div class="ds-wait-text">暂无历史记录</div>';
  }

  // ── Diff display ──────────────────────────────────────────────────────────
  var diffEl = el('ds-diff');
  if (diffEl) {
    if (!selectedBeforeId || !selectedAfterId) {
      diffEl.innerHTML = '<div class="ds-wait-text">请在下方历史记录中选择“旧请求”和“新请求”进行对比</div>';
    } else {
      var beforeRecord = null;
      var afterRecord = null;
      if (s.history && s.history.length > 0) {
        s.history.forEach(function (item) {
          if (item.timestamp === selectedBeforeId) beforeRecord = item;
          if (item.timestamp === selectedAfterId) afterRecord = item;
        });
      }
      if (!beforeRecord || !afterRecord) {
        diffEl.innerHTML = '<div class="ds-wait-text">所选记录的快照已过期或不存在</div>';
      } else {
        var diffResult = comparePromptRecords(beforeRecord, afterRecord, 600);
        var html = '';
        html += '<div class="ds-diff-summary ds-diff-kind-' + diffResult.kind + '" style="margin-bottom:12px;">';
        html += '<strong>对比结论: </strong>' + escapeHTML(diffResult.summary);
        html += '</div>';

        if (diffResult.context) {
          var ctx = diffResult.context;
          var formatDiffText = function (prefix, changed, suffix, hasMorePrefix, hasMoreSuffix, isDeletion) {
            var text = '';
            if (hasMorePrefix) text += '<span class="ds-diff-context-dim">…</span>';
            text += '<span class="ds-diff-context-normal">' + escapeHTML(prefix) + '</span>';
            if (changed) {
              text += '<mark class="' + (isDeletion ? 'ds-diff-del' : 'ds-diff-ins') + '">' + escapeHTML(changed) + '</mark>';
            } else {
              text += '<mark class="' + (isDeletion ? 'ds-diff-del' : 'ds-diff-ins') + '">∅</mark>';
            }
            text += '<span class="ds-diff-context-normal">' + escapeHTML(suffix) + '</span>';
            if (hasMoreSuffix) text += '<span class="ds-diff-context-dim">…</span>';
            return text;
          };

          var beforeSideText = formatDiffText(ctx.prefix, ctx.beforeChanged, ctx.suffix, ctx.hasMorePrefix, ctx.hasMoreSuffix, true);
          var afterSideText = formatDiffText(ctx.prefix, ctx.afterChanged, ctx.suffix, ctx.hasMorePrefix, ctx.hasMoreSuffix, false);

          html += '<div class="ds-diff-grid">';

          html += '<div class="ds-diff-side">';
          html += '<div class="ds-diff-side-title">旧请求 · ' + beforeRecord.prompt_tokens + ' tokens (' + diffResult.beforeLength + ' 字)</div>';
          html += '<pre class="ds-diff-pre">' + beforeSideText + '</pre>';
          html += '</div>';

          html += '<div class="ds-diff-side">';
          html += '<div class="ds-diff-side-title">新请求 · ' + afterRecord.prompt_tokens + ' tokens (' + diffResult.afterLength + ' 字)</div>';
          html += '<pre class="ds-diff-pre">' + afterSideText + '</pre>';
          html += '</div>';

          html += '</div>'; // ds-diff-grid
        } else {
          html += '<div class="ds-wait-text">没有发现有效消息内容的差异。</div>';
        }
        diffEl.innerHTML = html;
      }
    }
  }
}

// ─── HTML builders (extracted to reduce repetition) ──────────────────────────
function buildEntryHTML(u, hitRate, isLatest) {
  var time = new Date(u.timestamp).toLocaleTimeString('zh-CN');
  var hasSnapshot = u.messages && u.messages.length > 0;
  return '<div style="padding:12px;font-family:system-ui,-apple-system,sans-serif">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<span style="font-size:11px;color:var(--SmartThemeEmColor);font-weight:500">' + time + '</span>' +
        '<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:var(--SmartThemeBorderColor);color:var(--SmartThemeBodyColor);font-weight:500">' +
          escapeHTML(u.model) + '</span>' +
      '</div>' +
      '<span style="font-size:13px;color:var(--SmartThemeBodyColor);font-weight:600">¥' +
        (u.cost ? u.cost.toFixed(4) : '0.0000') + '</span>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      buildTokenCell('tokens',  'var(--SmartThemeEmColor)', '16px', u.total_tokens)     +
      buildTokenCell('输入',    'var(--SmartThemeUnderlineColor)', '13px', u.prompt_tokens)    +
      buildTokenCell('输出',    'var(--SmartThemeQuoteColor)', '13px', u.completion_tokens) +
    '</div>' +
    buildHitBar(hitRate) +
    '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<span style="font-size:10px;color:var(--SmartThemeQuoteColor);font-weight:500">' + hitRate + '% 命中</span>' +
      '<span style="font-size:10px;color:var(--SmartThemeEmColor)">¥' +
        (u.input_cost  ? u.input_cost.toFixed(4)  : '0.0000') + ' 输入 · ¥' +
        (u.output_cost ? u.output_cost.toFixed(4) : '0.0000') + ' 输出</span>' +
    '</div>' +
    (hasSnapshot ?
      '<div style="display:flex; gap:6px; margin-top:8px; justify-content: flex-end;">' +
        '<button class="ds-diff-btn ds-diff-before-btn' + (u.timestamp === selectedBeforeId ? ' active' : '') + '" data-timestamp="' + u.timestamp + '">旧</button>' +
        '<button class="ds-diff-btn ds-diff-after-btn' + (u.timestamp === selectedAfterId ? ' active' : '') + '" data-timestamp="' + u.timestamp + '">新</button>' +
      '</div>' : '') +
  '</div>';
}

function buildHistoryEntryHTML(item, idx, totalLen, timeStr, hitRate, extraClass) {
  var roundNum = totalLen - 1 - idx;
  var hasSnapshot = item.messages && item.messages.length > 0;
  var cls = 'ds-card' + (extraClass || '');
  return '<div class="' + cls + '" style="padding:12px;margin-bottom:8px;font-family:system-ui,-apple-system,sans-serif">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<span style="font-size:11px;color:var(--SmartThemeEmColor);font-weight:500">#' + roundNum + ' · ' + timeStr + '</span>' +
        '<span style="font-size:10px;padding:2px 7px;border-radius:4px;background:var(--SmartThemeBorderColor);color:var(--SmartThemeBodyColor);font-weight:500">' +
          escapeHTML(item.model) + '</span>' +
      '</div>' +
      '<span style="font-size:13px;color:var(--SmartThemeBodyColor);font-weight:600">¥' +
        (item.cost ? item.cost.toFixed(4) : '0.0000') + '</span>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
      buildTokenCell('tokens', 'var(--SmartThemeEmColor)', '16px', item.total_tokens)     +
      buildTokenCell('输入',   'var(--SmartThemeUnderlineColor)', '13px', item.prompt_tokens)    +
      buildTokenCell('输出',   'var(--SmartThemeQuoteColor)', '13px', item.completion_tokens) +
    '</div>' +
    buildHitBar(hitRate) +
    '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<span style="font-size:10px;color:var(--SmartThemeQuoteColor);font-weight:500">' + hitRate.toFixed(1) + '% 命中</span>' +
      '<span style="font-size:10px;color:var(--SmartThemeEmColor)">¥' +
        (item.input_cost  ? item.input_cost.toFixed(4)  : '0.0000') + ' 输入 · ¥' +
        (item.output_cost ? item.output_cost.toFixed(4) : '0.0000') + ' 输出</span>' +
    '</div>' +
    (hasSnapshot ?
      '<div style="display:flex; gap:6px; margin-top:8px; justify-content: flex-end;">' +
        '<button class="ds-diff-btn ds-diff-before-btn' + (item.timestamp === selectedBeforeId ? ' active' : '') + '" data-timestamp="' + item.timestamp + '">旧</button>' +
        '<button class="ds-diff-btn ds-diff-after-btn' + (item.timestamp === selectedAfterId ? ' active' : '') + '" data-timestamp="' + item.timestamp + '">新</button>' +
      '</div>' : '') +
  '</div>';
}

function buildTokenCell(label, color, fontSize, value) {
  return '<div style="text-align:center">' +
    '<div style="font-size:10px;color:' + color + ';margin-bottom:2px">' + label + '</div>' +
    '<div style="font-size:' + fontSize + ';font-weight:700;color:' + color + '">' +
      String(value || 0) + '</div>' +
  '</div>';
}

function buildHitBar(pct) {
  var width = Math.min(100, Math.max(0, parseFloat(pct) || 0));
  return '<div style="background:rgba(0,0,0,0.15);border-radius:4px;height:4px;overflow:hidden;margin-bottom:4px">' +
    '<div style="background:linear-gradient(90deg, var(--SmartThemeQuoteColor), var(--SmartThemeUnderlineColor));width:' + width +
      '%;height:100%;border-radius:4px;transition:width 0.3s"></div>' +
  '</div>';
}

function formatTokens(val) {
  var num = parseFloat(val) || 0;
  return (num / 10000).toFixed(1) + '万';
}

// Prevent XSS when model names are interpolated into innerHTML
function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Extension entry-point ────────────────────────────────────────────────────
export function init() {
  loadSavedData();
  loadCurrentSave();
  setupEvents();
  createUI();
  patchFetch();
  state.panelOpen = false;
  initTimestamp   = Date.now();
  isInitDone      = true;
  syncViewportHeight();

  applyDisplayMode();
  setInterval(ensureWalletButton, 1000);

  // Viewport height sync
  try {
    var p = window.parent || window;
    if (p.visualViewport) {
      p.visualViewport.addEventListener('resize', syncViewportHeight, { passive: true });
      p.visualViewport.addEventListener('scroll', syncViewportHeight, { passive: true });
    }
    p.addEventListener('resize', syncViewportHeight, { passive: true });
  } catch (e) {}

  // Responsive layout class guard (suppress animation on breakpoint switch)
  try {
    var pw  = window.parent || window;
    var vw  = (pw.innerWidth || 768) > 760 ? 'desktop' : 'mobile';
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

  // Register entry in SillyTavern Extensions menu
  try {
    var wp   = window.parent || window;
    var wdoc = wp.document;
    var menu = wdoc.getElementById('extensionsMenu');
    if (menu && !wdoc.getElementById('ds_wand_container')) {
      var container = wdoc.createElement('div');
      container.id        = 'ds_wand_container';
      container.className = 'extension_container';
      container.innerHTML =
        '<div id="ds_wand_entry" class="list-group-item flex-container flexGap5">' +
          '<div class="fa-solid fa-chart-bar extensionsMenuExtensionButton"></div>' +
          'DeepSeek使用预测' +
        '</div>';
      menu.appendChild(container);
      var wandBtn = wdoc.getElementById('ds_wand_entry');
      if (wandBtn) wandBtn.addEventListener('click', togglePanel);
    }
  } catch (e) {}
}

// ─── Public API ───────────────────────────────────────────────────────────────
window.DeepSeekStats = {
  state:        state,
  togglePanel:  togglePanel,
  refreshUI:    refreshUI,
  queryBalance: queryBalance,
};
