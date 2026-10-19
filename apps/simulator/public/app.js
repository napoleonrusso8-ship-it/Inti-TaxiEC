// Interfaz del simulador. Todo el contenido dinámico se inserta con textContent (sin innerHTML con datos).
import { SECTIONS, GUIDE } from './sections.js';

const state = { devices: [], selected: null, inbox: [], timeline: [], lastResult: null };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return r.status === 204 ? null : r.json();
}

const statusClass = (s) => (s >= 200 && s < 300 ? 'ok' : s >= 400 && s < 500 ? 'warn' : 'err');

// ---------- Pestañas ----------
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'audit') loadAudit();
  }),
);

// ---------- Salud de servicios ----------
async function loadHealth() {
  const s = await api('GET', '/sim/health');
  const box = document.getElementById('health');
  box.replaceChildren(...Object.entries(s).map(([k, v]) => h('span', { class: `pill ${v === 'ok' ? 'ok' : v === 'apagado' ? 'err' : 'warn'}` }, `${k}: ${v}`)));
}

// ---------- Dispositivos ----------
document.getElementById('new-device').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  const btn = ev.target.querySelector('button');
  btn.disabled = true;
  const r = await api('POST', '/sim/devices', Object.fromEntries(f));
  btn.disabled = false;
  if (r.id) state.selected = r.id;
  else alert(`La atestación fue rechazada (${r.result?.status}). Así se comporta la app real con un teléfono comprometido.`);
  ev.target.reset();
  await refresh();
});

function deviceSummary(d) {
  const c = d.tokenClaims;
  return h('div', { class: 'claims' },
    h('span', { class: 'pill' }, d.role === 'driver' ? 'Conductor' : 'Pasajero'),
    d.integrity !== 'ok' ? h('span', { class: 'pill warn' }, 'rooteado') : null,
    d.loggedIn ? h('span', { class: 'pill ok' }, 'sesión iniciada') : h('span', { class: 'pill' }, 'sin sesión'),
    c ? h('span', { class: 'pill' }, `acr: ${c.acr.split(':').pop()}`) : null,
    c ? h('span', { class: 'pill' }, `amr: ${c.amr.join(' ')}`) : null,
    c ? h('span', { class: `pill ${c.exp * 1000 > Date.now() ? '' : 'err'}`, 'data-exp': c.exp }, '') : null,
    d.hasPasskey ? h('span', { class: 'pill' }, 'passkey') : null,
    d.hasDeviceKey ? h('span', { class: 'pill' }, 'Face ID / huella') : null,
  );
}

function renderDevices() {
  const list = document.getElementById('device-list');
  list.replaceChildren(
    ...state.devices.map((d) =>
      h('li', { class: d.id === state.selected ? 'sel' : '', onclick: () => { state.selected = d.id; renderDevices(); renderPanel(); } },
        h('strong', {}, d.label), h('div', { class: 'meta' }, d.phone ?? 'sin número'), deviceSummary(d)),
    ),
  );
  if (!state.devices.length) list.append(h('li', { class: 'muted' }, 'Aún no hay dispositivos'));
}

function lastCodeFor(device, kind) {
  const re = kind === 'email-link' ? /#token=([A-Za-z0-9_-]+)/ : /(\d{6})/;
  for (const m of state.inbox) {
    if (kind === 'otp' && m.channel !== 'sms') continue;
    if (kind !== 'otp' && m.channel !== 'email') continue;
    const match = re.exec(m.text);
    if (match) return match[1];
  }
  return '';
}

function renderPanel() {
  const panel = document.getElementById('device-panel');
  const d = state.devices.find((x) => x.id === state.selected);
  if (!d) return panel.replaceChildren(h('p', { class: 'muted' }, 'Crea o selecciona un dispositivo para empezar.'));
  const sections = SECTIONS.filter((s) => !s.roles || s.roles.includes(d.role));
  panel.replaceChildren(
    h('div', { class: 'row between' },
      h('div', {}, h('h2', {}, d.label), deviceSummary(d)),
      h('button', { onclick: async () => { await api('DELETE', `/sim/devices/${d.id}`); state.selected = null; refresh(); } }, 'Desinstalar')),
    h('div', { class: 'result', id: 'result' }, state.lastResult ? resultView(state.lastResult) : null),
    ...sections.map((s) =>
      h('div', {}, h('h3', {}, s.title), s.note ? h('p', { class: 'muted' }, s.note) : null,
        h('div', { class: 'actions' }, ...s.items.filter((it) => !it.roles || it.roles.includes(d.role)).map((it) => actionCard(d, it))))),
  );
}

function actionCard(d, it) {
  const inputs = {};
  const fields = (it.fields ?? []).map((f) => {
    const input = f.type === 'select'
      ? h('select', { name: f.name }, ...f.options.map((o) => h('option', { value: o.value }, o.label)))
      : f.type === 'textarea'
        ? h('textarea', { name: f.name, rows: 4, placeholder: f.placeholder ?? '' })
        : h('input', { name: f.name, placeholder: f.placeholder ?? '', value: typeof f.default === 'function' ? f.default(d, state) : f.default ?? '' });
    if (f.type === 'textarea' && f.default) input.value = typeof f.default === 'function' ? f.default(d, state) : f.default;
    inputs[f.name] = input;
    const fill = f.source
      ? h('button', { type: 'button', onclick: () => { input.value = lastCodeFor(d, f.source); } }, f.source === 'email-link' ? 'Usar enlace del último correo' : 'Usar último código')
      : null;
    return h('label', {}, f.label, input, fill);
  });
  const run = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    const values = Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]));
    let params = it.params ? it.params(values, d, state) : values;
    const r = await api('POST', `/sim/devices/${d.id}/action`, { action: it.action, params });
    state.lastResult = { label: it.label, ...r };
    btn.disabled = false;
    await refresh();
  };
  return h('div', { class: 'action' }, h('strong', {}, it.label), it.hint ? h('p', { class: 'hint' }, it.hint) : null, ...fields, h('button', { class: 'primary', onclick: run }, 'Ejecutar'));
}

function resultView(r) {
  return h('div', {}, h('div', { class: 'row' }, h('strong', {}, `Resultado: ${r.label}`), h('span', { class: `pill ${statusClass(r.status)}` }, `HTTP ${r.status}`)),
    h('pre', {}, JSON.stringify(r.body, null, 2)));
}

// ---------- Bandeja ----------
function renderInbox() {
  document.getElementById('inbox-count').textContent = state.inbox.length || '';
  const ul = document.getElementById('inbox');
  ul.replaceChildren(...state.inbox.map((m) => {
    const code = /(\d{6})/.exec(m.text)?.[1];
    return h('li', {},
      h('div', { class: 'row between' }, h('span', { class: 'pill' }, m.channel === 'sms' ? 'SMS' : 'Correo'), h('span', { class: 'muted' }, `${m.to} · ${new Date(m.at).toLocaleTimeString()}`)),
      m.subject ? h('strong', {}, m.subject) : null,
      code && m.channel === 'sms' ? h('div', { class: 'code-big' }, code) : null,
      h('pre', {}, m.text));
  }));
  if (!state.inbox.length) ul.append(h('li', { class: 'muted' }, 'Sin mensajes'));
}
document.getElementById('clear-inbox').addEventListener('click', async () => { await api('DELETE', '/sim/inbox'); refresh(); });

// ---------- Línea de tiempo ----------
function renderTimeline() {
  const ul = document.getElementById('timeline');
  ul.replaceChildren(...state.timeline.map((t) =>
    h('li', {}, h('details', {}, h('summary', {}, h('span', { class: `pill ${statusClass(t.status)}` }, t.status), h('strong', {}, t.action), h('span', { class: 'muted' }, `${t.device} · ${new Date(t.at).toLocaleTimeString()}`)),
      h('pre', {}, JSON.stringify(t.body, null, 2))))));
}

// ---------- Auditoría ----------
async function loadAudit() {
  const a = await api('GET', '/sim/audit');
  document.getElementById('chain').replaceChildren(h('span', { class: `pill ${a.chainIntact ? 'ok' : 'err'}` }, a.chainIntact ? 'Cadena de hash íntegra' : 'Cadena ROTA'));
  document.getElementById('audit').replaceChildren(...a.entries.map((e) =>
    h('li', {}, h('details', {}, h('summary', {}, h('span', { class: `pill ${e.outcome === 'success' ? 'ok' : 'warn'}` }, e.outcome), h('strong', {}, e.action), h('span', { class: 'muted' }, `#${e.seq} · ${e.resource_type} · ${new Date(e.ts).toLocaleTimeString()}`)),
      h('pre', {}, JSON.stringify(e, null, 2))))));
}

// ---------- Guía ----------
document.getElementById('guide').replaceChildren(...GUIDE.map(([tag, text]) => h(tag, {}, text)));

// ---------- Ciclo ----------
async function refresh() {
  const [s, inbox] = await Promise.all([api('GET', '/sim/state'), api('GET', '/sim/inbox')]);
  state.devices = s.devices;
  state.timeline = s.timeline;
  state.inbox = inbox;
  renderDevices();
  renderPanel();
  renderInbox();
  renderTimeline();
}

setInterval(() => {
  document.querySelectorAll('[data-exp]').forEach((el) => {
    const left = Math.round(Number(el.dataset.exp) - Date.now() / 1000);
    el.textContent = left > 0 ? `token: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'token vencido';
  });
}, 1000);
setInterval(async () => { state.inbox = await api('GET', '/sim/inbox'); renderInbox(); }, 3000);
setInterval(loadHealth, 10000);
loadHealth();
refresh();
