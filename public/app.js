const form = document.querySelector('#uploadForm');
const output = document.querySelector('#result');
const btn = document.querySelector('#submitBtn');
const input = document.querySelector('#receipt');
let widgetId = null;

// En producción, asignar el site key público en /config.js (ver README).
if (window.TURNSTILE_SITE_KEY) {
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  script.async = true;
  script.defer = true;
  script.onload = () => {
    widgetId = window.turnstile.render('#turnstileContainer', { sitekey: window.TURNSTILE_SITE_KEY });
  };
  document.head.appendChild(script);
}

const dialog = document.querySelector('#accessDialog');
const pinInput = document.querySelector('#accessPin');
const accessForm = document.querySelector('#accessForm');
const accessError = document.querySelector('#accessError');
let unlocked = false;
let continueUpload = false;

async function hasSession() {
  const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) return false;
  return (await response.json()).authenticated === true;
}

accessForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  accessError.textContent = '';
  const pin = pinInput.value.trim();
  if (!/^\d{6}$/.test(pin)) {
    accessError.textContent = 'Ingresa 6 dígitos.';
    return;
  }
  const button = accessForm.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const result = await response.json();
    if (!response.ok) {
      accessError.textContent = result.message || 'No se pudo validar el código.';
      return;
    }
    unlocked = true;
    pinInput.value = '';
    dialog.close();
    if (continueUpload) {
      continueUpload = false;
      await uploadReceipt();
    }
  } catch {
    accessError.textContent = 'No fue posible conectar con el servidor.';
  } finally {
    button.disabled = false;
  }
});

dialog.addEventListener('close', () => {
  if (!unlocked) continueUpload = false;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  output.textContent = '';
  btn.disabled = true;
  try {
    if (!unlocked) unlocked = await hasSession();
    if (!unlocked) {
      continueUpload = true;
      dialog.showModal();
      pinInput.focus();
      return;
    }
    await uploadReceipt();
  } catch {
    output.className = 'error';
    output.textContent = 'No fue posible consultar la sesión.';
  } finally {
    btn.disabled = false;
  }
});

async function uploadReceipt() {
  output.textContent = '';
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    output.textContent = 'La imagen excede 5 MB.';
    return;
  }
  const data = new FormData();
  data.append('receipt', file);
  if (widgetId !== null) data.append('cf-turnstile-response', window.turnstile.getResponse(widgetId));
  btn.disabled = true;
  btn.textContent = 'Subiendo…';
  try {
    const response = await fetch('/api/receipts', { method: 'POST', body: data, credentials: 'same-origin' });
    const result = await response.json();
    if (response.status === 401) {
      unlocked = false;
      continueUpload = true;
      dialog.showModal();
      return;
    }
    output.className = response.ok ? 'ok' : 'error';
    output.textContent = result.message || 'No se pudo completar la solicitud.';
    if (response.ok) form.reset();
  } catch {
    output.className = 'error';
    output.textContent = 'Error de conexión.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enviar comprobante';
    if (widgetId !== null) window.turnstile.reset(widgetId);
  }
}
