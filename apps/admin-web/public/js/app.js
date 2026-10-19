import { Session } from './session.js';
import { h, toast } from './ui.js';
import { setReload, VIEWS } from './views.js';

const $ = (id) => document.getElementById(id);
const config = await (await fetch('/config.json', { cache: 'no-store' })).json();
let session;

function ended(reason) {
  session = undefined;
  $('shell').classList.add('hidden');
  $('login').classList.remove('hidden');
  if (reason) $('login-error').textContent = reason === 'unauthorized' || reason === 'invalid_grant' ? 'La sesión terminó. Vuelve a entrar con tu passkey.' : '';
}

async function login(mode) {
  $('login-error').textContent = '';
  const s = new Session(config, ended);
  try {
    await s.login(mode, $('dev-device').value);
    session = s;
    start();
  } catch (e) {
    $('login-error').textContent = e.status === 403 ? 'Tu cuenta no tiene roles de administración.' : (e.body?.detail ?? e.message);
  }
}

function start() {
  $('login').classList.add('hidden');
  $('shell').classList.remove('hidden');
  $('who').textContent = `${session.userId.slice(0, 8)} · ${session.roles.join(', ')}`;
  const visible = VIEWS.filter((v) => session.has(...v.roles));
  $('menu').replaceChildren(...visible.map((v) => h('li', {}, h('a', { href: `#${v.id}`, 'data-view': v.id }, v.title))));
  show(location.hash.slice(1) || 'resumen');
}

async function show(id) {
  if (!session) return;
  const v = VIEWS.find((x) => x.id === id && session.has(...x.roles)) ?? VIEWS[0];
  for (const a of document.querySelectorAll('#menu a')) a.classList.toggle('active', a.dataset.view === v.id);
  $('drawer').classList.remove('open');
  const root = h('div');
  $('view').replaceChildren(h('h1', {}, v.title), root);
  setReload(() => show(v.id));
  try {
    await v.render(session, root);
  } catch (e) {
    root.replaceChildren(h('p', { class: 'error' }, e.body?.detail ?? e.message));
  }
}

window.addEventListener('hashchange', () => show(location.hash.slice(1)));
$('login-passkey').addEventListener('click', () => login('passkey'));
$('login-dev').addEventListener('click', () => login('dev'));
$('logout').addEventListener('click', async () => {
  await session?.logout();
  ended();
  toast('Sesión cerrada');
});

if (config.devAuthenticator) {
  const devices = await (await fetch('/dev/authenticator/devices')).json().catch(() => []);
  $('dev-device').replaceChildren(...devices.map((d) => h('option', { value: d.id }, `${d.label} (${d.userId.slice(0, 8)})`)));
  if (!devices.length) $('dev-device').replaceChildren(h('option', { value: '' }, 'Crea en el simulador un dispositivo con passkey'));
  $('dev-login').classList.remove('hidden');
}
ended();
