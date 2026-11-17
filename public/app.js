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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
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
    const response = await fetch('/api/receipts', { method: 'POST', body: data });
    const result = await response.json();
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
});
