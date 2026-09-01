(async () => {
  const status = document.getElementById('status');
  const params = new URLSearchParams(location.search);
  const requestId = params.get('requestId');
  if (!requestId) { status.textContent = 'Missing bridge request.'; return; }

  const key = `bridgePayload:${requestId}`;
  const stored = await chrome.storage.local.get(key);
  const item = stored[key];
  if (!item?.bridgeUrl || !item?.payload) { status.textContent = 'Bridge request expired.'; return; }

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = item.bridgeUrl;
  form.style.display = 'none';

  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'payload';
  input.value = JSON.stringify(item.payload);
  form.appendChild(input);
  document.body.appendChild(form);
  status.textContent = 'Sending request…';
  form.submit();
})().catch(err => {
  document.getElementById('status').textContent = `Bridge error: ${err.message || err}`;
});
