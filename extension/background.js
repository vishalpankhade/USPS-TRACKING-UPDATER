const USPS_BASE = 'https://tools.usps.com/tracking/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let stopRequested = false;
// Keep the fast v2.4-style flow: a normal ~30s result window, then one automatic retry.
// A failed batch is retained separately for manual retry after the run.
const AUTO_RETRIES = 1;
let failedBatches = [];
const bridgeRequests = new Map();

function batchKey(numbers) { return numbers.join('|'); }

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'start') {
    stopRequested = false;
    run(msg.trackingNumbers || [], false, true, 0).catch(e => finishError(e));
  }
  if (msg.type === 'resume') {
    stopRequested = false;
    resumeJob().catch(e => finishError(e));
  }
  if (msg.type === 'retry') {
    stopRequested = false;
    retryResults(msg.trackingNumbers || [], !!msg.trackBatchFailures).catch(e => finishError(e));
  }
  if (msg.type === 'retryFailedBatches') {
    stopRequested = false;
    retryFailedBatches(msg.batches || []).catch(e => finishError(e));
  }
  if (msg.type === 'stop') stopRequested = true;

  if (msg.type === 'bridgeRequest') {
    requestBridgeViaTab(msg.bridgeUrl, msg.payload)
      .then(result => sendResponse({ ok: true, result }))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
});

async function save(job, results) {
  job.failedBatches = failedBatches.slice();
  await chrome.storage.local.set({ job, results });
  chrome.runtime.sendMessage({ type: 'progress', job }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'results', results }).catch(() => {});
}

function dedupe(nums) {
  const seen = new Set();
  return nums.filter(n => {
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

async function resumeJob() {
  const stored = await chrome.storage.local.get(['job', 'results']);
  const job = stored.job;
  if (!job?.paused || !Array.isArray(job.trackingNumbers) || !job.trackingNumbers.length) return;
  await run(job.trackingNumbers, true, true, Number(job.completed || 0), true);
}

async function run(input, preserveExisting, trackBatchFailures = true, startAt = 0, isResume = false) {
  const numbers = dedupe(input || []);
  const stored = await chrome.storage.local.get(['results', 'job']);
  const existing = preserveExisting ? (stored.results || []) : [];
  let results = preserveExisting ? existing.slice() : [];

  if (!preserveExisting && !isResume) {
    failedBatches = [];
  } else if (!failedBatches.length && Array.isArray(stored.job?.failedBatches)) {
    failedBatches = stored.job.failedBatches.slice();
  }

  const total = numbers.length;
  const initialCompleted = Math.min(Number(startAt) || 0, total);
  let job = {
    total,
    completed: initialCompleted,
    trackingNumbers: numbers.slice(),
    paused: false,
    done: false,
    message: isResume ? 'Resuming…' : (preserveExisting ? 'Retrying…' : 'Starting…'),
    detail: isResume
      ? `Resuming from ${initialCompleted.toLocaleString()} of ${total.toLocaleString()} tracking number(s).`
      : (preserveExisting ? `Rechecking ${total.toLocaleString()} result(s).` : '')
  };
  await save(job, results);

  for (let start = initialCompleted; start < numbers.length; start += 35) {
    if (stopRequested) {
      job.completed = start;
      job.paused = true;
      job.done = false;
      job.message = 'Paused';
      job.detail = `Paused after ${job.completed.toLocaleString()} of ${numbers.length.toLocaleString()} tracking number(s). Click Resume to continue.`;
      await save(job, results);
      chrome.runtime.sendMessage({ type: 'paused', job }).catch(() => {});
      return;
    }

    const batch = numbers.slice(start, start + 35);
    const batchNo = Math.floor(start / 35) + 1;
    let parsed;
    let lastError = null;

    for (let attempt = 0; attempt <= AUTO_RETRIES; attempt++) {
      try {
        job.message = `${isResume ? 'Resuming' : (preserveExisting ? 'Rechecking' : 'Checking')} batch ${batchNo}…`;
        job.detail = `Batch ${batchNo}: ${batch.length} tracking number(s).${attempt ? ' One automatic retry is in progress.' : ''}`;
        await save(job, results);
        parsed = await fetchBatch(batch);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (attempt < AUTO_RETRIES) {
          job.message = `Batch ${batchNo} failed — retrying…`;
          job.detail = `${e.message} The same batch will be reopened once.`;
          await save(job, results);
          await sleep(1200);
        }
      }
    }

    const key = batchKey(batch);
    if (lastError) {
      if (trackBatchFailures) {
        const failure = {
          key,
          batchNo,
          trackingNumbers: batch.slice(),
          error: lastError.message || 'USPS batch could not be read.'
        };
        const idx = failedBatches.findIndex(x => x.key === key);
        if (idx >= 0) failedBatches[idx] = failure;
        else failedBatches.push(failure);

        parsed = batch.map(tracking => ({
          tracking,
          category: 'not_loaded',
          status: `USPS page could not be loaded/read automatically. ${lastError.message}`,
          shortStatus: 'Not Loaded'
        }));
      } else {
        parsed = batch.map(tracking => ({
          tracking,
          category: 'error',
          status: `USPS page could not be read automatically. ${lastError.message}`,
          shortStatus: 'Needs Review'
        }));
      }
    } else if (trackBatchFailures) {
      const successfulSet = new Set(batch);
      failedBatches = failedBatches.filter(x => !(x.trackingNumbers || []).some(n => successfulSet.has(n)));
    }

    results = preserveExisting ? replaceByTracking(results, parsed) : results.concat(parsed);

    job.completed = Math.min(start + batch.length, numbers.length);
    job.message = lastError ? `Batch ${batchNo} not loaded` : `${isResume ? 'Resumed' : (preserveExisting ? 'Rechecked' : 'Completed')} batch ${batchNo}`;
    job.detail = lastError
      ? `The batch failed after the automatic retry. It was moved to Not Loaded so you can retry it later.`
      : `Received ${parsed.filter(x => x.category !== 'error').length.toLocaleString()} readable USPS result(s).`;
    await save(job, results);

    if (stopRequested) {
      job.paused = true;
      job.done = false;
      job.message = 'Paused';
      job.detail = `Paused after ${job.completed.toLocaleString()} of ${numbers.length.toLocaleString()} tracking number(s). Click Resume to continue.`;
      await save(job, results);
      chrome.runtime.sendMessage({ type: 'paused', job }).catch(() => {});
      return;
    }

    if (start + 35 < numbers.length) await sleep(800);
  }

  job.completed = numbers.length;
  job.paused = false;
  job.done = true;
  job.message = preserveExisting ? 'Recheck finished' : 'Finished';
  job.detail = `${isResume ? 'Resumed and checked' : (preserveExisting ? 'Rechecked' : 'Checked')} ${numbers.length.toLocaleString()} tracking number(s).`;
  await save(job, results);
  chrome.runtime.sendMessage({ type: 'done', job }).catch(() => {});
}

async function retryResults(numbers, trackBatchFailures = false) {
  const clean = dedupe(numbers || []);
  if (!clean.length) return;
  await run(clean, true, trackBatchFailures, 0, false);
}

async function retryFailedBatches(batches) {
  const cleanBatches = (batches || []).filter(b => Array.isArray(b?.trackingNumbers) && b.trackingNumbers.length);
  if (!cleanBatches.length) return;
  const numbers = cleanBatches.flatMap(b => b.trackingNumbers);
  await run(numbers, true, true, 0, false);
}

function replaceByTracking(existing, replacements) {
  const map = new Map(replacements.map(r => [r.tracking, r]));
  const replaced = existing.map(r => map.has(r.tracking) ? map.get(r.tracking) : r);
  const seen = new Set(existing.map(r => r.tracking));
  replacements.forEach(r => { if (!seen.has(r.tracking)) replaced.push(r); });
  return replaced;
}

async function fetchBatch(batch) {
  const url = `${USPS_BASE}${batch.join(',')}`;
  let tabId = null;
  try {
    // Keep the dashboard in focus. USPS processing happens in an inactive background tab.
    // The page can still load and be inspected by the extension without stealing focus.
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    const extracted = await waitForExtraction(tabId, batch);
    return parseBatch(batch, extracted.text || '');
  } finally {
    if (tabId) {
      try { await chrome.tabs.remove(tabId); } catch {}
    }
  }
}

async function waitForExtraction(tabId, batch) {
  const deadline = Date.now() + 30000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({ text: document.body?.innerText || '', ready: document.readyState, url: location.href })
      });
      const x = r?.[0]?.result || {};
      last = x.text || '';

      if (/access denied/i.test(last)) throw new Error('USPS returned Access Denied for this batch.');
      if (/technical difficulties/i.test(last) && !batch.some(n => last.includes(n))) {
        throw new Error('USPS reported technical difficulties on the tracking page.');
      }
      if (batch.some(n => last.includes(n))) {
        await sleep(2500);
        const r2 = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({ text: document.body?.innerText || '', ready: document.readyState, url: location.href })
        });
        return r2?.[0]?.result || x;
      }
    } catch (e) {
      if (/Access Denied|technical difficulties/i.test(e.message || '')) throw e;
    }
    await sleep(1000);
  }
  if (/access denied/i.test(last)) throw new Error('USPS returned Access Denied for this batch.');
  throw new Error('Timed out waiting for USPS results.');
}

function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function normalizeForCompare(s) { return oneLine(s).toLowerCase().replace(/[®™]/g, ''); }

function categoryFor(text) {
  const t = oneLine(text);
  if (/technical difficulties|access denied|timed out/i.test(t)) return 'error';
  if (/tracking not available|tracking information is currently unavailable|no tracking information/i.test(t)) return 'not_available';
  if (/label created,?\s*usps awaiting item|pre-shipment/i.test(t)) return 'awaiting';
  if (/alert\s*:/i.test(t)) return 'alert';
  if (/delivered\b/i.test(t)) return 'delivered';
  if (/out for delivery|arriving late|in transit|moving through network|delivery attempted|delivery exception|delivery interrupted|available for pickup|held at post office|forwarded|missent|insufficient address|no access/i.test(t)) return 'pending';
  return 'error';
}

function shortStatusFrom(cat, status) {
  if (cat === 'delivered') return 'Delivered';
  if (cat === 'alert') return 'Alert';
  if (cat === 'awaiting') return 'Awaiting USPS';
  if (cat === 'not_available') return 'Tracking Not Available';
  if (cat === 'not_loaded') return 'Not Loaded';
  if (cat === 'pending') return 'Not Delivered';
  return 'Needs Review';
}

function cleanSectionLines(section, tracking) {
  const raw = String(section || '').replace(/\r/g, '').split('\n').map(oneLine).filter(Boolean);
  const skipExact = new Set([
    tracking.toLowerCase(), 'copy', 'copy add to informed delivery', 'add to informed delivery',
    'get more out of usps tracking:', 'usps tracking plus®', 'usps tracking plus',
    'latest update', 'track another package'
  ]);
  return raw.filter(line => {
    const n = normalizeForCompare(line);
    if (skipExact.has(n)) return false;
    if (/^copy\b/i.test(line)) return false;
    if (/^add to informed delivery$/i.test(line)) return false;
    return true;
  });
}

function extractLatestAndDetails(lines, cat) {
  const filtered = lines.slice();
  const statusLabels = [
    'Delivered, In/At Mailbox', 'Delivered, To Original Sender', 'Delivered, In/At Front Door',
    'Arriving Late', 'In Transit to Next Facility', 'Moving Through Network', 'Out for Delivery',
    'Delivery Attempted', 'Delivery Interrupted', 'Label Created, USPS Awaiting Item',
    'USPS Awaiting Item', 'Available for Pickup', 'Held at Post Office', 'Forwarded', 'Alert'
  ];
  let idx = -1;
  for (let i = 0; i < filtered.length; i++) {
    if (statusLabels.some(x => normalizeForCompare(filtered[i]).includes(normalizeForCompare(x)))) { idx = i; break; }
  }
  if (idx >= 0) return filtered.slice(idx, Math.min(idx + 3, filtered.length)).join(' — ');
  if (filtered.length) return filtered.slice(0, 3).join(' — ');
  if (cat === 'not_available') return 'Tracking Not Available';
  if (cat === 'awaiting') return 'Label Created, USPS Awaiting Item';
  return '';
}

function parseBatch(batch, text) {
  const clean = text.replace(/\r/g, '');
  const positions = batch.map(n => ({ n, i: clean.indexOf(n) })).filter(x => x.i >= 0).sort((a,b) => a.i - b.i);
  const out = [];
  for (const n of batch) {
    const p = positions.findIndex(x => x.n === n);
    if (p < 0) {
      const cat = categoryFor(clean);
      const status = cat === 'not_available' ? 'Tracking Not Available'
        : /technical difficulties/i.test(clean) ? 'USPS is currently reporting technical difficulties on the tracking application.'
        : /Access Denied/i.test(clean) ? 'USPS returned Access Denied for this batch.'
        : 'No readable USPS result found for this tracking number.';
      out.push({ tracking: n, category: cat === 'error' ? 'error' : cat, status, shortStatus: shortStatusFrom(cat === 'error' ? 'error' : cat, status) });
      continue;
    }
    const start = positions[p].i;
    const end = p + 1 < positions.length ? positions[p + 1].i : Math.min(clean.length, start + 3500);
    const section = clean.slice(start, end);
    const cat = categoryFor(section);
    const lines = cleanSectionLines(section, n);
    const status = extractLatestAndDetails(lines, cat) || 'USPS result loaded, but no readable status text was detected.';
    const finalCat = cat || 'error';
    out.push({ tracking: n, category: finalCat, status, shortStatus: shortStatusFrom(finalCat, status) });
  }
  return out;
}

function parseJsonText(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch {}
  return null;
}

async function requestBridgeViaTab(bridgeUrl, payload) {
  if (!bridgeUrl) throw new Error('Apps Script Web App URL is missing.');
  const requestId = `bridge_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  await chrome.storage.local.set({ [`bridgePayload:${requestId}`]: { bridgeUrl, payload } });
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(async () => {
      const state = bridgeRequests.get(requestId);
      if (!state) return;
      bridgeRequests.delete(requestId);
      try { await chrome.storage.local.remove(`bridgePayload:${requestId}`); } catch {}
      try { if (state.tabId) await chrome.tabs.remove(state.tabId); } catch {}
      reject(new Error('Timed out waiting for Google Apps Script. Make sure you are signed in to Google in Chrome and can open the Web App URL.'));
    }, 60000);
    bridgeRequests.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); }, bridgeUrl, tabId: null, createdAt: Date.now() });
    try {
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`bridge.html?requestId=${encodeURIComponent(requestId)}`), active: false });
      bridgeRequests.get(requestId).tabId = tab.id;
    } catch (e) {
      clearTimeout(timer);
      bridgeRequests.delete(requestId);
      try { await chrome.storage.local.remove(`bridgePayload:${requestId}`); } catch {}
      reject(e);
    }
  });
}

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const entry = [...bridgeRequests.entries()].find(([, v]) => v.tabId === tabId);
  if (!entry) return;
  const [requestId, state] = entry;
  // Ignore the initial bridge.html page; wait for navigation to the Google web app.
  if (state.bridgeUrl.startsWith('http') && state.tabId === tabId) {
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.body?.innerText || '' });
      const text = r?.[0]?.result || '';
      const parsed = parseJsonText(text);
      if (parsed) return finishBridge(requestId, parsed);
      if (/accounts\.google\.com|signin|sign in|permission|authorize/i.test(text) || /accounts\.google\.com/i.test((await chrome.tabs.get(tabId)).url || '')) {
        return finishBridge(requestId, { ok: false, error: 'Google requires you to sign in/authorize the Apps Script web app in the browser. Open the Web App URL once in Chrome, complete authorization, then run the Google Sheets action again.' });
      }
      if (/access denied|forbidden|403/i.test(text)) return finishBridge(requestId, { ok: false, error: 'Apps Script returned an access error. For a direct extension request, the deployment must allow anonymous access. If your Workspace does not allow anonymous web apps, keep the deployment restricted and let the extension use the browser-login fallback.' });
    } catch (e) {
      // Continue waiting a little longer for the final redirect/render.
      state.lastError = e.message;
    }
  }
});

async function finishBridge(requestId, result) {
  const state = bridgeRequests.get(requestId);
  if (!state) return;
  bridgeRequests.delete(requestId);
  try { await chrome.storage.local.remove(`bridgePayload:${requestId}`); } catch {}
  try { await chrome.tabs.remove(state.tabId); } catch {}
  state.resolve(result);
}

async function finishError(e) {
  const data = await chrome.storage.local.get(['job', 'results']);
  const job = data.job || { total: 0, completed: 0, trackingNumbers: [] };
  job.paused = false;
  job.done = true;
  job.message = 'Stopped';
  job.detail = e.message || String(e);
  await save(job, data.results || []);
}
