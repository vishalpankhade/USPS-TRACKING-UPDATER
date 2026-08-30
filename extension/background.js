const USPS_BASE = 'https://tools.usps.com/tracking/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let stopRequested = false;
// Keep the v2.4 flow: one automatic retry of the same batch, with the same 30s wait.
// Failed batches are retained separately so the user can retry them manually after the run.
const AUTO_RETRIES = 1;
let failedBatches = [];

function batchKey(numbers) {
  return numbers.join('|');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'start') {
    stopRequested = false;
    run(msg.trackingNumbers, false).catch(e => finishError(e));
  }
  if (msg.type === 'retry') {
    stopRequested = false;
    retryResults(msg.trackingNumbers || []).catch(e => finishError(e));
  }
  if (msg.type === 'retryFailedBatches') {
    stopRequested = false;
    retryFailedBatches(msg.batches || []).catch(e => finishError(e));
  }
  if (msg.type === 'stop') stopRequested = true;
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

async function run(input, preserveExisting, trackBatchFailures = true) {
  const numbers = dedupe(input || []);
  const stored = await chrome.storage.local.get(['results', 'job']);
  const existing = preserveExisting ? (stored.results || []) : [];
  let results = preserveExisting ? existing.slice() : [];
  if (!preserveExisting) {
    failedBatches = [];
  } else if (!failedBatches.length && Array.isArray(stored.job?.failedBatches)) {
    failedBatches = stored.job.failedBatches.slice();
  }

  let job = {
    total: numbers.length,
    completed: 0,
    message: preserveExisting ? 'Retrying needs review…' : 'Starting…',
    detail: preserveExisting ? `Retrying ${numbers.length.toLocaleString()} result(s).` : '',
    done: false
  };
  await save(job, results);

  for (let start = 0; start < numbers.length; start += 35) {
    if (stopRequested) {
      job.done = true;
      job.message = 'Stopped';
      job.detail = `Stopped after ${job.completed.toLocaleString()} of ${numbers.length.toLocaleString()} result(s).`;
      await save(job, results);
      chrome.runtime.sendMessage({ type: 'done', job }).catch(() => {});
      return;
    }

    const batch = numbers.slice(start, start + 35);
    const batchNo = Math.floor(start / 35) + 1;
    let parsed;
    let lastError = null;

    for (let attempt = 0; attempt <= AUTO_RETRIES; attempt++) {
      try {
        job.message = `${preserveExisting ? 'Retrying' : 'Checking'} batch ${batchNo}…`;
        job.detail = `Batch ${batchNo}: ${batch.length} tracking number(s).${attempt ? ' Automatic retry in progress.' : ''}`;
        await save(job, results);
        parsed = await fetchBatch(batch);
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        if (attempt < AUTO_RETRIES) {
          job.message = `Batch ${batchNo} failed — retrying…`;
          job.detail = `${e.message} USPS sometimes fails to load; the same batch will be reopened automatically once.`;
          await save(job, results);
          await sleep(1400);
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

        // A failed page load is NOT the same thing as an unknown USPS status.
        // Keep it in the dedicated Not Loaded state so Needs Review remains a true parser/recognition fallback.
        parsed = batch.map(tracking => ({
          tracking,
          category: 'not_loaded',
          status: `USPS page could not be loaded/read automatically. ${lastError.message}`,
          shortStatus: 'Not Loaded'
        }));
      } else {
        // When retrying a Needs Review item, keep it in Needs Review if the retry itself fails.
        parsed = batch.map(tracking => ({
          tracking,
          category: 'error',
          status: `USPS page could not be read automatically. ${lastError.message}`,
          shortStatus: 'Needs Review'
        }));
      }
    } else if (trackBatchFailures) {
      // A successful retry clears this exact failed batch from the retry queue.
      failedBatches = failedBatches.filter(x => x.key !== key);
    }

    if (preserveExisting) {
      results = replaceByTracking(results, parsed);
    } else {
      results.push(...parsed);
    }

    job.completed = Math.min(start + batch.length, numbers.length);
    const readable = parsed.filter(x => x.category !== 'error').length;
    job.message = lastError ? `Batch ${batchNo} needs review` : `${preserveExisting ? 'Retried' : 'Completed'} batch ${batchNo}`;
    job.detail = lastError
      ? `The batch failed after the automatic retry. ${parsed.length} tracking number(s) were kept in Not Loaded so you can retry the batch later.`
      : `Received ${readable} readable USPS result(s).`;
    await save(job, results);

    if (start + 35 < numbers.length) await sleep(900);
  }

  job.done = true;
  job.message = preserveExisting ? 'Retry finished' : 'Finished';
  job.detail = `${preserveExisting ? 'Retried' : 'Checked'} ${numbers.length.toLocaleString()} tracking number(s).`;
  await save(job, results);
  chrome.runtime.sendMessage({ type: 'done', job }).catch(() => {});
}

async function retryResults(numbers) {
  const clean = dedupe(numbers || []);
  if (!clean.length) return;
  await run(clean, true, false);
}

async function retryFailedBatches(batches) {
  const cleanBatches = (batches || []).filter(b => Array.isArray(b?.trackingNumbers) && b.trackingNumbers.length);
  if (!cleanBatches.length) return;
  const numbers = cleanBatches.flatMap(b => b.trackingNumbers);
  await run(numbers, true, true);
}

function replaceByTracking(existing, replacements) {
  const map = new Map(replacements.map(r => [r.tracking, r]));
  const replaced = existing.map(r => map.has(r.tracking) ? map.get(r.tracking) : r);
  const seen = new Set(existing.map(r => r.tracking));
  replacements.forEach(r => { if (!seen.has(r.tracking)) replaced.push(r); });
  return replaced;
}

async function fetchBatch(batch) {
  // USPS's current multi-tracking route uses the tracking numbers directly in the path.
  // Keep commas unescaped, matching the URL generated by the current USPS website.
  const url = `${USPS_BASE}${batch.join(',')}`;
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: true });
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
        func: () => ({
          text: document.body?.innerText || '',
          ready: document.readyState,
          url: location.href
        })
      });
      const x = r?.[0]?.result || {};
      last = x.text || '';

      if (/access denied/i.test(last)) {
        throw new Error('USPS returned Access Denied for this batch.');
      }
      if (/technical difficulties/i.test(last) && !batch.some(n => last.includes(n))) {
        throw new Error('USPS reported technical difficulties on the tracking page.');
      }
      if (batch.some(n => last.includes(n))) {
        await sleep(3000);
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

function oneLine(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function normalizeForCompare(s) {
  return oneLine(s).toLowerCase().replace(/[®™]/g, '');
}

function categoryFor(text) {
  const t = oneLine(text);
  if (/technical difficulties|access denied|timed out/i.test(t)) return 'error';
  if (/tracking not available|tracking information is currently unavailable|no tracking information/i.test(t)) return 'not_available';
  if (/label created,?\s*usps awaiting item|usps awaiting item|pre-shipment/i.test(t)) return 'awaiting';
  if (/\balert\b/i.test(t)) return 'alert';
  if (/\bdelivered\b/i.test(t) && !/delivery attempt|attempted delivery|not delivered/i.test(t)) return 'delivered';
  if (/in transit|moving through network|arriving late|out for delivery|delivery attempted|delivery exception|delivery interrupted|awaiting delivery scan|available for pickup|held at post office|forwarded|missent|notice left|redelivery|processing at usps facility|departed usps facility|arrived at usps facility|insufficient address|no access to delivery location|pickup notice|scheduled delivery/i.test(t)) return 'pending';
  return 'error';
}

const BOILERPLATE = [
  /^copy$/i,
  /^add to informed delivery$/i,
  /^copy add to informed delivery$/i,
  /^usps tracking plus®?$/i,
  /^sign up for informed delivery$/i,
  /^feedback$/i,
  /^faqs?$/i,
  /^usps\.com$/i,
  /^track packages$/i,
  /^tracking$/i
];

function cleanSectionLines(section, tracking) {
  const tn = normalizeForCompare(tracking);
  const lines = section.split('\n').map(oneLine).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (normalizeForCompare(line) === tn) continue;
    if (BOILERPLATE.some(re => re.test(line))) continue;
    if (/^\d{1,3}(?:,\d{3})*\s*(?:of|results?)$/i.test(line)) continue;
    if (out.length && normalizeForCompare(out[out.length - 1]) === normalizeForCompare(line)) continue;
    out.push(line);
  }
  return out;
}

function extractLatestAndDetails(lines, category) {
  const latestIdx = lines.findIndex(x => /^latest update$/i.test(x));
  const plusIdx = lines.findIndex(x => /^get more out of usps tracking:?$/i.test(x));
  let latest = '';
  if (latestIdx >= 0) {
    const end = plusIdx > latestIdx ? plusIdx : Math.min(lines.length, latestIdx + 5);
    const candidates = lines.slice(latestIdx + 1, end).filter(x => !BOILERPLATE.some(re => re.test(x)));
    latest = candidates[0] || '';
  }

  const body = lines.filter(x => !/^latest update$/i.test(x) && !/^get more out of usps tracking:?$/i.test(x) && !/^usps tracking plus®?$/i.test(x));
  let detail = '';
  if (category === 'delivered') {
    detail = body.find(x => /^delivered(?:,|$)/i.test(x)) || '';
  } else if (category === 'alert') {
    detail = body.find(x => /\balert\b/i.test(x)) || '';
  } else if (category === 'awaiting') {
    detail = body.find(x => /label created|usps awaiting item|pre-shipment/i.test(x)) || '';
  } else if (category === 'not_available') {
    detail = 'Tracking Not Available';
  } else if (category === 'pending') {
    const matches = [
      /arriving late/i, /out for delivery/i, /delivery interrupted/i, /delivery attempted/i, /awaiting delivery scan/i,
      /available for pickup/i, /held at post office/i, /in transit/i, /moving through network/i, /processing at usps facility/i,
      /departed usps facility/i, /arrived at usps facility/i, /scheduled delivery/i
    ];
    detail = body.find(x => matches.some(re => re.test(x))) || '';
  }

  if (latest && detail && normalizeForCompare(latest) !== normalizeForCompare(detail)) return `${latest}\n${detail}`;
  return latest || detail || lines.slice(0, 4).join('\n');
}

function shortStatusFrom(category, status) {
  const t = oneLine(status);
  if (category === 'delivered') return t.match(/Delivered,\s*[A-Za-z0-9 /'&-]+/i)?.[0]?.trim() || 'Delivered';
  if (category === 'alert') return t.match(/Alert:?\s*[^.\n]+/i)?.[0]?.trim() || 'Alert';
  if (category === 'awaiting') return t.match(/Label Created,?\s*[^.\n]+|USPS Awaiting Item|Pre-Shipment/i)?.[0]?.trim() || 'Awaiting USPS';
  if (category === 'not_available') return 'Tracking Not Available';
  if (category === 'not_loaded') return 'Not Loaded';
  if (category === 'pending') {
    const m = t.match(/Arriving Late|Out for Delivery|Delivery Interrupted|Delivery Attempted|Awaiting Delivery Scan|Available for Pickup|Held at Post Office|In Transit|Moving Through Network|Processing at USPS Facility|Departed USPS Facility|Arrived at USPS Facility|Scheduled Delivery/i);
    return m ? m[0] : 'Not Delivered';
  }
  return 'Needs Review';
}

function parseBatch(batch, text) {
  const clean = text.replace(/\r/g, '');
  const positions = batch
    .map(n => ({ n, i: clean.indexOf(n) }))
    .filter(x => x.i >= 0)
    .sort((a, b) => a.i - b.i);

  const out = [];
  for (const n of batch) {
    const p = positions.findIndex(x => x.n === n);
    if (p < 0) {
      const cat = categoryFor(clean);
      const status = cat === 'not_available'
        ? 'Tracking Not Available'
        : /technical difficulties/i.test(clean)
          ? 'USPS is currently reporting technical difficulties on the tracking application.'
          : /Access Denied/i.test(clean)
            ? 'USPS returned Access Denied for this batch.'
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
    out.push({
      tracking: n,
      category: finalCat,
      status,
      shortStatus: shortStatusFrom(finalCat, status)
    });
  }
  return out;
}

async function finishError(e) {
  const data = await chrome.storage.local.get(['job', 'results']);
  const job = data.job || { total: 0, completed: 0 };
  job.message = 'Stopped';
  job.detail = e.message || String(e);
  job.done = true;
  await save(job, data.results || []);
}
