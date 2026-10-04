const $ = selector => document.querySelector(selector);
let workspace;
let user;
let noticeTimer;
const requests = new WeakMap();

function notify(message, error = false) {
  clearTimeout(noticeTimer);
  $('#notice').textContent = message;
  $('#notice').classList.toggle('error', error);
  $('#notice').hidden = false;
  noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 7000);
}
function showLogin() {
  user = null;
  workspace = null;
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  for (const result of document.querySelectorAll('.result')) { result.replaceChildren(); result.hidden = true; }
  for (const input of document.querySelectorAll('input[type=password]')) input.value = '';
}
async function api(path, data) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store',
    ...(data !== undefined ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {})
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/v1/auth/login') showLogin();
    throw new Error(result.error?.message ?? 'Something went wrong. Please try again.');
  }
  return result;
}
function selectOptions(select, rows, empty = 'None available') {
  const previous = select.value;
  select.replaceChildren();
  if (!rows.length) { const option = new Option(empty, ''); option.disabled = true; select.add(option); }
  for (const row of rows) select.add(new Option(row.name, row.id));
  if (rows.some(row => row.id === previous)) select.value = previous;
}
const tenantId = () => $('#tenant-select').value;
const scoped = items => items.filter(item => item.tenant_id === tenantId());
function tableRows(target, rows, empty) {
  target.replaceChildren();
  for (const values of rows) {
    const tr = document.createElement('tr');
    for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
    target.append(tr);
  }
  if (!rows.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = target.closest('table').querySelectorAll('th').length; td.className = 'empty'; td.textContent = empty; tr.append(td); target.append(tr); }
}
function fillConfiguration() {
  const form = $('#config-form');
  const config = workspace.configurations.find(item => item.booth_id === form.elements.booth_id.value);
  for (const [key, fallback] of Object.entries({ price_idr:25000, first_photo_timer_seconds:3, remaining_photo_timer_seconds:2, retake_limit:1 }))
    form.elements[key].value = config?.[key] ?? fallback;
  form.elements.iso.value = config?.camera_settings.iso ?? 400;
  const shutter = config?.camera_settings.shutter ?? '1/125';
  if (![...form.elements.shutter.options].some(option => option.value === shutter)) form.elements.shutter.add(new Option(shutter, shutter));
  form.elements.shutter.value = shutter;
  $('#frame-options').replaceChildren();
  for (const frame of scoped(workspace.frames)) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.name = 'frame_version_ids'; checkbox.value = frame.id;
    checkbox.checked = config ? config.frame_version_ids.includes(frame.id) : scoped(workspace.frames)[0]?.id === frame.id;
    label.append(checkbox, document.createTextNode(frame.name)); $('#frame-options').append(label);
  }
  if (!scoped(workspace.frames).length) $('#frame-options').textContent = 'Create a frame first in the Frames page.';
}
function render() {
  const booths = scoped(workspace.booths), frames = scoped(workspace.frames), vouchers = scoped(workspace.vouchers);
  $('#booth-count').textContent = booths.length;
  $('#configured-count').textContent = booths.filter(booth => Number(booth.config_version) > 0).length;
  $('#voucher-count').textContent = vouchers.filter(voucher => !voucher.redeemed_session_id && Date.parse(voucher.expires_at) > Date.now()).length;
  selectOptions($('#booth-form select'), scoped(workspace.sites), 'No sites in this business');
  for (const form of [$('#config-form'), $('#voucher-form')])
    selectOptions(form.elements.booth_id, booths.filter(booth => booth.active), 'Register a booth first');
  tableRows($('#booth-list'), booths.map(booth => [booth.name, workspace.sites.find(site => site.id === booth.site_id)?.name ?? '—', Number(booth.config_version) ? `v${booth.config_version} · ${Number(booth.applied_config_version) === Number(booth.config_version) ? 'Applied' : 'Awaiting sync'}` : 'Not published', booth.active ? 'Active' : 'Disabled']), 'Your first booth belongs here.');
  tableRows($('#voucher-list'), vouchers.map(voucher => [workspace.booths.find(booth => booth.id === voucher.booth_id)?.name ?? 'All booths', new Date(voucher.expires_at).toLocaleDateString(), voucher.redeemed_session_id ? 'Redeemed' : Date.parse(voucher.expires_at) <= Date.now() ? 'Expired' : 'Available']), 'Issue a voucher to invite the first session.');
  $('#frame-list').replaceChildren();
  for (const frame of frames) {
    const li = document.createElement('li'), name = document.createElement('span'), slots = document.createElement('span');
    name.textContent = frame.name; slots.textContent = `${frame.manifest.slots ?? '—'} photos`; slots.className = 'badge'; li.append(name, slots); $('#frame-list').append(li);
  }
  if (!frames.length) { const li = document.createElement('li'); li.textContent = 'Create your first frame version.'; li.className = 'empty'; $('#frame-list').append(li); }
  fillConfiguration();
}
async function refresh() {
  workspace = await api('/v1/admin/workspace');
  selectOptions($('#tenant-select'), workspace.tenants, 'No businesses available');
  render();
}
function page(name) {
  for (const section of document.querySelectorAll('[data-section]')) section.hidden = section.dataset.section !== name;
  for (const button of document.querySelectorAll('nav [data-page]')) button.classList.toggle('active', button.dataset.page === name);
}
for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => page(button.dataset.page));
$('#tenant-select').addEventListener('change', () => {
  for (const result of document.querySelectorAll('.result')) { result.hidden = true; result.replaceChildren(); }
  render();
});
$('#config-form').elements.booth_id.addEventListener('change', fillConfiguration);

// Reuse the request ID after uncertain network failures, including voucher
// expiry computed on the first submission. Identical retries stay idempotent.
async function mutation(form, path, fields) {
  const fingerprint = JSON.stringify({path,tenant:tenantId(),fields:[...new FormData(form)]});
  let cached = requests.get(form);
  if (!cached || cached.fingerprint !== fingerprint) {
    cached = { fingerprint, data: { ...fields, request_id: crypto.randomUUID() } }; requests.set(form, cached);
  }
  const result = await api(path, cached.data); requests.delete(form); return result;
}
function bindForm(selector, handler) {
  const form = $(selector);
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = form.querySelector('button[type=submit],button'); button.disabled = true;
    try { await handler(form, Object.fromEntries(new FormData(form))); }
    catch (error) { notify(error.message, true); }
    finally { button.disabled = false; }
  });
}
function showResult(selector, message, secret) {
  const target = $(selector); target.replaceChildren(document.createTextNode(message)); target.hidden = false;
  if (secret) {
    const code = document.createElement('code'); code.textContent = secret; target.append(code);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.textContent = 'Copy';
    button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(secret); notify('Copied.'); } catch { notify('Select the code to copy it.', true); } }); target.append(button);
  }
}
bindForm('#login-form', async (form, fields) => {
  const result = await api('/v1/auth/login', fields); form.elements.password.value = ''; user = result.user;
  await refresh(); $('#user-email').textContent = user.email; $('#login-view').hidden = true; $('#app-view').hidden = false; page('overview');
});
bindForm('#booth-form', async (form, fields) => {
  const result = await mutation(form, '/v1/admin/booths', { tenant_id: tenantId(), ...fields });
  showResult('#booth-result', 'Booth registered. Save this device credential securely for the booth setup.', result.device_credential);
  await refresh(); $('#config-form').elements.booth_id.value = result.booth_id; $('#voucher-form').elements.booth_id.value = result.booth_id; fillConfiguration(); notify('Booth registered. Publish its configuration next.');
});
bindForm('#frame-form', async (form, fields) => {
  await mutation(form, '/v1/admin/frames', { tenant_id: tenantId(), name: fields.name, manifest: { slots: Number(fields.slots) } });
  form.reset(); await refresh(); notify('Frame version created.');
});
bindForm('#config-form', async (form, fields) => {
  const frames = new FormData(form).getAll('frame_version_ids');
  if (!frames.length) throw new Error('Choose at least one frame.');
  const result = await mutation(form, `/v1/admin/booths/${fields.booth_id}/configurations`, {
    frame_version_ids: frames, price_idr: Number(fields.price_idr), first_photo_timer_seconds: Number(fields.first_photo_timer_seconds),
    remaining_photo_timer_seconds: Number(fields.remaining_photo_timer_seconds), retake_limit: Number(fields.retake_limit),
    camera_settings: { ...workspace.configurations.find(config => config.booth_id === fields.booth_id)?.camera_settings, iso:Number(fields.iso), shutter:fields.shutter }
  });
  showResult('#config-result', `Version ${result.desired_version} published. Waiting for the booth to sync and confirm.`); await refresh(); notify('Configuration published.');
});
bindForm('#voucher-form', async (form, fields) => {
  const result = await mutation(form, '/v1/admin/vouchers', { tenant_id: tenantId(), booth_id: fields.booth_id, expires_at: new Date(Date.now() + Number(fields.days) * 86400000).toISOString() });
  showResult('#voucher-result', `Voucher issued. Save its code now; it expires ${new Date(result.expires_at).toLocaleString()}.`, result.code); await refresh(); notify('Voucher ready for one session.');
});
bindForm('#password-form', async (form, fields) => {
  await api('/v1/auth/password', fields); form.reset(); showLogin(); notify('Password changed. Sign in with your new password.');
});
$('#logout').addEventListener('click', async () => { try { await api('/v1/auth/logout', {}); showLogin(); } catch (error) { notify(error.message, true); } });
try {
  const result = await api('/v1/auth/me'); user = result.user; await refresh(); $('#user-email').textContent = user.email;
  $('#login-view').hidden = true; $('#app-view').hidden = false;
} catch (error) { if (error.message !== 'Please sign in') notify(error.message, true); }
