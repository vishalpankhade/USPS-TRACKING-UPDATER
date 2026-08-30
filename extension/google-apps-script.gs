// USPS Bulk Tracker - free Google Sheets bridge
// Paste this file into Extensions -> Apps Script in the Google Sheet you want to update.
// IMPORTANT: Change SECRET below, deploy as a Web app, and use the exact same secret in the extension.

const SECRET = 'CHANGE_THIS_TO_A_SECRET';

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : '{}');
    if (payload.secret !== SECRET) return json({ ok: false, error: 'Unauthorized: secret does not match.' });

    const action = String(payload.action || 'sync').toLowerCase();
    const spreadsheetId = String(payload.spreadsheetId || '').trim();
    if (!spreadsheetId) return json({ ok: false, error: 'Missing spreadsheetId.' });

    const ss = SpreadsheetApp.openById(spreadsheetId);
    const sheetName = String(payload.sheetName || '').trim();
    const sheet = resolveSheet(ss, sheetName);
    if (!sheet) {
      const available = ss.getSheets().map(s => s.getName()).join(', ');
      return json({ ok: false, error: sheetName
        ? `Sheet tab not found: ${sheetName}. Available tabs: ${available || '(none)'}`
        : `No sheet tabs found.`
      });
    }

    if (action === 'read') return readTrackings(sheet, String(payload.trackingColumn || '').trim());
    if (action === 'sync') return syncResults(sheet, payload);

    return json({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}


function resolveSheet(ss, requestedName) {
  const sheets = ss.getSheets();
  if (!sheets.length) return null;
  const requested = String(requestedName || '').trim();
  if (!requested) return sheets[0];

  // First try Google's exact tab name lookup.
  const exact = ss.getSheetByName(requested);
  if (exact) return exact;

  // Then be forgiving about capitalization and extra spaces.
  const normalizeName = value => String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const wanted = normalizeName(requested);
  const match = sheets.find(sh => normalizeName(sh.getName()) === wanted);
  if (match) return match;

  // If the spreadsheet has only one tab, using it is unambiguous and avoids
  // a needless failure caused by a stale/mistyped tab name in the extension.
  if (sheets.length === 1) return sheets[0];
  return null;
}

function readTrackings(sheet, trackingColumnLetter) {
  const data = sheet.getDataRange().getValues();
  const headerRow = findHeaderRow(data);
  const headers = data[headerRow - 1] || [];
  const trackingCol = trackingColumnLetter
    ? colLetterToNumber(trackingColumnLetter)
    : findTrackingColumn(headers);

  if (!trackingCol) {
    return json({ ok: false, error: 'Could not find the tracking-number column. Put "Tracking Number" in your header row or specify the column (for example D).' });
  }

  const trackings = [];
  const seen = new Set();
  for (let r = headerRow; r < data.length; r++) {
    const raw = data[r][trackingCol - 1];
    const normalized = normalizeTracking(raw);
    if (normalized && normalized.length >= 8 && !seen.has(normalized)) {
      seen.add(normalized);
      trackings.push(normalized);
    }
  }

  return json({ ok: true, trackingNumbers: trackings, count: trackings.length, headerRow, trackingColumn: trackingCol });
}

function syncResults(sheet, payload) {
  const results = Array.isArray(payload.results) ? payload.results : [];
  if (!results.length) return json({ ok: true, updated: 0, message: 'No results to sync.' });

  const data = sheet.getDataRange().getValues();
  const headerRow = findHeaderRow(data);
  const headers = data[headerRow - 1] || [];
  const trackingColumnLetter = String(payload.trackingColumn || '').trim();
  const trackingCol = trackingColumnLetter
    ? colLetterToNumber(trackingColumnLetter)
    : findTrackingColumn(headers);

  if (!trackingCol) {
    return json({ ok: false, error: 'Could not find the tracking-number column. Put "Tracking Number" in your header row or specify the column (for example D).' });
  }

  const outputCols = ensureOutputColumns(sheet, headerRow, trackingCol, headers);
  const values = sheet.getDataRange().getValues();
  const rowMap = new Map();
  for (let r = headerRow; r < values.length; r++) {
    const normalized = normalizeTracking(values[r][trackingCol - 1]);
    if (normalized) {
      if (!rowMap.has(normalized)) rowMap.set(normalized, []);
      rowMap.get(normalized).push(r + 1);
    }
  }

  const resultMap = new Map(results.map(x => [normalizeTracking(x.tracking), x]));
  const statusWrites = [];
  const linkWrites = [];

  resultMap.forEach((result, tracking) => {
    const rows = rowMap.get(tracking) || [];
    rows.forEach(rowNumber => {
      statusWrites.push({ rowNumber, value: String(result.status || '') });
      linkWrites.push({ rowNumber, value: String(result.url || '') });
    });
  });

  // Write short status + link only. Detailed USPS text stays in the extension dashboard.
  statusWrites.forEach(item => sheet.getRange(item.rowNumber, outputCols.statusCol).setValue(item.value));
  linkWrites.forEach(item => {
    const cell = sheet.getRange(item.rowNumber, outputCols.linkCol);
    if (item.value) {
      const rich = SpreadsheetApp.newRichTextValue().setText('Open USPS').setLinkUrl(item.value).build();
      cell.setRichTextValue(rich);
    } else {
      cell.setValue('');
    }
  });

  return json({
    ok: true,
    updated: statusWrites.length,
    statusColumn: outputCols.statusCol,
    linkColumn: outputCols.linkCol
  });
}

function findHeaderRow(data) {
  const max = Math.min(data.length, 10);
  for (let r = 0; r < max; r++) {
    const row = data[r].map(v => String(v || '').trim().toLowerCase());
    if (row.some(v => /tracking\s*(number|no|#)?/i.test(v))) return r + 1;
  }
  return 1;
}

function findTrackingColumn(headers) {
  for (let c = 0; c < headers.length; c++) {
    const h = String(headers[c] || '').trim().toLowerCase();
    if (/^tracking\s*(number|no|#)?$/i.test(h) || /tracking number/i.test(h)) return c + 1;
  }
  return null;
}

function ensureOutputColumns(sheet, headerRow, trackingCol, headers) {
  let statusCol = headers.findIndex(h => /^usps\s*status$/i.test(String(h || '').trim())) + 1;
  let linkCol = headers.findIndex(h => /^usps\s*link$/i.test(String(h || '').trim())) + 1;
  const lastCol = Math.max(sheet.getLastColumn(), headers.length);

  const next1 = String(sheet.getRange(headerRow, trackingCol + 1).getValue() || '').trim();
  const next2 = String(sheet.getRange(headerRow, trackingCol + 2).getValue() || '').trim();

  if (!statusCol && !next1) statusCol = trackingCol + 1;
  if (!linkCol && !next2) linkCol = trackingCol + 2;
  if (!statusCol) statusCol = lastCol + 1;
  if (!linkCol) linkCol = statusCol + 1;

  sheet.getRange(headerRow, statusCol).setValue('USPS Status');
  sheet.getRange(headerRow, linkCol).setValue('USPS Link');
  return { statusCol, linkCol };
}

function normalizeTracking(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function colLetterToNumber(letter) {
  const s = String(letter || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (!s) return null;
  let n = 0;
  for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
  return n;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
