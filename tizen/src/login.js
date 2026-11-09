// Login dialog: shows the device code and a QR code for twitch.tv/activate,
// then waits for the user to approve it on a phone or computer.
import qrcode from 'qrcode-generator';
import { $, h, toast } from './ui.js';
import * as nav from './nav.js';
import { startDeviceLogin, waitForDeviceLogin } from './auth.js';

let session = null;

export const isOpen = () => Boolean(session);

export async function openLogin(onDone) {
  const current = session = { cancelled: false, scope: nav.getScope(), focus: document.activeElement };
  $('modal').hidden = false;
  nav.setScope($('modal'));
  show(h('h2', null, 'Entrar com a Twitch'), h('p', { className: 'muted' }, 'Gerando código…'), button('Cancelar'));
  try {
    const device = await startDeviceLogin();
    if (current.cancelled) return;
    const qr = qrcode(0, 'M');
    qr.addData(device.verification_uri);
    qr.make();
    show(
      h('h2', null, 'Entrar com a Twitch'),
      h('div', { className: 'login' },
        h('img', { className: 'qr', src: qr.createDataURL(8, 2), alt: '' }),
        h('div', { className: 'login-steps' },
          h('p', null, 'Aponte a câmera do celular para o QR code ou acesse'),
          h('p', { className: 'url' }, 'twitch.tv/activate'),
          h('p', null, 'e digite o código'),
          h('p', { className: 'code' }, device.user_code),
        ),
      ),
      button('Cancelar'),
    );
    const auth = await waitForDeviceLogin(device, current);
    if (current.cancelled) return;
    close();
    toast(`Conectado como ${auth.login}`);
    onDone?.();
  } catch (err) {
    if (current.cancelled) return;
    show(h('h2', null, 'Não foi possível entrar'), h('p', { className: 'muted' }, err.message), button('Fechar'));
  }
}

const button = label => h('button', { className: 'btn focusable', onclick: close }, label);

function show(...nodes) {
  $('modal-box').replaceChildren(...nodes);
  nav.focus(nav.focusables($('modal-box'))[0]);
}

function close() {
  if (!session) return;
  const { scope, focus } = session;
  session.cancelled = true;
  session = null;
  $('modal').hidden = true;
  nav.setScope(scope);
  if (focus?.isConnected) nav.focus(focus);
}

export function onKey(key) {
  if (key === 'back') close();
  else if (key === 'enter') document.activeElement?.click?.();
  else if (key === 'left' || key === 'right' || key === 'up' || key === 'down') nav.move(key);
  return true;
}
