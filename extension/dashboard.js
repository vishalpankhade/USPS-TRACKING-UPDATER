const $ = id => document.getElementById(id);
let allResults = [];
let filter = 'all';
let formatFilter = 'all';
let searchTerm = '';
let sheetsConfig = { bridgeUrl: '', sheetUrl: '', sheetName: '', trackingColumn: '', secret: '', autoSync: true };
let sheetWorkflowActive = false;
let syncInFlight = false;
let syncedSignatures = new Map();
let activeJobPaused = false;

const labels = {
  all: 'All',
  pending: 'Not delivered',
  delivered: 'Delivered',
  alert: 'Alerts',
  awaiting: 'Awaiting USPS',
  not_available: 'Tracking not available',
  not_loaded: 'Not loaded',
  error: 'Needs review'
};

function isTrackingLike(value) {
  const n = String(value || '').toUpperCase();
  // USPS domestic / IMpb-style numeric package identifiers can be up to 34 digits.
  if (/^\d{20,34}$/.test(n)) return true;
  // Common USPS international format, e.g. RR123456789US.
  if (/^[A-Z]{2}\d{9}[A-Z]{2}$/.test(n)) return true;
  return false;
}

function cleanCandidate(value) {
  return String(value || '')
    .trim()
    .replace(/[“”‘’]/g, '"')
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/[\s-]+/g, '')
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase();
}

function normalize(raw) {
  const items = Array.isArray(raw) ? raw : String(raw || '').split(/\r?\n/);
  const out = [];
  const seen = new Set();

  for (const item of items) {
    // A sheet cell normally contains one number. Pasted multi-column/CSV text may have tabs,
    // commas or semicolons between values, so split those without breaking space-separated barcodes.
    const parts = String(item || '').split(/[,\t;]+/).filter(Boolean);
    for (const part of parts) {
      const candidate = cleanCandidate(part);
      if (isTrackingLike(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        out.push(candidate);
      }
    }
  }

  return out;
}

function formatForTracking(tracking) {
  const n = String(tracking || '').replace(/\D/g, '');
  if (/^\d+$/.test(String(tracking || '')) && n.length >= 22 && n.length <= 34) return 'impb';
  if (isTrackingLike(tracking)) return 'standard';
  return 'other';
}

function formatLabel(format) {
  if (format === 'impb') return 'IMpb / Long';
  if (format === 'standard') return 'Standard / International';
  return 'Other';
}

function countInput() {
  $('countLabel').textContent = `${normalize($('trackingInput').value).length.toLocaleString()} tracking numbers`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function categoryText(c) { return labels[c] || 'Needs review'; }

function updateProgress(job) {
  if (!job) return;
  $('progressPanel').classList.remove('hidden');
  $('progressTitle').textContent = job.message || 'Processing';
  $('progressCount').textContent = `${job.completed || 0} / ${job.total || 0}`;
  $('progressBar').style.width = `${job.total ? Math.round((job.completed || 0) / job.total * 100) : 0}%`;
  $('progressMessage').textContent = job.detail || '';
  renderFailedBatches(job.failedBatches || []);
  activeJobPaused = !!job.paused;
  $('stopBtn').disabled = !!job.done;
  $('stopBtn').textContent = job.paused ? 'Resume' : 'Stop';
  $('startBtn').disabled = !job.done;
  $('sheetCheckBtn').disabled = !job.done;
}

function makeFilters(counts) {
  const wrap = $('filters');
  wrap.innerHTML = '';
  Object.keys(labels).forEach(c => {
    if (c === 'all' || counts[c] > 0) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'filter' + (filter === c ? ' active' : '');
      b.textContent = `${labels[c]} ${counts[c] || 0}`;
      b.onclick = () => { filter = c; render(); };
      wrap.appendChild(b);
    }
  });
}

function makeFormatFilters() {
  const wrap = $('formatFilters');
  if (!wrap) return;
  const total = allResults.length;
  const impb = allResults.filter(r => formatForTracking(r.tracking) === 'impb').length;
  const standard = allResults.filter(r => formatForTracking(r.tracking) === 'standard').length;
  const items = [
    ['all', `All formats ${total}`],
    ['standard', `Standard / Intl ${standard}`],
    ['impb', `IMpb / Long ${impb}`]
  ];
  wrap.innerHTML = '';
  items.forEach(([value, text]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'format-filter' + (formatFilter === value ? ' active' : '');
    b.textContent = text;
    b.onclick = () => { formatFilter = value; render(); };
    wrap.appendChild(b);
  });
}

function categoryCounts() {
  const counts = { all: allResults.length, pending: 0, delivered: 0, alert: 0, awaiting: 0, not_available: 0, not_loaded: 0, error: 0 };
  allResults.forEach(r => counts[r.category] = (counts[r.category] || 0) + 1);
  return counts;
}

function getUrl(tracking) {
  return `https://tools.usps.com/tracking/${tracking}`;
}

function shortStatus(r) {
  if (r.shortStatus) return r.shortStatus;
  if (r.category === 'delivered') return 'Delivered';
  if (r.category === 'alert') return 'Alert';
  if (r.category === 'awaiting') return 'Awaiting USPS';
  if (r.category === 'not_available') return 'Tracking Not Available';
  if (r.category === 'not_loaded') return 'Not Loaded';
  if (r.category === 'pending') return 'Not Delivered';
  return 'Needs Review';
}

function filteredResults() {
  let shown = filter === 'all' ? allResults : allResults.filter(r => r.category === filter);
  if (formatFilter !== 'all') shown = shown.filter(r => formatForTracking(r.tracking) === formatFilter);
  const q = searchTerm.trim().toUpperCase();
  if (q) shown = shown.filter(r => `${r.tracking} ${r.status || ''} ${shortStatus(r)} ${formatLabel(formatForTracking(r.tracking))}`.toUpperCase().includes(q));
  return shown;
}

function renderSummary(counts) {
  const cards = [
    ['allCount', 'all'], ['pendingCount', 'pending'], ['deliveredCount', 'delivered'], ['alertCount', 'alert'],
    ['awaitingCount', 'awaiting'], ['unavailableCount', 'not_available'], ['notLoadedCount', 'not_loaded'], ['reviewCount', 'error']
  ];
  cards.forEach(([id, c]) => $(id).textContent = counts[c] || 0);
  document.querySelectorAll('.summary-card').forEach(card => card.classList.toggle('active', card.dataset.filter === filter));
}

function renderFailedBatches(batches) {
  const panel = $('failedBatchesPanel');
  const wrap = $('failedBatchesList');
  const count = $('failedBatchCount');
  if (!panel || !wrap || !count) return;
  count.textContent = batches.length.toLocaleString();
  panel.classList.toggle('hidden', batches.length === 0);
  wrap.innerHTML = '';
  batches.forEach((b, idx) => {
    const row = document.createElement('div');
    row.className = 'failed-batch';
    const tracks = b.trackingNumbers || [];
    row.innerHTML = `
      <div class="failed-batch-main">
        <strong>Batch ${esc(b.batchNo || idx + 1)} · ${tracks.length} tracking number(s)</strong>
        <div class="muted failed-error">${esc(b.error || 'USPS page did not load.')}</div>
        <details><summary>Show tracking numbers</summary><div class="failed-trackings">${esc(tracks.join(', '))}</div></details>
      </div>
      <button class="small warning-outline retryFailedOne" type="button">Retry batch</button>`;
    row.querySelector('.retryFailedOne').onclick = async () => {
      $('startBtn').disabled = true;
      $('stopBtn').disabled = false;
      await chrome.runtime.sendMessage({ type: 'retryFailedBatches', batches: [b] });
      toast(`Retrying batch ${b.batchNo || idx + 1}…`);
    };
    wrap.appendChild(row);
  });
}

async function retryAllFailedBatches() {
  const stored = await chrome.storage.local.get('job');
  const batches = stored.job?.failedBatches || [];
  if (!batches.length) { toast('There are no not-loaded batches to retry.'); return; }
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;
  await chrome.runtime.sendMessage({ type: 'retryFailedBatches', batches });
  toast(`Retrying ${batches.length.toLocaleString()} not-loaded batch(es)…`);
}

function render() {
  const counts = categoryCounts();
  renderSummary(counts);
  makeFilters(counts);
  makeFormatFilters();
  $('retryReviewBtn').classList.toggle('hidden', counts.error === 0);
  $('recheckActiveBtn').classList.toggle('hidden', counts.all === 0 || counts.all === counts.delivered);
  if (counts.error > 0) $('retryReviewBtn').textContent = `Retry Needs Review (${counts.error})`;
  $('recheckActiveBtn').textContent = `Recheck non-delivered (${Math.max(0, counts.all - counts.delivered)})`;

  const shown = filteredResults();
  $('shownCount').textContent = `${shown.length.toLocaleString()} shown`;
  const wrap = $('results');
  wrap.innerHTML = '';

  if (!shown.length) {
    wrap.innerHTML = `<div class="panel empty-state">${allResults.length ? 'Nothing matches this filter/search.' : 'Results will appear here after you run a check.'}</div>`;
    return;
  }

  shown.forEach(r => {
    const el = document.createElement('article');
    el.className = 'result';
    const url = getUrl(r.tracking);
    const fmt = formatForTracking(r.tracking);
    el.innerHTML = `
      <div class="result-top">
        <div class="tracking">${esc(r.tracking)}</div>
        <div class="result-badges"><span class="format-badge ${fmt}">${esc(formatLabel(fmt))}</span><span class="badge ${esc(r.category)}">${esc(categoryText(r.category))}</span></div>
      </div>
      <div class="short-status"><strong>${esc(shortStatus(r))}</strong></div>
      <div class="status">${esc(r.status || 'No readable USPS status was detected.')}</div>
      <div class="actions">
        <button class="small copyOne" type="button">Copy row</button>
        <button class="small openOne" type="button">Open on USPS</button>
        ${r.category === 'error' || r.category === 'not_loaded' ? '<button class="small retryOne" type="button">Retry</button>' : ''}
      </div>`;

    el.querySelector('.copyOne').onclick = () => copyText(sheetRow(r));
    el.querySelector('.openOne').onclick = () => chrome.tabs.create({ url });
    const retry = el.querySelector('.retryOne');
    if (retry) retry.onclick = () => retryOne(r.tracking);
    wrap.appendChild(el);
  });
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
  toast('Copied to clipboard.');
}

function sheetRow(r) {
  return `${r.tracking}\t${shortStatus(r)}\t${getUrl(r.tracking)}`;
}

async function copyRows(results, label) {
  if (!results.length) {
    toast(`There are no ${label.toLowerCase()} results to copy.`);
    return;
  }
  await copyText(results.map(sheetRow).join('\n'));
  toast(`${results.length.toLocaleString()} ${label.toLowerCase()} row(s) copied. Paste directly into Google Sheets.`);
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

function retryOne(tracking) {
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;
  chrome.runtime.sendMessage({ type: 'retry', trackingNumbers: [tracking], trackBatchFailures: true });
  toast(`Retrying ${tracking}…`);
}

async function recheckActive() {
  const nums = allResults.filter(r => r.category !== 'delivered').map(r => r.tracking);
  if (!nums.length) { toast('There are no non-delivered results to recheck.'); return; }
  activeJobPaused = false;
  $('startBtn').disabled = true;
  $('sheetCheckBtn').disabled = true;
  $('stopBtn').disabled = false;
  $('stopBtn').textContent = 'Stop';
  filter = 'all';
  formatFilter = 'all';
  await chrome.runtime.sendMessage({ type: 'retry', trackingNumbers: nums, trackBatchFailures: true });
  toast(`Rechecking ${nums.length.toLocaleString()} non-delivered tracking number(s)…`);
}

async function retryReview() {
  const nums = allResults.filter(r => r.category === 'error').map(r => r.tracking);
  if (!nums.length) return;
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;
  await chrome.runtime.sendMessage({ type: 'retry', trackingNumbers: nums, trackBatchFailures: true });
  toast(`Retrying ${nums.length.toLocaleString()} Needs Review result(s)…`);
}

async function beginCheck(nums) {
  $('startBtn').disabled = true;
  $('sheetCheckBtn').disabled = true;
  $('stopBtn').disabled = false;
  allResults = [];
  syncedSignatures = new Map();
  filter = 'all';
  formatFilter = 'all';
  searchTerm = '';
  $('resultSearch').value = '';
  render();
  await chrome.storage.local.set({ job: null, results: [] });
  await chrome.runtime.sendMessage({ type: 'start', trackingNumbers: nums });
}

async function startTracking() {
  const nums = normalize($('trackingInput').value);
  if (!nums.length) {
    alert('No valid USPS tracking numbers were found. Paste the numbers one per line. Spaces, hyphens and quotation marks are supported.');
    return;
  }
  sheetWorkflowActive = false;
  await beginCheck(nums);
}

async function clearAll() {
  if (!confirm('Clear the pasted tracking numbers and results?')) return;
  sheetWorkflowActive = false;
  syncedSignatures = new Map();
  $('trackingInput').value = '';
  countInput();
  allResults = [];
  filter = 'all';
  formatFilter = 'all';
  searchTerm = '';
  $('resultSearch').value = '';
  await chrome.storage.local.set({ job: null, results: [] });
  $('progressPanel').classList.add('hidden');
  $('startBtn').disabled = false;
  $('stopBtn').disabled = true;
  render();
}

async function load() {
  const d = await chrome.storage.local.get(['results', 'job', 'sheetsConfig', 'uiTheme']);
  allResults = d.results || [];
  sheetsConfig = { ...sheetsConfig, ...(d.sheetsConfig || {}) };
  $('autoSync').checked = sheetsConfig.autoSync !== false;
  $('bridgeUrl').value = sheetsConfig.bridgeUrl || '';
  $('sheetUrl').value = sheetsConfig.sheetUrl || '';
  $('sheetName').value = sheetsConfig.sheetName || '';
  $('trackingColumn').value = sheetsConfig.trackingColumn || '';
  $('sheetSecret').value = sheetsConfig.secret || '';
  applyTheme(d.uiTheme || 'light');
  updateProgress(d.job);
  render();
  if (!d.job || d.job.done) {
    $('startBtn').disabled = false;
    $('stopBtn').disabled = true;
    $('stopBtn').textContent = 'Stop';
  }
}

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('themeBtn').textContent = dark ? '☀ Light mode' : '☾ Dark mode';
}

async function toggleTheme() {
  const current = document.documentElement.dataset.theme || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await chrome.storage.local.set({ uiTheme: next });
}

async function saveSheetsConfig() {
  sheetsConfig = {
    bridgeUrl: $('bridgeUrl').value.trim(),
    sheetUrl: $('sheetUrl').value.trim(),
    sheetName: $('sheetName').value.trim(),
    trackingColumn: $('trackingColumn').value.trim(),
    secret: $('sheetSecret').value,
    autoSync: $('autoSync').checked
  };
  await chrome.storage.local.set({ sheetsConfig });
}

function spreadsheetIdFromUrl(url) {
  const m = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : '';
}

async function postSheetRequest(payload) {
  const { bridgeUrl } = sheetsConfig;
  if (!bridgeUrl) throw new Error('Add your Google Apps Script Web App URL first.');

  let res;
  try {
    res = await fetch(bridgeUrl, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    throw new Error(`Could not reach the Apps Script Web App. Check the /exec URL and Chrome network access. ${e.message || e}`);
  }

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}

  if (!data) {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 360);
    if (res.status === 401 || res.status === 403 || /Authorization needed|accounts\.google\.com|sign in|signin/i.test(text)) {
      throw new Error(`Google blocked the /exec Web App request (HTTP ${res.status}). Click "Open Apps Script Web App" below, sign in/authorize the Web App in this Chrome profile, then try again. If your Workspace allows anonymous Web Apps, the most reliable deployment is "Anyone". Response: ${snippet}`);
    }
    throw new Error(`Apps Script returned a non-JSON response (HTTP ${res.status}). Response: ${snippet}`);
  }

  if (!res.ok) throw new Error(`Apps Script returned HTTP ${res.status}: ${data.error || 'Request failed.'}`);
  if (!data.ok) throw new Error(data.error || 'The Google Sheet bridge failed.');
  return data;
}

function sheetBasePayload() {
  const { sheetUrl, sheetName, trackingColumn, secret } = sheetsConfig;
  const spreadsheetId = spreadsheetIdFromUrl(sheetUrl);
  if (!spreadsheetId) throw new Error('Enter a valid Google Sheet URL.');
  if (!secret) throw new Error('Enter the same Bridge secret used in Apps Script.');
  return { secret, spreadsheetId, sheetName, trackingColumn };
}

async function fetchTrackingsFromSheet() {
  await saveSheetsConfig();
  const base = sheetBasePayload();
  $('sheetCheckBtn').disabled = true;
  $('sheetCheckBtn').textContent = 'Reading Google Sheet…';
  try {
    const data = await postSheetRequest({ ...base, action: 'read' });
    const nums = normalize(data.trackingNumbers || []);
    if (!nums.length) throw new Error('No valid USPS tracking numbers were found in the selected sheet/tab.');
    $('trackingInput').value = nums.join('\n');
    countInput();
    toast(`Fetched ${nums.length.toLocaleString()} tracking number(s) from Google Sheets.`);
    return nums;
  } finally {
    $('sheetCheckBtn').disabled = false;
    $('sheetCheckBtn').textContent = 'Fetch from Google Sheet & Check USPS';
  }
}

function resultSignature(r) {
  return `${shortStatus(r)}|${r.status || ''}|${getUrl(r.tracking)}`;
}

async function syncResultsToSheet(results, silent = false) {
  await saveSheetsConfig();
  const base = sheetBasePayload();
  if (!results.length) return 0;
  const payloadResults = results.map(r => ({
    tracking: r.tracking,
    status: shortStatus(r),
    message: r.status || '',
    url: getUrl(r.tracking),
    category: r.category
  }));
  const data = await postSheetRequest({ ...base, action: 'sync', results: payloadResults });
  results.forEach(r => syncedSignatures.set(r.tracking, resultSignature(r)));
  if (!silent) {
    $('syncStatus').textContent = `Synced ${data.updated.toLocaleString()} row(s).`;
    toast(`Google Sheet updated: ${data.updated.toLocaleString()} row(s).`);
    setTimeout(() => { $('syncStatus').textContent = ''; }, 5000);
  }
  return data.updated || 0;
}

async function syncChangedResultsToSheet(results) {
  if (!sheetsConfig.autoSync || !sheetWorkflowActive || syncInFlight || !results.length) return;
  const changed = results.filter(r => syncedSignatures.get(r.tracking) !== resultSignature(r));
  if (!changed.length) return;
  syncInFlight = true;
  $('syncStatus').textContent = `Auto-syncing ${changed.length.toLocaleString()} changed result(s)…`;
  try {
    await syncResultsToSheet(changed, true);
    $('syncStatus').textContent = `Auto-synced ${changed.length.toLocaleString()} result(s).`;
  } catch (e) {
    $('syncStatus').textContent = `Auto-sync failed: ${e.message}`;
    toast(`Auto-sync failed: ${e.message}`);
  } finally {
    syncInFlight = false;
  }
}

async function syncToSheet() {
  if (!allResults.length) {
    toast('There are no USPS results to sync yet.');
    return;
  }
  $('syncBtn').disabled = true;
  $('syncStatus').textContent = 'Syncing…';
  try {
    const updated = await syncResultsToSheet(allResults, false);
    $('syncStatus').textContent = `Synced ${updated.toLocaleString()} row(s).`;
  } catch (e) {
    $('syncStatus').textContent = 'Sync failed.';
    alert(`Google Sheet sync failed. ${e.message}`);
  } finally {
    $('syncBtn').disabled = false;
  }
}

async function startFromSheet() {
  try {
    await saveSheetsConfig();
    const nums = await fetchTrackingsFromSheet();
    sheetWorkflowActive = true;
    syncedSignatures = new Map();
    await beginCheck(nums);
  } catch (e) {
    sheetWorkflowActive = false;
    alert(`Could not start from Google Sheets. ${e.message}`);
  }
}

$('trackingInput').addEventListener('input', countInput);
$('startBtn').addEventListener('click', startTracking);
$('sheetCheckBtn').addEventListener('click', startFromSheet);
$('autoSync').addEventListener('change', saveSheetsConfig);
$('themeBtn').addEventListener('click', toggleTheme);
$('openBridgeBtn').addEventListener('click', () => {
  const url = $('bridgeUrl').value.trim();
  if (!url) { alert('Enter and save your Apps Script Web App URL first.'); return; }
  chrome.tabs.create({ url, active: true });
  toast('Opened the Apps Script Web App. Sign in/authorize it if Google asks, then return here and try again.');
});
$('stopBtn').addEventListener('click', async () => {
  const stored = await chrome.storage.local.get('job');
  if (stored.job?.paused) {
    $('stopBtn').disabled = true;
    $('stopBtn').textContent = 'Resuming…';
    await chrome.runtime.sendMessage({ type: 'resume' });
    toast('Resuming from the next unprocessed batch…');
  } else {
    $('stopBtn').disabled = true;
    $('stopBtn').textContent = 'Stopping…';
    await chrome.runtime.sendMessage({ type: 'stop' });
    toast('Stop requested. The current USPS batch will finish, then the job will pause.');
  }
});
$('clearBtn').addEventListener('click', clearAll);
$('copyUndelivered').addEventListener('click', () => copyRows(allResults.filter(r => r.category !== 'delivered'), 'not delivered'));
$('copyAll').addEventListener('click', () => copyRows(allResults, 'all'));
$('retryReviewBtn').addEventListener('click', retryReview);
$('recheckActiveBtn').addEventListener('click', recheckActive);
$('retryFailedBatchesBtn').addEventListener('click', retryAllFailedBatches);
$('downloadCsv').addEventListener('click', () => {
  if (!allResults.length) { toast('There are no results yet.'); return; }
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = [
    'Tracking Number,Format,Short Status,USPS Message,USPS Link',
    ...allResults.map(r => [q(r.tracking), q(formatLabel(formatForTracking(r.tracking))), q(shortStatus(r)), q(r.status || ''), q(getUrl(r.tracking))].join(','))
  ].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'usps-results.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('resultSearch').addEventListener('input', e => { searchTerm = e.target.value; render(); });
$('syncBtn').addEventListener('click', syncToSheet);
$('saveSheetBtn').addEventListener('click', async () => { await saveSheetsConfig(); toast('Google Sheet settings saved.'); });
$('openSheetBtn').addEventListener('click', () => { if (sheetsConfig.sheetUrl) chrome.tabs.create({ url: sheetsConfig.sheetUrl }); else alert('Enter and save a Google Sheet URL first.'); });

for (const card of document.querySelectorAll('.summary-card')) {
  card.addEventListener('click', () => { filter = card.dataset.filter || 'all'; render(); });
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'progress') updateProgress(msg.job);
  if (msg.type === 'results') {
    allResults = msg.results || [];
    render();
    syncChangedResultsToSheet(allResults);
  }
  if (msg.type === 'paused') {
    updateProgress(msg.job);
    $('startBtn').disabled = true;
    $('sheetCheckBtn').disabled = true;
    $('stopBtn').disabled = false;
    $('stopBtn').textContent = 'Resume';
  }
  if (msg.type === 'done') {
    updateProgress(msg.job);
    $('startBtn').disabled = false;
    $('sheetCheckBtn').disabled = false;
    $('stopBtn').disabled = true;
    $('stopBtn').textContent = 'Stop';
    if (sheetWorkflowActive && sheetsConfig.autoSync && allResults.length) {
      syncResultsToSheet(allResults, true).catch(e => { $('syncStatus').textContent = `Final sync failed: ${e.message}`; });
    }
  }
});

countInput();
load();
