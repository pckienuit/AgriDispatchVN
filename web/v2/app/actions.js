// Product-only helpers on top of the demo kit: async API actions and error text. Demo actions were synchronous store calls.
import { ApiError, messageForError } from '../../api.js';
import { ui } from '../kit/ui.js';

const h = ui.h;

const V2_MESSAGES = {
  INVALID_CREDENTIALS: 'Số điện thoại hoặc mật khẩu không đúng.',
  CONFLICT: 'Số điện thoại này đã có tài khoản. Hãy đăng nhập.',
  FORBIDDEN: 'Tài khoản này không có quyền làm thao tác này.',
  INVALID_STATE: 'Trạng thái đã đổi. Tải lại để xem tình hình mới nhất.',
  VERSION_CONFLICT: 'Nội dung vừa được người khác cập nhật. Tải lại rồi thử lại.',
};

export function errorText(error) {
  if (error instanceof ApiError && Object.hasOwn(V2_MESSAGES, error.code)) return V2_MESSAGES[error.code];
  return messageForError(error);
}

// Button that runs an API call. Disabled while pending so a double tap cannot send twice; shows the server's
// reason inline when refused. o: { label, icon, kind, size, block, confirm, run: async () => any, okText, onDone, hint }
export function apiButton(o) {
  const msg = h('p', { class: 'msg msg--error', role: 'alert', tabindex: '-1', hidden: true });
  let busy = false;
  const btn = ui.button({ label: o.label, icon: o.icon, kind: o.kind || 'primary', size: o.size, block: o.block, disabled: o.disabled, onClick: () => { if (!busy) (o.confirm ? ask() : go()); } });
  async function go() {
    if (busy) return;
    busy = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.setAttribute('aria-busy', 'true');
    msg.hidden = true;
    try {
      const result = await o.run();
      if (o.okText) ui.toast(o.okText, 'ok');
      if (o.onDone) await o.onDone(result);
    } catch (error) {
      msg.textContent = errorText(error);
      msg.hidden = false;
      msg.focus?.();
    } finally {
      busy = false;
      if (btn.isConnected) {
        if (!o.disabled) btn.removeAttribute('aria-disabled');
        btn.removeAttribute('aria-busy');
      }
    }
  }
  function ask() {
    const cfg = typeof o.confirm === 'string' ? { title: o.confirm } : o.confirm;
    ui.confirm({ title: cfg.title, text: cfg.text, confirmLabel: cfg.confirmLabel || o.label, tone: o.kind === 'danger' ? 'danger' : cfg.tone, onConfirm: go });
  }
  return h('div', { class: 'action' + (o.block ? ' action--block' : '') }, btn, o.hint ? h('p', { class: 'small muted' }, o.hint) : null, msg);
}

// Form submit wrapper with the same busy and error handling. Returns the form element.
export function apiForm({ fields, submitLabel, run, onDone, className = 'stack', submitKind = 'primary' }) {
  const msg = h('p', { class: 'msg msg--error', role: 'alert', tabindex: '-1', hidden: true });
  const submit = h('button', { class: `btn btn--${submitKind} btn--lg btn--block`, type: 'submit' }, submitLabel);
  let busy = false;
  const form = h('form', { class: className, novalidate: true, on: { submit: async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    submit.setAttribute('aria-disabled', 'true');
    submit.setAttribute('aria-busy', 'true');
    msg.hidden = true;
    try {
      const result = await run(new globalThis.FormData(form));
      if (onDone) await onDone(result);
    } catch (error) {
      msg.textContent = error instanceof ApiError ? errorText(error) : String(error?.message || error);
      msg.hidden = false;
      msg.focus?.();
    } finally {
      busy = false;
      if (submit.isConnected) {
        submit.removeAttribute('aria-disabled');
        submit.removeAttribute('aria-busy');
      }
    }
  } } }, fields, msg, submit);
  return form;
}

// Visible label for synthetic or assumed numbers, as required by the data-integrity rule.
export function assumedBadge(text = 'Giả định') {
  return ui.badge(text, 'outline', 'flask');
}
