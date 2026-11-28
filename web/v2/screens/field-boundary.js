import { ApiError } from '../../api.js';
import { apiButton, apiForm } from '../app/actions.js';
import { ui } from '../kit/ui.js';

const { h } = ui;
const consentPath = '/api/location-consent';
const maxVertices = 100;
const minVertices = 3;
const decimal = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const pointPattern = new RegExp(`^(${decimal})\\s*,\\s*(${decimal})$`);
const SVG_NS = 'http://www.w3.org/2000/svg';
const frame = { w: 220, h: 168, cx: 110, cy: 84, box: 144 };
// About 1 m per arrow press in latitude; Shift moves ten times as far.
const NUDGE = 0.00001;
const KEY_DELTA = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

export function parseVertices(value) {
  const lines = value.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < minVertices || lines.length > maxVertices) throw new Error('Nhập từ 3 đến 100 đỉnh ranh.');
  return lines.map((line, i) => {
    const match = pointPattern.exec(line);
    if (!match) throw new Error(`Dòng ${i + 1}: nhập kinh độ, vĩ độ; dùng dấu chấm cho phần thập phân.`);
    const point = [Number(match[1]), Number(match[2])];
    if (Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) throw new Error(`Dòng ${i + 1}: tọa độ vượt phạm vi.`);
    return point;
  });
}

// Fixed 7 decimals (about 1 cm) keep the text parseable by parseVertices; exponent notation never appears.
export const formatPoint = ([lon, lat]) => `${lon.toFixed(7)}, ${lat.toFixed(7)}`;

export const clampPoint = ([lon, lat]) => [Math.min(180, Math.max(-180, lon)), Math.min(90, Math.max(-90, lat))];
const roundPoint = ([lon, lat]) => [Number(lon.toFixed(7)), Number(lat.toFixed(7))];

// Schematic fit only: centre the ring and scale longitude by cos(lat) so the shape keeps its proportions.
// A minimum extent keeps a very small ring readable.
export function fit(points) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const lonScale = Math.cos(cy * Math.PI / 180);
  const extent = Math.max((maxX - minX) * lonScale, maxY - minY, 0.0002);
  return { cx, cy, lonScale, scale: frame.box / extent };
}

export const toSvg = (t, [lon, lat]) => [frame.cx + (lon - t.cx) * t.lonScale * t.scale, frame.cy - (lat - t.cy) * t.scale];
export const toGeo = (t, [x, y]) => [t.cx + (x - frame.cx) / (t.lonScale * t.scale), t.cy - (y - frame.cy) / t.scale];

// Pure keyboard step: returns the moved point rounded to stored precision, or null for keys that do not move.
export function nudgePoint(point, key, { shift = false } = {}) {
  const dir = KEY_DELTA[key];
  if (!dir) return null;
  const step = NUDGE * (shift ? 10 : 1);
  return roundPoint(clampPoint([point[0] + dir[0] * step, point[1] + dir[1] * step]));
}

function readVertices(text) {
  try {
    return parseVertices(text);
  } catch {
    return null;
  }
}

function svgEl(tag, attrs = {}) {
  const el = globalThis.document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

function consentCard(ctx) {
  return ui.card({ title: 'Ranh thửa (tùy chọn)', body: h('div', { class: 'stack-sm' },
    h('p', null, 'Đồng ý để lưu tọa độ chính xác của các thửa trong tài khoản này. Bạn vẫn dùng được diện tích nhập tay nếu không đồng ý.'),
    apiButton({ label: 'Đồng ý lưu tọa độ', kind: 'secondary',
      run: () => ctx.api.request('POST', consentPath, { auth: true, body: { consent: true, version: 'field-boundary-v1' } }),
      onDone: () => ctx.rerender(),
    })) });
}

// ponytail: schematic only, no basemap, no neighbour overlap check, no HTX-drawn ring.
// Add when a licensed background tile source, overlap policy and HTX drawing flow exist.
export function boundaryEditor(ctx, path, details) {
  if (!details.locationConsent) return consentCard(ctx);

  const saved = (details.coordinates ?? []).slice(0, -1);
  const savedText = saved.map(formatPoint).join('\n');
  const state = { points: saved, selected: 0, t: fit(saved.length >= minVertices ? saved : [[0, 0], [0, 0.0001], [0.0001, 0]]) };
  let drag = null;

  const input = ui.textarea({ name: 'boundary', rows: 5, maxlength: 4800, value: savedText });
  const svg = svgEl('svg', { viewBox: `0 0 ${frame.w} ${frame.h}`, class: 'farmer-boundary-outline', role: 'group' });
  const ring = svgEl('polygon');
  svg.append(ring);
  const dots = [];
  const canvas = h('div', { class: 'farmer-boundary__canvas' }, svg);
  const hint = h('p', { class: 'small muted' }, 'Nhập ít nhất 3 đỉnh để xem sơ đồ.');
  const live = h('p', { class: 'small muted', 'aria-live': 'polite' });
  const dirtyNote = ui.note({ tone: 'warn', text: 'Có thay đổi chưa lưu. Khi lưu ranh, diện tích của thửa sẽ được thay bằng diện tích tính từ ranh, và giá đơn sau này dùng diện tích đó.' });
  dirtyNote.hidden = true;
  const removeBtn = ui.button({ label: 'Xóa đỉnh đang chọn', kind: 'secondary', icon: 'x', onClick: () => removeAt(state.selected) });
  const help = h('p', { class: 'small muted', id: 'boundary-help' }, 'Bấm một đỉnh trên sơ đồ, rồi dùng phím mũi tên để dời khoảng 1 m (giữ Shift để dời 10 m). Delete xóa đỉnh đang chọn. Có thể kéo đỉnh bằng chuột hoặc ngón tay.');
  svg.setAttribute('aria-describedby', 'boundary-help');

  const vertexLabel = (i) => {
    const [lon, lat] = state.points[i];
    return `Đỉnh ${i + 1} trong ${state.points.length}: kinh độ ${lon.toFixed(7)}, vĩ độ ${lat.toFixed(7)}`;
  };
  const isDirty = () => input.value.trim() !== savedText.trim();

  function syncText() {
    input.value = state.points.map(formatPoint).join('\n');
    dirtyNote.hidden = !isDirty();
  }

  function makeDot() {
    const dot = svgEl('circle', { r: 6, tabindex: 0, role: 'button', class: 'farmer-boundary-vertex' });
    dot.addEventListener('keydown', onKey);
    dot.addEventListener('pointerdown', onDown);
    dot.addEventListener('pointermove', onMove);
    dot.addEventListener('pointerup', onUp);
    dot.addEventListener('pointercancel', onUp);
    dot.addEventListener('focus', () => { state.selected = Number(dot.getAttribute('data-i')); });
    svg.append(dot);
    return dot;
  }

  // refit=false keeps the transform fixed while dragging so the vertex follows the pointer.
  function draw({ refit = true } = {}) {
    const n = state.points.length;
    if (refit && n >= minVertices) state.t = fit(state.points);
    canvas.hidden = n < minVertices;
    hint.hidden = n >= minVertices;
    removeBtn.disabled = n <= minVertices;
    while (dots.length < n) dots.push(makeDot());
    while (dots.length > n) dots.pop().remove();
    dots.forEach((dot, i) => dot.setAttribute('data-i', i));
    if (n < minVertices) return;
    const pts = state.points.map((p) => toSvg(state.t, p));
    ring.setAttribute('points', pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '));
    dots.forEach((dot, i) => {
      dot.setAttribute('cx', pts[i][0].toFixed(2));
      dot.setAttribute('cy', pts[i][1].toFixed(2));
      dot.setAttribute('aria-label', vertexLabel(i));
    });
    svg.setAttribute('aria-label', `Sơ đồ ranh thửa minh họa, ${n} đỉnh, không có bản đồ nền`);
  }

  function moveTo(i, point) {
    state.points[i] = point;
    state.selected = i;
    draw();
    syncText();
    announce(vertexLabel(i));
  }

  function removeAt(i) {
    if (state.points.length <= minVertices) return;
    state.points.splice(i, 1);
    state.selected = Math.min(i, state.points.length - 1);
    draw();
    syncText();
    dots[state.selected]?.focus();
    announce(`Đã xóa đỉnh ${i + 1}. Còn ${state.points.length} đỉnh.`);
  }

  function announce(text) { live.textContent = text; }

  function onKey(event) {
    const i = Number(event.currentTarget.getAttribute('data-i'));
    if (KEY_DELTA[event.key]) {
      event.preventDefault();
      moveTo(i, nudgePoint(state.points[i], event.key, { shift: event.shiftKey }));
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && state.points.length > minVertices) {
      event.preventDefault();
      removeAt(i);
    }
  }

  function onDown(event) {
    const i = Number(event.currentTarget.getAttribute('data-i'));
    drag = { i, id: event.pointerId, x: event.clientX, y: event.clientY, p: state.points[i], t: state.t, width: svg.getBoundingClientRect().width };
    event.currentTarget.setPointerCapture(event.pointerId);
    state.selected = i;
    event.currentTarget.focus({ preventScroll: true });
    event.preventDefault();
  }

  function onMove(event) {
    if (!drag || event.pointerId !== drag.id || !drag.width) return;
    const k = frame.w / drag.width;
    const [sx, sy] = toSvg(drag.t, drag.p);
    state.points[drag.i] = roundPoint(clampPoint(toGeo(drag.t, [sx + (event.clientX - drag.x) * k, sy + (event.clientY - drag.y) * k])));
    draw({ refit: false });
  }

  function onUp(event) {
    if (!drag || event.pointerId !== drag.id) return;
    const i = drag.i;
    drag = null;
    draw();
    syncText();
    announce(vertexLabel(i));
  }

  input.addEventListener('input', () => {
    const parsed = readVertices(input.value);
    if (parsed) {
      state.points = parsed;
      draw();
    }
    dirtyNote.hidden = !isDirty();
  });

  draw();

  const notice = ui.note({ tone: 'info', text: 'Sơ đồ chỉ vẽ lại hình dạng từ tọa độ bạn nhập. Không có ảnh vệ tinh hoặc bản đồ nền, chưa kiểm tra chồng lấn với thửa khác, và HTX chưa vẽ hộ.' });
  const figure = h('figure', { class: 'farmer-boundary' },
    canvas,
    hint,
    saved.length >= minVertices ? h('figcaption', null,
      h('strong', null, `Diện tích tính từ ranh: ${ui.fmt.num(details.areaM2)} m².`),
      h('p', { class: 'small muted' }, 'Ước tính từ tọa độ, không thay đo đạc địa chính.')) : null);

  return ui.card({ title: 'Ranh thửa (tùy chọn)', body: h('div', { class: 'stack' },
    notice,
    figure,
    h('div', { class: 'stack-sm' }, help, live, h('div', { class: 'btn-row' }, removeBtn)),
    apiForm({
      fields: [ui.field({ label: 'Tọa độ các đỉnh ranh', input,
        hint: 'Mỗi dòng một cặp kinh độ, vĩ độ. Dùng dấu chấm cho phần thập phân; không cần lặp lại đỉnh đầu.' }), dirtyNote],
      submitLabel: 'Lưu ranh thửa',
      async run(data) {
        const vertices = parseVertices(String(data.get('boundary') ?? ''));
        try {
          await ctx.api.request('PUT', path, { auth: true, body: { coordinates: [...vertices, vertices[0]] } });
        } catch (error) {
          if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') throw new Error('Ranh không hợp lệ. Kiểm tra đỉnh trùng, đường tự cắt và diện tích.', { cause: error });
          if (error instanceof ApiError && error.code === 'LOCATION_CONSENT_REQUIRED') throw new Error('Bạn chưa đồng ý hoặc đã rút quyền lưu tọa độ. Tải lại trước khi thử lại.', { cause: error });
          throw error;
        }
      },
      onDone: () => ctx.rerender(),
    }),
    apiButton({ label: 'Rút đồng ý lưu tọa độ', kind: 'danger', confirm: {
      title: 'Xóa tọa độ của mọi thửa?',
      text: 'Ứng dụng xóa toàn bộ tọa độ ranh đã lưu trong tài khoản. Diện tích đã lưu và đơn đã đặt không đổi.',
    }, run: () => ctx.api.request('DELETE', consentPath, { auth: true }), onDone: () => ctx.rerender() })) });
}
