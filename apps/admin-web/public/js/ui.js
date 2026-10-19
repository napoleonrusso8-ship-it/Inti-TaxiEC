// Utilidades de interfaz. Todo el contenido que viene de la API se inserta con textContent:
// nunca innerHTML, para que un dato malicioso (p. ej. el nombre de una parada) no pueda ejecutar código.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const money = (c) => (typeof c === 'number' ? `$${(c / 100).toFixed(2)}` : '');
const dt = (v) => (v ? new Intl.DateTimeFormat('es-EC', { timeZone: 'America/Guayaquil', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(v)) : '');
export const fmt = { money, dt, short: (id) => (id ? String(id).slice(0, 8) : '') };

/** Tabla: columnas {label, value(row) | key, format?}; acciones opcionales por fila. */
export function table(rows, columns, actions) {
  if (!rows?.length) return h('p', { class: 'empty' }, 'Sin resultados.');
  const head = h('tr', {}, columns.map((c) => h('th', {}, c.label)), actions ? h('th', {}, '') : null);
  const body = rows.map((r) =>
    h(
      'tr',
      {},
      columns.map((c) => {
        const v = c.value ? c.value(r) : r[c.key];
        return h('td', {}, v instanceof Node ? v : typeof v === 'object' && v !== null ? JSON.stringify(v) : (v ?? ''));
      }),
      actions ? h('td', { class: 'actions' }, actions(r)) : null,
    ),
  );
  return h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, head), h('tbody', {}, body)));
}

/** Formulario simple. fields: {name, label, type?: text|number|select|textarea, options?, value?, required?} */
export function form(fields, submitLabel, onSubmit) {
  const inputs = {};
  const el = h(
    'form',
    {
      class: 'form',
      onsubmit: async (e) => {
        e.preventDefault();
        const values = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.type === 'number' ? (i.value === '' ? undefined : Number(i.value)) : i.value]));
        const btn = el.querySelector('button');
        btn.disabled = true;
        try {
          await onSubmit(values);
        } finally {
          btn.disabled = false;
        }
      },
    },
    fields.map((f) => {
      const common = { name: f.name, id: `f-${f.name}`, required: f.required ?? false };
      const input =
        f.type === 'select'
          ? h('select', common, f.options.map((o) => h('option', { value: o.value ?? o, selected: (o.value ?? o) === f.value }, o.label ?? o)))
          : f.type === 'textarea'
            ? h('textarea', { ...common, rows: 3, maxlength: f.max ?? 2000 }, f.value ?? '')
            : h('input', { ...common, type: f.type ?? 'text', value: f.value ?? '', placeholder: f.placeholder ?? '', maxlength: f.max ?? 300 });
      inputs[f.name] = input;
      return h('label', { for: common.id }, h('span', {}, f.label), input);
    }),
    h('button', { type: 'submit' }, submitLabel),
  );
  return el;
}

export function json(v) {
  return h('pre', { class: 'json' }, JSON.stringify(v, null, 2));
}

export function card(title, ...children) {
  return h('section', { class: 'card' }, h('h3', {}, title), ...children);
}

let toastTimer;
export function toast(msg, kind = 'ok') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast hidden'), 5000);
}

/** Ejecuta una acción y muestra el resultado o el error del servidor (problem+json). */
export async function run(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.body?.detail ?? e.message, 'error');
    return undefined;
  }
}

export function button(label, onclick, kind) {
  return h('button', { type: 'button', class: kind ?? '', onclick }, label);
}

/** Pide un dato con un diálogo nativo (motivo, resolución…). null si se cancela. */
export function ask(question, min = 5) {
  const v = prompt(question);
  if (v === null) return null;
  if (v.trim().length < min) {
    toast(`Escribe al menos ${min} caracteres`, 'error');
    return null;
  }
  return v.trim();
}
