/* Ported from demo v2 demo/app/ui.js (commit 0ff353c). Map helpers return in phase 2. */
import { labels as R } from './labels.js';

const root = globalThis;
const ui = {};
const doc = root.document;

  /* ---------- DOM ---------- */
  var PROP = { value: 1, checked: 1, disabled: 1, selected: 1, indeterminate: 1, hidden: 1, readOnly: 1 };
  function append(el, kids) {
    kids.forEach(function (k) {
      if (k === null || k === undefined || k === false || k === true) return;
      if (Array.isArray(k)) append(el, k);
      else if (k.nodeType) el.appendChild(k);
      else el.appendChild(doc.createTextNode(String(k)));
    });
  }
  /* h('div', {class:'card', on:{click:fn}, data:{x:1}}, ...con) */
  function h(tag, props) {
    var el = doc.createElement(tag), kids = [].slice.call(arguments, 2);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') Object.keys(v).forEach(function (e) { el.addEventListener(e, v[e]); });
      else if (k === 'data') Object.keys(v).forEach(function (d) { if (v[d] !== null && v[d] !== undefined) el.dataset[d] = v[d]; });
      else if (k === 'style') { if (typeof v === 'string') el.setAttribute('style', v); else Object.keys(v).forEach(function (s) { el.style.setProperty(s, v[s]); }); }
      else if (PROP[k]) el[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    append(el, kids);
    return el;
  }
  ui.h = h;
  ui.frag = function () { var f = doc.createDocumentFragment(); append(f, [].slice.call(arguments)); return f; };
  ui.clear = function (el) { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  ui.icon = function (name, cls) { return h('i', { class: 'ph ph-' + name + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' }); };

  /* ---------- Token CSS ---------- */
  var tokenCache = {};
  ui.token = function (name) {
    if (tokenCache[name]) return tokenCache[name];
    if (!doc || !doc.documentElement || !root.getComputedStyle) return '';
    try {
      var val = root.getComputedStyle(doc.documentElement).getPropertyValue(name);
      val = (val || '').trim();
      if (val) tokenCache[name] = val;
      return val;
    } catch {
      return '';
    }
  };

  /* ---------- Chế độ giao diện (Sáng / Tự động / Tối) ---------- */
  var themeMode = 'light';
  var THEME_MODES = ['light', 'auto', 'dark'];
  var theme = ui.theme = {
    modes: THEME_MODES,
    get: function () { return themeMode; },
    set: function (mode) {
      if (THEME_MODES.indexOf(mode) < 0) mode = 'light';
      themeMode = mode;
      tokenCache = {};
      var d = root.document || doc;
      if (d && d.documentElement) {
        if (mode === 'auto') {
          if (d.documentElement.removeAttribute) d.documentElement.removeAttribute('data-theme');
          else if (d.documentElement.attrs) delete d.documentElement.attrs['data-theme'];
        } else {
          if (d.documentElement.setAttribute) d.documentElement.setAttribute('data-theme', mode);
          else if (d.documentElement.attrs) d.documentElement.attrs['data-theme'] = mode;
        }
      }
      return mode;
    },
    resolved: function () {
      var m = theme.get();
      if (m === 'dark') return 'dark';
      if (m === 'light') return 'light';
      try {
        if (root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
      } catch { /* bỏ qua: trình duyệt không hỗ trợ hoặc đã gỡ */ }
      return 'light';
    },
    init: function () {
      var current = theme.get();
      theme.set(current);
      try {
        if (root.matchMedia) {
          var mql = root.matchMedia('(prefers-color-scheme: dark)');
          var onScheme = function () { tokenCache = {}; };
          if (mql.addEventListener) mql.addEventListener('change', onScheme);
          else if (mql.addListener) mql.addListener(onScheme);
        }
      } catch { /* bỏ qua: trình duyệt không hỗ trợ hoặc đã gỡ */ }
      return current;
    }
  };
  theme.init();

  /* ---------- Định dạng ---------- */
  var nf = {}, TZ = 'Asia/Ho_Chi_Minh';
  function numFmt(d) { return nf[d] || (nf[d] = new Intl.NumberFormat('vi-VN', { minimumFractionDigits: d, maximumFractionDigits: d })); }
  var dtf = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  function parts(ms) { var o = {}; dtf.formatToParts(ms).forEach(function (p) { o[p.type] = p.value; }); return o; }
  var fmt = ui.fmt = {
    num: function (n, d) { return numFmt(d || 0).format(n); },
    vnd: function (n) { return numFmt(0).format(Math.round(n)) + ' đ'; },
    ha: function (x, d) { return numFmt(d ?? 2).format(x) + ' ha'; },
    /* "3,41 ha · 2,6 công": công tầm cắt 1.296 m² mặc định, tài khoản đổi được sang 1.000 m² */
    area: function (ha, congM2) { var u = R.areaUnits(ha, congM2); return numFmt(2).format(u.ha) + ' ha · ' + numFmt(1).format(u.cong) + ' công'; },
    cong: function (ha, congM2) { return numFmt(1).format(R.areaUnits(ha, congM2).cong) + ' công'; },
    pct: function (x, d) { return numFmt(d ?? 1).format(x) + '%'; },
    date: function (iso) { var p = iso.split('-'); return p[2] + '/' + p[1]; },
    dateFull: function (iso) { var p = iso.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; },
    range: function (a, b) { return fmt.date(a) + '-' + fmt.date(b); },
    time: function (ms) { var p = parts(ms); return p.hour + ':' + p.minute; },
    dateTime: function (ms) { var p = parts(ms); return p.hour + ':' + p.minute + ' ngày ' + p.day + '/' + p.month; },
    day: function (ms) { return R.dayStr(ms); },
    /* thời gian còn lại: "còn 11 giờ 20 phút" hoặc "đã quá 2 giờ" */
    left: function (ms) {
      var over = ms < 0, a = Math.abs(ms), d = Math.floor(a / R.DAY), hh = Math.floor(a % R.DAY / R.HOUR), mm = Math.floor(a % R.HOUR / 60000);
      var t = d ? d + ' ngày ' + hh + ' giờ' : hh ? hh + ' giờ ' + mm + ' phút' : mm + ' phút';
      return (over ? 'đã quá ' : 'còn ') + t;
    },
    clock: function (ms) { return R.fmtSec(ms); },
    phone: function (s) { return s; },
    stateLabel: function (s) { return R.STATE_LABEL[s] || s; }
  };

  /* Màu trạng thái theo dữ liệu sản phẩm: đơn hủy dùng muted, ca đang làm dùng work; luôn kèm chữ */
  var STATE_TONE = { ASSIGNED: 'info', CANCELLED: 'muted' };
  var SHIFT_TONE = { RUNNING: 'work', PAUSED: 'idle', COMPLETED: 'ok' };

  /* ---------- Thành phần ---------- */
  ui.badge = function (text, tone, icon) { return h('span', { class: 'badge' + (tone ? ' badge--' + tone : '') }, icon ? ui.icon(icon) : null, text); };
  ui.stateBadge = function (state) {
    var tone = STATE_TONE[state] || 'outline';
    return ui.badge(R.STATE_LABEL[state] || state, tone);
  };
  ui.shiftBadge = function (state) { return ui.badge(R.SHIFT_LABEL[state] || state, SHIFT_TONE[state]); };

  ui.button = function (o) {
    return h(o.href ? 'a' : 'button', {
      class: 'btn btn--' + (o.kind || 'secondary') + (o.size ? ' btn--' + o.size : '') + (o.block ? ' btn--block' : ''),
      type: o.href ? null : (o.type || 'button'), href: o.href, disabled: o.disabled, title: o.title, 'aria-label': o.ariaLabel,
      on: o.onClick ? { click: o.onClick } : null
    }, o.icon ? ui.icon(o.icon) : null, o.label);
  };

  /* Hộp thoại xác nhận riêng thay window.confirm */
  ui.confirm = function (o) {
    o = o || {};
    var m;
    var cancelBtn = ui.button({
      label: o.cancelLabel || 'Bỏ qua',
      kind: 'secondary',
      onClick: function () { m.close(); }
    });
    var confirmBtn = ui.button({
      label: o.confirmLabel || 'Xác nhận',
      kind: o.tone === 'danger' ? 'danger' : 'primary',
      onClick: function () {
        m.close();
        if (o.onConfirm) o.onConfirm();
      }
    });
    var body = o.text ? h('p', null, o.text) : (o.body || null);
    m = ui.modal({
      title: o.title || 'Xác nhận',
      body: body,
      actions: [cancelBtn, confirmBtn]
    });
    return m;
  };

  /* Nút gọi FSM: call() trả về kết quả của store ({ok, reason, queued}). Bị từ chối thì hiện lý do FSM. */
  ui.actionButton = function (o) {
    var msg = h('p', { class: 'msg msg--error', role: 'alert', hidden: true }), wrap, btn;
    function runCall() {
      var r = o.call();
      if (!r) return;
      if (r.ok) {
        msg.hidden = true;
        ui.toast(r.queued ? 'Đang ngoại tuyến, thao tác chờ gửi khi có mạng' : (o.okText || 'Đã ghi nhận'), 'ok');
        if (o.onDone) o.onDone(r); else if (o.ctx) o.ctx.rerender();
      } else {
        msg.textContent = r.reason || 'Thao tác bị từ chối';
        msg.hidden = false;
        if (o.onReject) o.onReject(r);
      }
    }
    btn = ui.button({
      label: o.label,
      icon: o.icon,
      kind: o.kind || 'primary',
      size: o.size,
      block: o.block,
      disabled: o.disabled,
      onClick: function () {
        if (o.confirm) {
          var cfg = typeof o.confirm === 'string'
            ? { title: o.confirm, confirmLabel: o.label, tone: o.kind === 'danger' ? 'danger' : null }
            : o.confirm;
          ui.confirm({
            title: cfg.title || o.label,
            text: cfg.text,
            confirmLabel: cfg.confirmLabel || o.label,
            cancelLabel: cfg.cancelLabel || 'Bỏ qua',
            tone: cfg.tone || (o.kind === 'danger' ? 'danger' : null),
            onConfirm: runCall
          });
          return;
        }
        runCall();
      }
    });
    wrap = h('div', { class: 'action' + (o.block ? ' action--block' : '') }, btn, o.hint ? h('p', { class: 'small muted' }, o.hint) : null, msg);
    return wrap;
  };

  /* Thanh hành động theo hợp đồng v3: info bên trái, actions bên phải, nút chính đứng cuối */
  ui.actionBar = function (o) {
    o = o || {};
    var infoNode = null;
    if (o.info) {
      if (typeof o.info === 'string') {
        infoNode = h('div', { class: 'actionbar__info' }, o.info);
      } else if (o.info.nodeType) {
        infoNode = h('div', { class: 'actionbar__info' }, o.info);
      }
    }
    var acts = (o.actions || []).slice();
    var actsNode = h('div', { class: 'actionbar__actions btn-row' }, acts);
    var inner = h('div', { class: 'actionbar__in' }, infoNode, actsNode);
    return h('div', { class: 'actionbar' }, inner);
  };

  ui.field = function (o) {
    var id = o.id || ('f' + Math.random().toString(36).slice(2, 8)), input = o.input;
    if (input && input.setAttribute && !input.id && !o.noId) input.id = id;
    if (input && input.setAttribute && o.error && !o.noId) input.setAttribute('aria-invalid', 'true');
    return h('div', { class: 'field' + (o.error ? ' field--invalid' : '') },
      h('label', { class: 'field__label', for: id }, o.label, o.required ? ' (bắt buộc)' : ''),
      o.hint ? h('div', { class: 'field__hint' }, o.hint) : null, input,
      o.error ? h('div', { class: 'field__error', role: 'alert' }, o.error) : null);
  };
  ui.input = function (o) { o = o || {}; return h('input', { class: 'input' + (o.mono ? ' input--mono' : ''), type: o.type || 'text', name: o.name, value: o.value, inputmode: o.inputmode, autocomplete: o.autocomplete || 'off', maxlength: o.maxlength, min: o.min, max: o.max, step: o.step, readOnly: o.readOnly, disabled: o.disabled, on: o.on }); };
  ui.select = function (o) {
    var s = h('select', { class: 'select', name: o.name, disabled: o.disabled, on: o.on });
    (o.options || []).forEach(function (op) { var v = Array.isArray(op) ? op[0] : op, l = Array.isArray(op) ? op[1] : op; s.appendChild(h('option', { value: v, selected: String(v) === String(o.value) }, l)); });
    return s;
  };
  ui.textarea = function (o) { o = o || {}; return h('textarea', { class: 'textarea', name: o.name, value: o.value, rows: o.rows || 3, maxlength: o.maxlength, on: o.on }); };
  /* Ô ghi chú có nút micro (Web Speech API vi-VN). Trình duyệt không hỗ trợ thì ẩn nút. */
  ui.voiceField = function (o) {
    var id = o.id || ('v' + Math.random().toString(36).slice(2, 7)), ta = ui.textarea(o), SR = root.SpeechRecognition || root.webkitSpeechRecognition, wrap = h('div', { class: 'field__wrap' }, ta);
    ta.id = id;
    if (SR) {
      var rec = null, btn = ui.button({ icon: 'microphone', kind: 'ghost', size: 'sm', ariaLabel: 'Nói để nhập ghi chú', title: 'Nói để nhập ghi chú', onClick: function () {
        if (rec) { rec.stop(); return; }
        rec = new SR(); rec.lang = 'vi-VN'; rec.interimResults = false;
        rec.onresult = function (e) { ta.value = (ta.value ? ta.value + ' ' : '') + e.results[0][0].transcript; };
        rec.onend = function () { rec = null; btn.setAttribute('aria-pressed', 'false'); };
        btn.setAttribute('aria-pressed', 'true'); rec.start();
      } });
      btn.className += ' mic'; wrap.appendChild(btn);
    }
    return ui.field({ label: o.label, hint: o.hint, error: o.error, input: wrap, id: id, noId: true });
  };
  /* nhóm chọn một: hàng lựa chọn lớn, không dùng thẻ giống nhau thành hàng */
  ui.choices = function (o) {
    var name = o.name || ('c' + Math.random().toString(36).slice(2, 6));
    return h('div', { class: 'stack-sm', role: 'radiogroup', 'aria-label': o.label }, o.options.map(function (op) {
      return h('label', { class: 'choice' }, h('input', { type: o.multiple ? 'checkbox' : 'radio', name: name, value: op.value, checked: op.checked || String(o.value) === String(op.value), on: { change: o.onChange ? function (e) { o.onChange(op.value, e.target.checked); } : null } }),
        h('span', null, h('span', { class: 'choice__title' }, op.label), op.desc ? h('span', { class: 'choice__desc' }, op.desc) : null));
    }));
  };
  ui.yesNo = function (o) { return ui.choices({ name: o.name, label: o.label, value: o.value, onChange: o.onChange, options: [{ value: 'yes', label: 'Có' }, { value: 'no', label: 'Chưa' }] }); };
  ui.segmented = function (o) {
    var wrap = h('div', { class: 'seg', role: 'group', 'aria-label': o.label });
    o.items.forEach(function (it) { wrap.appendChild(h('button', { type: 'button', 'aria-pressed': String(it.value === o.value), on: { click: function () { o.onChange(it.value); } } }, it.label)); });
    return wrap;
  };
  ui.card = function (o) {
    o = o || {};
    return h('section', { class: 'card' + (o.tone ? ' card--tone-' + o.tone : '') + (o.flat ? ' card--flat' : ''), 'aria-label': o.ariaLabel },
      (o.title || o.actions) ? h('div', { class: 'card__head' }, h('div', null, o.title ? h('h2', null, o.title) : null, o.subtitle ? h('p', { class: 'small muted' }, o.subtitle) : null), o.actions || null) : null,
      o.body, o.children || null);
  };
  ui.kv = function (rows) { var dl = h('dl', { class: 'kv' }); rows.forEach(function (r) { if (r) { dl.appendChild(h('dt', null, r[0])); dl.appendChild(h('dd', null, r[1])); } }); return dl; };

  /* Bảng: cols [{key,label,align:'r',render:(row)=>node}]. data-label trên từng td, lớp table--stack trừ khi stack: false */
  ui.table = function (o) {
    o = o || {};
    var tb = h('tbody');
    (o.rows || []).forEach(function (row) {
      var tr = h('tr', {
        data: { click: o.onRow ? '1' : null },
        tabindex: o.onRow ? '0' : null,
        on: o.onRow ? { click: function () { o.onRow(row); }, keydown: function (e) { if (e.key === 'Enter') o.onRow(row); } } : null
      });
      (o.cols || []).forEach(function (c) {
        tr.appendChild(h('td', {
          class: c.align === 'r' ? 'r' : null,
          data: { label: c.label || '' }
        }, c.render ? c.render(row) : row[c.key]));
      });
      tb.appendChild(tr);
    });
    var stack = o.stack !== false;
    var tblCls = 'table' + (stack ? ' table--stack' : '');
    var t = h('table', { class: tblCls },
      o.caption ? h('caption', { class: 'sr-only' }, o.caption) : null,
      h('thead', null, h('tr', null, (o.cols || []).map(function (c) { return h('th', { class: c.align === 'r' ? 'r' : null, scope: 'col' }, c.label); }))),
      tb,
      o.foot ? h('tfoot', null, o.foot) : null
    );
    return h('div', { class: 'table-wrap' }, (o.rows && o.rows.length) ? t : ui.empty({ title: o.emptyTitle || 'Chưa có dữ liệu', text: o.emptyText }));
  };

  ui.list = function (items) { return h('ul', { class: 'list' }, items.map(function (i) { return h('li', null, i); })); };

  /* Ghi chú không khung: icon theo tone và chữ, tone error có role=alert */
  ui.note = function (o) {
    o = o || {};
    var icon = { info: 'info', warn: 'warning', error: 'x-circle', success: 'check-circle', offline: 'wifi-slash' }[o.tone || 'info'] || 'info';
    return h('div', { class: 'note note--' + (o.tone || 'info'), role: o.tone === 'error' ? 'alert' : null },
      ui.icon(o.icon || icon),
      h('div', { class: 'note__body' },
        o.text ? h('span', null, o.text) : null,
        o.body || null,
        o.action || null
      )
    );
  };

  /* Danh sách thông báo: sắp theo error > warn > offline > success > info. Đầu tiên là banner, còn lại là note */
  var NOTICE_LEVEL = { error: 0, warn: 1, offline: 2, success: 3, info: 4 };
  ui.notices = function (items) {
    var valid = (items || []).filter(Boolean);
    if (!valid.length) return null;
    var sorted = valid.slice().sort(function (a, b) {
      var la = NOTICE_LEVEL[a.tone || 'info'];
      var lb = NOTICE_LEVEL[b.tone || 'info'];
      return (la ?? 99) - (lb ?? 99);
    });
    var first = sorted[0];
    var rest = sorted.slice(1);
    var kids = [ui.banner(first)];
    rest.forEach(function (it) {
      var fullText = it.title ? (it.title + (it.text ? ': ' + it.text : '')) : (it.text || '');
      kids.push(ui.note({ tone: it.tone, icon: it.icon, text: fullText, body: it.body, action: it.action }));
    });
    return h('div', { class: 'notices' }, kids);
  };

  /* Dòng chọn dùng chung: control radio, checkbox hoặc none (button aria-pressed) */
  ui.pick = function (o) {
    o = o || {};
    var ctrl = o.control || 'none';
    var isRadio = ctrl === 'radio', isCheck = ctrl === 'checkbox';
    var isInput = isRadio || isCheck;
    var tag = isInput ? 'label' : 'button';
    var props = {
      class: 'pick' + (o.selected ? ' pick--on' : ' pick--off') + (o.disabled ? ' pick--disabled' : '')
    };
    var inputEl = null;
    if (isInput) {
      inputEl = h('input', {
        type: ctrl,
        name: o.name || '',
        value: o.value ?? '',
        checked: !!o.selected,
        disabled: !!o.disabled,
        on: o.onSelect ? { change: function (e) { o.onSelect(o.value, e.target.checked); } } : null
      });
    } else {
      props.type = 'button';
      props['aria-pressed'] = String(!!o.selected);
      if (o.disabled) props.disabled = true;
      if (o.onSelect) {
        props.on = {
          click: function () { if (!o.disabled) o.onSelect(o.value, !o.selected); }
        };
      }
    }
    var reasonsNode = null;
    if (o.reasons && o.reasons.length) {
      reasonsNode = h('span', { class: 'pick__reasons' }, o.reasons.map(function (r) {
        var tone = (r && r.tone) || '';
        var txt = typeof r === 'string' ? r : (r && r.text || '');
        return h('span', { class: 'pick__reason' + (tone ? ' pick__reason--' + tone : '') }, txt);
      }));
    }
    var contentNode = h('span', { class: 'pick__content' },
      h('span', { class: 'pick__title' }, o.title || ''),
      reasonsNode,
      o.meta ? h('span', { class: 'pick__meta' }, o.meta) : null
    );
    return h(tag, props,
      inputEl,
      o.icon ? ui.icon(o.icon) : null,
      contentNode,
      o.right ? h('span', { class: 'pick__right' }, o.right) : null
    );
  };

  ui.banner = function (o) {
    o = o || {};
    var icon = { info: 'info', warn: 'warning', error: 'x-circle', success: 'check-circle', offline: 'wifi-slash' }[o.tone || 'info'] || 'info';
    return h('div', { class: 'banner banner--' + (o.tone || 'info'), role: o.tone === 'error' ? 'alert' : null }, ui.icon(o.icon || icon),
      h('div', { class: 'banner__body' }, o.title ? h('div', { class: 'banner__title' }, o.title) : null, o.text ? h('div', null, o.text) : null, o.body || null, o.action || null));
  };
  ui.empty = function (o) { return h('div', { class: 'empty' }, ui.icon(o.icon || 'plant'), h('div', null, h('h3', null, o.title), o.text ? h('p', { class: 'muted' }, o.text) : null), o.action || null); };
  ui.loading = function (text) { return h('div', { class: 'stack-sm', role: 'status', 'aria-live': 'polite', data: { loading: '1' } }, h('span', { class: 'muted' }, text || 'Đang tải'), h('div', { class: 'skeleton skeleton--w70' }), h('div', { class: 'skeleton skeleton--w90' }), h('div', { class: 'skeleton skeleton--w50' })); };
  ui.errorState = function (o) { return ui.banner({ tone: 'error', title: o.title || 'Chưa tải được', text: o.text, action: o.retry ? ui.button({ label: 'Thử lại', icon: 'arrows-clockwise', onClick: o.retry }) : null }); };
  ui.progress = function (pct, label) { return h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': label || 'Tiến độ' }, h('span', { style: 'width:' + Math.max(0, Math.min(100, pct)) + '%' })); };
  /* tiến trình 5 bước của đơn (Đặt, Gom, Nhận máy, Gặt, Nghiệm thu) */
  ui.stepper = function (state) {
    var idx = R.stepIndex(state);
    return h('ol', { class: 'stepper', 'aria-label': 'Tiến trình đơn' }, R.STEPS.map(function (s, i) {
      return h('li', { data: { done: idx > i ? '1' : null }, 'aria-current': idx === i ? 'step' : null }, s);
    }));
  };
  ui.timeline = function (items) {
    return h('ol', { class: 'timeline' }, items.map(function (it) {
      return h('li', { data: { done: it.done ? '1' : null, now: it.now ? '1' : null } }, h('div', { class: 'timeline__title' }, it.title), it.meta ? h('div', { class: 'timeline__meta' }, it.meta) : null);
    }));
  };
  ui.tabs = function (o) {
    var wrap = h('div', { class: 'seg', role: 'tablist' });
    o.items.forEach(function (it) { wrap.appendChild(h('button', { type: 'button', role: 'tab', 'aria-selected': String(it.value === o.active), on: { click: function () { o.onChange(it.value); } } }, it.label)); });
    return wrap;
  };
  /* Khối có tiêu đề nhỏ, danh sách có dòng tiêu đề và dòng phụ, dòng số liệu gộp, liên kết có icon */
  ui.section = function (title) { return h('section', { class: 'stack-sm' }, title ? h('h2', null, title) : null, [].slice.call(arguments, 1)); };
  /* Dòng số liệu gộp: [[nhãn, giá trị]]. Giá trị là số hoặc chuỗi bắt đầu bằng số thì phần số dùng phông mono, phần chữ đi kèm (đơn, giả định...) giữ phông thường. Dấu chấm giữa nằm trong span riêng, khoảng cách do CSS. */
  ui.summaryLine = function (items) {
    function val(v) {
      if (v !== null && typeof v === 'object') return v;
      if (typeof v === 'number') return h('span', { class: 'num' }, String(v));
      var m = /^(-?\d[\d.,]*(?:\s?[-/]\s?\d[\d.,]*)*%?)([\s\S]*)$/.exec(String(v));
      return m ? [h('span', { class: 'num' }, m[1]), m[2]] : String(v);
    }
    return h('p', { class: 'summary-line' }, items.map(function (it, i) {
      return h('span', { class: 'summary-line__item', key: i }, i ? h('span', { class: 'summary-line__sep muted', 'aria-hidden': 'true' }, '\u00b7') : null, h('span', { class: 'muted' }, it[0] + '\u00a0'), h('strong', null, val(it[1])));
    }));
  };
  ui.link = function (label, href, icon) { return h('a', { href: href }, icon ? [ui.icon(icon), ' '] : null, label); };
  /* ui.listItem({title, meta, right, href, icon}) dùng trong ui.list */
  ui.listItem = function (o) {
    var inner = [o.icon ? ui.icon(o.icon) : null, h('div', { class: 'grow' }, h('div', { class: 'item__title' }, o.title), o.meta ? h('div', { class: 'small muted' }, o.meta) : null), o.right || null, o.href ? ui.icon('caret-right') : null];
    return o.href ? h('a', { class: 'item', href: o.href }, inner) : h('div', { class: 'row row--nowrap' }, inner);
  };
  ui.chips = function (items) { return h('div', { class: 'chips' }, items.map(function (i) { return i && i.nodeType ? i : h('span', { class: 'badge badge--outline' }, i); })); };
  ui.json = function (o) { return h('pre', null, JSON.stringify(o, null, 2)); };
  /* Đếm ngược: getLeftMs() trả số ms còn lại theo đồng hồ demo; cập nhật mỗi giây cho tới khi router dọn */
  ui.countdown = function (getLeftMs, prefix, formatter) {
    var el = h('span', { class: 'num', role: 'timer' });
    var tick = function () { el.textContent = (prefix || '') + (formatter ? formatter(getLeftMs()) : fmt.left(getLeftMs())); };
    tick(); ui._timers.push(root.setInterval(tick, 1000));
    return el;
  };
  ui.screenHead = function (o) {
    return h('div', { class: 'row row--between row--top' },
      h('div', { class: 'stack-sm' }, h('h1', null, o.title), o.sub ? h('p', { class: 'muted' }, o.sub) : null, o.badges ? ui.chips(o.badges) : null), o.actions ? h('div', { class: 'btn-row' }, o.actions) : null);
  };

  /* Hộp thoại và thông báo nhanh: bẫy tiêu điểm, khóa cuộn nền, Esc đóng, trả tiêu điểm */
  function getFocusable(container) {
    if (!container || !container.querySelectorAll) return [];
    var nodes = container.querySelectorAll(
      'button:not([disabled]):not([hidden]), [href]:not([hidden]), input:not([disabled]):not([type="hidden"]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"]):not([hidden])'
    );
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.closest && el.closest('[hidden]')) continue;
      if (el.getClientRects && el.getClientRects().length === 0) continue;
      if (root.getComputedStyle) {
        var st = root.getComputedStyle(el);
        if (st && (st.display === 'none' || st.visibility === 'hidden')) continue;
      }
      out.push(el);
    }
    return out;
  }

  ui.modal = function (o) {
    o = o || {};
    var scrim = h('div', { class: 'modal-scrim', on: { click: function (e) { if (e.target === scrim) close(); } } });
    var prev = doc.activeElement;
    var origOverflow = (doc.body && doc.body.style) ? doc.body.style.overflow : '';
    if (doc.body && doc.body.style) doc.body.style.overflow = 'hidden';

    var closed = false;
    function close(opts) {
      if (closed) return; closed = true;
      scrim.remove();
      doc.removeEventListener('keydown', onKey);
      if (doc.body && doc.body.style) doc.body.style.overflow = origOverflow;
      ui._overlays = ui._overlays.filter(function (f) { return f !== closeOverlay; });
      if ((!opts || opts.returnFocus !== false) && prev && prev.focus && (!doc.contains || doc.contains(prev))) prev.focus();
      if (o.onClose) o.onClose();
    }
    function closeOverlay() { close({ returnFocus: false }); }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'Tab') {
        var focusables = getFocusable(m);
        if (!focusables.length) { e.preventDefault(); if (m.focus) m.focus(); return; }
        var first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (doc.activeElement === first || !m.contains(doc.activeElement)) { e.preventDefault(); last.focus(); }
        } else {
          if (doc.activeElement === last || !m.contains(doc.activeElement)) { e.preventDefault(); first.focus(); }
        }
      }
    }

    var defaultActs = [ui.button({ label: 'Đóng', onClick: function () { close(); } })];
    var acts = (o.actions && o.actions.length) ? o.actions : defaultActs;
    var m = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || '', tabindex: '-1' },
      o.title ? h('h2', null, o.title) : null,
      o.body || null,
      h('div', { class: 'btn-row' }, acts)
    );
    scrim.appendChild(m);
    if (doc.body) doc.body.appendChild(scrim);
    doc.addEventListener('keydown', onKey);
    ui._overlays.push(closeOverlay);
    var firstFocus = getFocusable(m)[0];
    if (firstFocus && firstFocus.focus) firstFocus.focus();
    else if (m.focus) m.focus();
    return { close: close, el: m };
  };

  /* Bảng trượt đáy dùng chung (nút Thêm điều hướng) */
  ui.sheet = function (o) {
    o = o || {};
    var scrim = h('div', { class: 'sheet-scrim', on: { click: function (e) { if (e.target === scrim) close(); } } });
    var prev = doc.activeElement;
    var origOverflow = (doc.body && doc.body.style) ? doc.body.style.overflow : '';
    if (doc.body && doc.body.style) doc.body.style.overflow = 'hidden';

    var closed = false;
    function close(opts) {
      if (closed) return; closed = true;
      scrim.remove();
      doc.removeEventListener('keydown', onKey);
      if (doc.body && doc.body.style) doc.body.style.overflow = origOverflow;
      ui._overlays = ui._overlays.filter(function (f) { return f !== closeOverlay; });
      if ((!opts || opts.returnFocus !== false) && prev && prev.focus && (!doc.contains || doc.contains(prev))) prev.focus();
      if (o.onClose) o.onClose();
    }
    function closeOverlay() { close({ returnFocus: false }); }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'Tab') {
        var focusables = getFocusable(sh);
        if (!focusables.length) { e.preventDefault(); if (sh.focus) sh.focus(); return; }
        var first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey) {
          if (doc.activeElement === first || !sh.contains(doc.activeElement)) { e.preventDefault(); last.focus(); }
        } else {
          if (doc.activeElement === last || !sh.contains(doc.activeElement)) { e.preventDefault(); first.focus(); }
        }
      }
    }

    var head = h('div', { class: 'sheet__head' },
      h('h2', null, o.title || ''),
      ui.button({ icon: 'x', kind: 'ghost', ariaLabel: 'Đóng bảng', onClick: function () { close(); } })
    );
    var sh = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || '', tabindex: '-1' },
      head,
      h('div', { class: 'sheet__body' }, o.body || null)
    );
    scrim.appendChild(sh);
    if (doc.body) doc.body.appendChild(scrim);
    doc.addEventListener('keydown', onKey);
    ui._overlays.push(closeOverlay);
    var firstFocus = getFocusable(sh)[0];
    if (firstFocus && firstFocus.focus) firstFocus.focus();
    else if (sh.focus) sh.focus();
    return { close: close, el: sh };
  };

  ui.toast = function (text, kind) {
    var box = doc.getElementById('toasts');
    if (!box) {
      box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite', 'aria-atomic': 'true' });
      if (doc.body) doc.body.appendChild(box);
    }
    while (box.firstChild) box.removeChild(box.firstChild);
    var tone = (kind === 'error' || kind === 'err') ? 'error' : (kind === 'warn' ? 'warn' : '');
    var t = h('div', { class: 'toast' + (tone ? ' toast--' + tone : ''), role: tone === 'error' ? 'alert' : 'status' },
      h('span', { class: 'toast__text' }, text),
      h('button', {
        type: 'button',
        class: 'toast__close',
        'aria-label': 'Đóng thông báo',
        on: { click: function () { if (t.parentNode) t.parentNode.removeChild(t); } }
      }, ui.icon('x'))
    );
    box.appendChild(t);
    root.setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3500);
  };

  /* ---------- Khung ứng dụng ---------- */
  /* Giữ khoảng đệm đáy dựa trên độ cao thật của thanh hành động, tabbar và demo-strip */
  ui.bindReserve = function (appNode) {
    if (!doc || !appNode) return;
    var ro = null, mo = null, lastReserve = -1, lastTabH = -1, lastTopH = -1, lastToastTop = -1, lastToastBottom = -1;
    var scheduled = false;

    function clearProp(el, name) {
      if (!el || !el.style) return;
      if (typeof el.style.removeProperty === 'function') el.style.removeProperty(name);
      else if (typeof el.style.setProperty === 'function') el.style.setProperty(name, '');
    }

    function setProp(el, name, val) {
      if (!el || !el.style || typeof el.style.setProperty !== 'function') return;
      el.style.setProperty(name, val);
    }

    function measure() {
      scheduled = false;
      if (doc.contains && !doc.contains(appNode)) return;
      if (typeof root.getComputedStyle !== 'function') return;

      var hdr = appNode.querySelector ? appNode.querySelector('.topbar:not([hidden]), .mbar:not([hidden])') : null;
      if (hdr && hdr.getBoundingClientRect) {
        var hdrStyle = root.getComputedStyle(hdr);
        if (hdrStyle && hdrStyle.display !== 'none') {
          var hr = hdr.getBoundingClientRect();
          var hh = Math.round(hr.height);
          var tTop = Math.max(0, Math.ceil(hr.bottom));
          if (hh > 0 && hh !== lastTopH) {
            lastTopH = hh;
            setProp(appNode, '--topbar-h', hh + 'px');
          }
          if (tTop !== lastToastTop) {
            lastToastTop = tTop;
            setProp(doc.documentElement, '--toast-top', tTop + 'px');
          }
        }
      } else {
        if (lastTopH !== -1) {
          lastTopH = -1;
          clearProp(appNode, '--topbar-h');
        }
        if (lastToastTop !== -1) {
          lastToastTop = -1;
          clearProp(doc.documentElement, '--toast-top');
        }
      }

      var ab = appNode.querySelector ? appNode.querySelector('.actionbar:not([hidden])') : null;
      var abIn = ab ? (ab.querySelector ? (ab.querySelector('.actionbar__in') || ab) : ab) : null;
      var tab = appNode.querySelector ? appNode.querySelector('.tabbar:not([hidden]), .tabbar--narrow:not([hidden])') : null;
      var vh = root.innerHeight || (doc.documentElement && doc.documentElement.clientHeight) || 0;

      var isTabFixed = false;
      if (tab) {
        var tabStyle = root.getComputedStyle(tab);
        isTabFixed = tabStyle && tabStyle.position === 'fixed' && tabStyle.display !== 'none';
        if (isTabFixed && tab.getBoundingClientRect) {
          var tr = tab.getBoundingClientRect();
          var th = Math.round(tr.height);
          if (th > 0 && th !== lastTabH) {
            lastTabH = th;
            setProp(appNode, '--tabbar-h', th + 'px');
          }
        } else if (lastTabH !== -1) {
          lastTabH = -1;
          clearProp(appNode, '--tabbar-h');
        }
      } else if (lastTabH !== -1) {
        lastTabH = -1;
        clearProp(appNode, '--tabbar-h');
      }

      var topMost = vh;
      var hasFixed = false;

      if (ab) {
        var abStyle = root.getComputedStyle(ab);
        if (abStyle && abStyle.position === 'fixed' && abStyle.display !== 'none' && ab.getBoundingClientRect) {
          var abr = ab.getBoundingClientRect();
          var inr = abIn && abIn !== ab && abIn.getBoundingClientRect ? abIn.getBoundingClientRect() : abr;
          var abTop = Math.min(abr.top, inr.top);
          var abH = Math.max(abr.height, inr.height);
          if (abH > 0 && abTop < topMost) {
            topMost = abTop;
            hasFixed = true;
          }
        }
      }

      if (isTabFixed && tab && tab.getBoundingClientRect) {
        var tabr = tab.getBoundingClientRect();
        if (tabr.height > 0 && tabr.top < topMost) {
          topMost = tabr.top;
          hasFixed = true;
        }
      }

      var obstacle = hasFixed ? Math.max(0, Math.ceil(vh - topMost)) : 0;
      var reserve = obstacle > 0 ? Math.ceil((obstacle + 16) / 4) * 4 : 0;

      if (reserve !== lastReserve) {
        lastReserve = reserve;
        if (reserve > 0) setProp(appNode, '--bottom-reserve', reserve + 'px');
        else clearProp(appNode, '--bottom-reserve');
      }

      if (obstacle !== lastToastBottom) {
        lastToastBottom = obstacle;
        if (obstacle > 0) setProp(doc.documentElement, '--toast-bottom', obstacle + 'px');
        else clearProp(doc.documentElement, '--toast-bottom');
      }
    }

    function scheduleMeasure() {
      if (scheduled) return;
      scheduled = true;
      if (typeof root.requestAnimationFrame === 'function') {
        root.requestAnimationFrame(measure);
      } else {
        root.setTimeout(measure, 0);
      }
    }

    function observeTargets() {
      if (!ro) return;
      try { ro.disconnect(); } catch { /* bỏ qua: trình duyệt không hỗ trợ hoặc đã gỡ */ }
      try {
        ro.observe(appNode);
        var hdr = appNode.querySelector ? appNode.querySelector('.topbar, .mbar') : null;
        if (hdr) ro.observe(hdr);
        var ab = appNode.querySelector ? appNode.querySelector('.actionbar') : null;
        if (ab) {
          ro.observe(ab);
          var abIn = ab.querySelector ? ab.querySelector('.actionbar__in') : null;
          if (abIn) ro.observe(abIn);
        }
        var tab = appNode.querySelector ? appNode.querySelector('.tabbar, .tabbar--narrow') : null;
        if (tab) ro.observe(tab);
      } catch { /* bỏ qua: trình duyệt không hỗ trợ hoặc đã gỡ */ }
    }

    if (typeof root.ResizeObserver === 'function') {
      try {
        ro = new root.ResizeObserver(function () {
          scheduleMeasure();
        });
        observeTargets();
      } catch { /* bỏ qua: trình duyệt không hỗ trợ hoặc đã gỡ */ }
    }

    if (typeof root.MutationObserver === 'function') {
      try {
        mo = new root.MutationObserver(function () {
          observeTargets();
          scheduleMeasure();
        });
        mo.observe(appNode, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
      } catch { /* bỏ qua: trình duyệt không hỗ trợ hoặc đã gỡ */ }
    }

    var onResize = function () {
      scheduleMeasure();
    };
    if (root.addEventListener) {
      root.addEventListener('resize', onResize);
    }

    if (doc && doc.fonts && doc.fonts.ready && typeof doc.fonts.ready.then === 'function') {
      doc.fonts.ready.then(scheduleMeasure);
    }

    ui._cleanups.push(function () {
      if (ro) { try { ro.disconnect(); } catch { /* bỏ qua: trình duyệt không hỗ trợ hoặc đã gỡ */ } }
      if (mo) { try { mo.disconnect(); } catch { /* bỏ qua: trình duyệt không hỗ trợ hoặc đã gỡ */ } }
      if (root.removeEventListener) { root.removeEventListener('resize', onResize); }
      clearProp(doc.documentElement, '--toast-top');
      clearProp(doc.documentElement, '--toast-bottom');
    });

    scheduleMeasure();
  };

  function buildTabbar(items, cls, moreId) {
    if (!items || !items.length) return { nav: null, scrim: null };
    var tabItems;
    var moreScrim = null;

    if (items.length <= 5) {
      tabItems = items.map(function (n) {
        return h('a', { href: n.href, 'aria-current': n.current ? 'page' : null }, ui.icon(n.icon), h('span', { class: 'tabbar__label' }, n.label));
      });
    } else {
      var firstFour = items.slice(0, 4);
      var moreItems = items.slice(4);
      var inMore = moreItems.some(function (n) { return n.current; });

      tabItems = firstFour.map(function (n) {
        return h('a', { href: n.href, 'aria-current': n.current ? 'page' : null }, ui.icon(n.icon), h('span', { class: 'tabbar__label' }, n.label));
      });

      var moreBtn = h('button', {
        type: 'button',
        class: 'tabbar__more',
        'aria-controls': moreId,
        'aria-expanded': 'false',
        'aria-current': inMore ? 'page' : null,
        on: { click: function () { openMore(); } }
      }, ui.icon('dots-three'), h('span', { class: 'tabbar__label' }, 'Thêm'));
      tabItems.push(moreBtn);

      var origOverflow = '';
      var isOpen = false;
      function closeOverlay() { closeMore(false); }

      function openMore() {
        if (!moreScrim || isOpen) return;
        isOpen = true;
        moreScrim.hidden = false;
        moreScrim.removeAttribute('hidden');
        moreBtn.setAttribute('aria-expanded', 'true');
        if (doc.body && doc.body.style) { origOverflow = doc.body.style.overflow; doc.body.style.overflow = 'hidden'; }
        doc.addEventListener('keydown', onMoreKey);
        if (ui._overlays.indexOf(closeOverlay) < 0) ui._overlays.push(closeOverlay);
        var sheetEl = moreScrim.querySelector ? moreScrim.querySelector('.sheet') : null;
        var first = getFocusable(moreScrim)[0];
        if (first && first.focus) first.focus();
        else if (sheetEl && sheetEl.focus) sheetEl.focus();
      }

      function closeMore(returnFocus) {
        if (!moreScrim || !isOpen) return;
        isOpen = false;
        moreScrim.hidden = true;
        moreScrim.setAttribute('hidden', '');
        moreBtn.setAttribute('aria-expanded', 'false');
        if (doc.body && doc.body.style) doc.body.style.overflow = origOverflow;
        doc.removeEventListener('keydown', onMoreKey);
        ui._overlays = ui._overlays.filter(function (f) { return f !== closeOverlay; });
        if (returnFocus !== false && moreBtn && moreBtn.focus && (!doc.contains || doc.contains(moreBtn))) moreBtn.focus();
      }

      function onMoreKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeMore(true);
          return;
        }
        if (e.key === 'Tab') {
          var focusables = getFocusable(moreScrim);
          var sheetEl = moreScrim.querySelector ? moreScrim.querySelector('.sheet') : null;
          if (!focusables.length) { e.preventDefault(); if (sheetEl && sheetEl.focus) sheetEl.focus(); return; }
          var f = focusables[0], l = focusables[focusables.length - 1];
          if (e.shiftKey) {
            if (doc.activeElement === f || !moreScrim.contains(doc.activeElement)) { e.preventDefault(); l.focus(); }
          } else {
            if (doc.activeElement === l || !moreScrim.contains(doc.activeElement)) { e.preventDefault(); f.focus(); }
          }
        }
      }

      ui._cleanups.push(function () {
        closeMore(false);
      });

      var moreLinks = moreItems.map(function (n) {
        return h('a', {
          class: 'sheet__item',
          href: n.href,
          'aria-current': n.current ? 'page' : null,
          on: { click: function () { closeMore(false); } }
        }, n.icon ? ui.icon(n.icon) : null, n.label);
      });

      moreScrim = h('div', {
        id: moreId,
        class: 'sheet-scrim',
        hidden: true,
        on: { click: function (e) { if (e.target === moreScrim) closeMore(true); } }
      },
        h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Thêm', tabindex: '-1' },
          h('div', { class: 'sheet__head' },
            h('h3', null, 'Thêm'),
            ui.button({ icon: 'x', kind: 'ghost', ariaLabel: 'Đóng bảng', onClick: function () { closeMore(true); } })
          ),
          h('div', { class: 'sheet__body' }, moreLinks)
        )
      );
    }

    var nav = h('nav', { class: cls, 'aria-label': 'Điều hướng chính' },
      h('div', { class: 'tabbar__in' }, tabItems)
    );
    return { nav: nav, scrim: moreScrim };
  }

  /* Khung di động: thanh tiêu đề, nội dung, tab dưới hoặc thanh hành động. o: {title, back:{href,label}, tabs:[{label,icon,href,current}], body, offline, action, isRoot} */
  ui.mobileFrame = function (o) {
    o = o || {};
    var showTabs = !!(o.tabs && o.tabs.length) && !(o.action && !o.isRoot);
    var actionNode = o.action || null;
    if (actionNode && showTabs) {
      actionNode.className = (actionNode.className || '') + ' actionbar--above-tab';
    }
    var tabBuilt = showTabs ? buildTabbar(o.tabs, 'tabbar', 'mobile-more-nav') : { nav: null, scrim: null };
    var appCls = 'app app--mobile role-mobile' + (o.action ? ' app--has-action' : '') + (showTabs ? ' app--has-tab' : '');
    var appNode = h('div', { class: appCls },
      h('div', { class: 'app__shell' },
        h('header', { class: 'mbar' }, o.back ? h('a', { class: 'btn btn--ghost', href: o.back.href, 'aria-label': o.back.label || 'Quay lại' }, ui.icon('arrow-left')) : null, h('h1', null, o.title)),
        o.offline ? ui.offlineBar(o.offline) : null,
        h('main', { class: 'mbody', id: 'main', tabindex: '-1' }, o.body)),
      actionNode,
      tabBuilt.nav,
      tabBuilt.scrim);
    ui.bindReserve(appNode);
    return appNode;
  };

  /* Khung máy tính thích ứng: điều hướng trên, tab dưới dựng sẵn khi hẹp, bảng trượt nút Thêm. o: {size:'tablet'|'desk', brand, nav:[{label,icon,href,current}], who, body, offline, narrow, action, isRoot, back} */
  ui.deskFrame = function (o) {
    o = o || {};
    var navList = o.nav || [];
    var showNarrowTab = navList.length > 0 && !(o.action && !o.isRoot);
    var actionNode = o.action || null;
    if (actionNode && showNarrowTab) {
      actionNode.className = (actionNode.className || '') + ' actionbar--above-tab';
    }

    var tabBuilt = showNarrowTab ? buildTabbar(navList, 'tabbar tabbar--narrow', 'desk-more-nav') : { nav: null, scrim: null };

    var backNode = (o.back && !o.isRoot)
      ? h('a', { class: 'btn btn--ghost topbar__back', href: o.back.href, 'aria-label': o.back.label || 'Quay lại' }, ui.icon('arrow-left'), o.back.label || 'Quay lại')
      : null;

    var appCls = 'app app--desk role-' + (o.size || 'desk') + (o.action ? ' app--has-action' : '') + (showNarrowTab ? ' app--has-tab' : '');

    var appNode = h('div', { class: appCls },
      h('header', { class: 'topbar' }, h('div', { class: 'topbar__in' },
        backNode,
        h('div', { class: 'brand' }, ui.icon('plant'), o.brand || 'AgriDispatch'),
        navList.length ? h('nav', { class: 'nav', 'aria-label': 'Điều hướng chính' }, navList.map(function (n) { return h('a', { href: n.href, 'aria-current': n.current ? 'page' : null }, n.icon ? ui.icon(n.icon) : null, n.label); })) : h('div', { class: 'grow' }),
        o.who ? h('div', { class: 'topbar__who' }, o.who) : null)),
      o.offline ? ui.offlineBar(o.offline) : null,
      h('main', { class: 'wrap' + (o.narrow ? ' wrap--narrow' : ''), id: 'main', tabindex: '-1' },
        h('div', { class: 'stack' }, o.body, actionNode)),
      tabBuilt.nav,
      tabBuilt.scrim);
    ui.bindReserve(appNode);
    return appNode;
  };
  ui.offlineBar = function () { return h('div', { class: 'offline-bar', role: 'status' }, ui.icon('wifi-slash'), 'Mất kết nối mạng. Thao tác chưa được gửi; thử lại khi có mạng.'); };

  ui._timers = []; ui._cleanups = []; ui._overlays = [];
  /* Hộp thoại và bảng trượt sống qua các lần vẽ lại màn; router gọi hàm này khi đổi đường dẫn */
  ui.closeOverlays = function () { ui._overlays.slice().forEach(function (f) { try { f(); } catch { /* đã đóng */ } }); };
  ui.dispose = function () {
    ui._timers.forEach(function (t) { root.clearInterval(t); root.clearTimeout(t); });
    ui._timers = [];
    ui._cleanups.forEach(function (fn) { try { fn(); } catch { /* bỏ qua: trình duyệt không hỗ trợ hoặc đã gỡ */ } });
    ui._cleanups = [];
  };

export { ui };
