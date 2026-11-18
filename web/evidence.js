// Dispute evidence section: private image list, thumbnails and originals through authenticated binary calls.
// Plain ES module, no storage, no HTML sinks, no direct image URLs. Server data is written with textContent only.
// Upload success needs a fresh list read that contains the new id. A timeout stays uncertain until the list settles.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 20;
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = { 'image/jpeg': 'JPEG', 'image/png': 'PNG' };
const THUMB_MAX_PX = 240;
// ponytail: a download URL is revoked after a fixed grace period, not on a download-complete event (not reliably exposed). Upgrade if downloads break in some browser.
const DOWNLOAD_GRACE_MS = 1000;
const UNCERTAIN = 'Chưa xác nhận được thao tác đã được ghi nhận. Tải lại để xem trạng thái thật trước khi thử lại.';
const UNCERTAIN_UPLOAD = 'Chưa xác nhận được ảnh đã được lưu. Danh sách đã tải lại. Kiểm tra danh sách trước khi tải lên lần nữa.';
const NOT_CONFIRMED = 'Chưa xác nhận: ảnh vừa tải chưa thấy trong danh sách. Chưa coi là đã lưu. Tải lại trước khi thử lại.';
const GENERIC = 'Không thực hiện được thao tác. Tải lại rồi thử lại.';
const ERRORS = {
  INVALID_IMAGE: 'Ảnh không đọc được hoặc không đúng nội dung ảnh. Chọn ảnh khác.',
  UNSUPPORTED_MEDIA_TYPE: 'Chỉ nhận ảnh JPEG hoặc PNG.',
  PAYLOAD_TOO_LARGE: 'Ảnh vượt quá 5 MB. Chọn ảnh nhỏ hơn.',
  STORAGE_UNAVAILABLE: 'Kho lưu trữ ảnh chưa sẵn sàng. Thử lại sau, chưa coi ảnh là đã lưu.',
  DISPUTE_NOT_OPEN: 'Vụ việc đã đóng nên không thể thêm bằng chứng.',
  UPLOAD_PENDING: 'Đang có ảnh chưa xử lý xong. Tải lại danh sách rồi thử lại sau.',
  EVIDENCE_LIMIT: 'Vụ việc đã đủ số ảnh bằng chứng cho phép.',
  NOT_FOUND: 'Không tìm thấy vụ việc hoặc bạn không có quyền xem.',
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  BAD_RESPONSE: 'Máy chủ trả về dữ liệu không hợp lệ. Tải lại trang.',
};

// ---- pure helpers (no DOM) ----------------------------------------------------

export function evidenceId(value) {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

export function validateEvidenceFile(file) {
  if (!file) return 'Chọn ảnh trước khi tải lên.';
  if (!Object.hasOwn(TYPES, file.type)) return 'Chỉ nhận ảnh JPEG hoặc PNG.';
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'Ảnh trống hoặc không đọc được dung lượng. Chọn ảnh khác.';
  if (file.size > MAX_BYTES) return 'Ảnh vượt quá 5 MB. Chọn ảnh nhỏ hơn.';
  return null;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isDimension = (value) => Number.isSafeInteger(value) && value > 0;
const isInstant = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validItem = (item) => isObject(item) && evidenceId(item.id) !== null && item.status === 'UPLOADED'
  && Object.hasOwn(TYPES, item.contentType) && isCount(item.byteSize)
  && isDimension(item.width) && isDimension(item.height) && isInstant(item.createdAt);

export function readEvidencePage(data, offset) {
  if (!isObject(data) || !Array.isArray(data.items) || data.items.length > PAGE) return null;
  if (data.limit !== PAGE || data.offset !== offset) return null;
  if (typeof data.canUpload !== 'boolean' || typeof data.storageAvailable !== 'boolean') return null;
  return data.items.every(validItem) ? data : null;
}

// Known codes get their own copy. Unknown codes fall back to generic text, never the raw code.
export function evidenceErrorMessage(error) {
  if (Object.hasOwn(ERRORS, error?.code)) return ERRORS[error.code];
  if (error?.uncertain) return UNCERTAIN;
  return GENERIC;
}

// ---- render (browser only) ----------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = globalThis.document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === undefined) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'click') node.addEventListener('click', value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

const alertNode = (text, cls = 'alert error') => el('p', { class: cls, role: 'alert', text });
const statusNode = (text, cls = '') => el('p', { class: cls || false, role: 'status', text });
const badResponse = () => Object.assign(new Error('BAD_RESPONSE'), { code: 'BAD_RESPONSE' });
const shortTime = (iso) => new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const formatBytes = (bytes) => (bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB`
  : `${(bytes / (1024 * 1024)).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`);
const field = (id, label, control, hint) => {
  control.setAttribute('aria-describedby', `${id}-hint`);
  return el('div', { class: 'field' }, [el('label', { for: id, text: label }), control, el('p', { class: 'hint', id: `${id}-hint`, text: hint })]);
};

export async function renderEvidence({ container, api, active, announce, disputeId }) {
  if (!active()) return () => {};
  const id = evidenceId(disputeId);
  let closed = false;
  const live = () => !closed && active();
  const thumbs = new Map(); // item id -> object URL of its shown thumbnail
  const downloads = new Map(); // object URL -> grace timer
  const dropThumbs = () => { for (const url of thumbs.values()) URL.revokeObjectURL(url); thumbs.clear(); };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    dropThumbs();
    for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); }
    downloads.clear();
  };
  if (!id) {
    container.replaceChildren(el('section', {}, [el('h2', { text: 'Bằng chứng ảnh' }), alertNode('Mã vụ việc không hợp lệ.')]));
    return cleanup;
  }

  const uploadBox = el('div');
  const feedback = el('div', { 'aria-live': 'polite' });
  const listBox = el('div', { 'aria-live': 'polite' });
  container.replaceChildren(el('section', { 'aria-labelledby': 'evidence-title' }, [
    el('h2', { id: 'evidence-title', text: 'Bằng chứng ảnh' }),
    el('p', { text: 'Ảnh gốc giữ nguyên siêu dữ liệu, có thể gồm tọa độ GPS và thời gian chụp. Chỉ bên khiếu nại, bên bị khiếu nại và người hòa giải được gán mới xem được ảnh. Trước khi chọn ảnh, hãy xóa chi tiết nhạy cảm như tọa độ hoặc thông tin nhận diện người.' }),
    el('p', { class: 'hint', text: 'Hệ thống chỉ kiểm tra định dạng JPEG hoặc PNG và dung lượng. Kiểm tra này không phải bằng chứng xác thực ảnh. Ảnh thu nhỏ chỉ để xem nhanh, không phải bước xác minh nội dung.' }),
    uploadBox,
    feedback,
    listBox,
  ]));

  let formKey = null;
  let ui = null; // { input, submit } of the current upload form, or null when no form is shown
  let selected = null;
  let busy = false;
  let needsVerification = false;
  let offset = 0;
  const sync = () => { if (ui) { ui.input.disabled = busy || needsVerification; ui.submit.disabled = busy || needsVerification || !selected; } };

  // The upload form is rebuilt only when the server flags change, so a reload keeps the user's selection.
  function buildUpload(page) {
    const key = `${page.canUpload}/${page.storageAvailable}`;
    if (key === formKey) return;
    formKey = key;
    ui = null;
    selected = null;
    if (!page.storageAvailable) {
      uploadBox.replaceChildren(alertNode('Kho lưu trữ ảnh chưa được cấu hình trên máy chủ, nên chưa thể tải ảnh lên.', 'alert warning'));
      return;
    }
    if (!page.canUpload) {
      uploadBox.replaceChildren(alertNode('Bạn chưa thể thêm bằng chứng cho vụ việc này. Máy chủ quyết định quyền này theo vai trò và trạng thái vụ việc.', 'alert warning'));
      return;
    }
    const input = el('input', { id: 'evidence-file', name: 'file', type: 'file', accept: 'image/jpeg,image/png' });
    const submit = el('button', { type: 'submit', class: 'btn primary', text: 'Tải ảnh lên' });
    const form = el('form', { class: 'form', novalidate: true }, [
      field('evidence-file', 'Chọn ảnh bằng chứng', input, 'Chỉ nhận JPEG hoặc PNG, tối đa 5 MB.'),
      submit,
    ]);
    ui = { input, submit };
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      const error = validateEvidenceFile(file);
      selected = error ? null : file;
      input.setAttribute('aria-invalid', String(Boolean(error)));
      feedback.replaceChildren(error ? alertNode(error) : statusNode(`Đã chọn ảnh ${TYPES[file.type]}, ${formatBytes(file.size)}. Chưa tải lên.`));
      sync();
    });
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (busy || needsVerification || !selected) return;
      upload(selected);
    });
    uploadBox.replaceChildren(form);
    sync();
  }

  // busy stays set until the list read settles, so no second upload starts while the server state is unknown.
  async function upload(file) {
    busy = true;
    sync();
    feedback.replaceChildren(statusNode('Đang tải ảnh lên…'));
    let newId = null;
    let uncertain = false;
    try {
      const { data } = await api.upload(`/api/disputes/${id}/evidence`, file);
      if (!live()) return;
      newId = evidenceId(data?.evidence?.id);
    } catch (error) {
      if (!live()) return;
      if (!error?.uncertain) {
        busy = false;
        sync();
        feedback.replaceChildren(alertNode(evidenceErrorMessage(error)));
        return;
      }
      uncertain = true;
    }
    feedback.replaceChildren(statusNode('Đang kiểm tra danh sách…'));
    needsVerification = true;
    const page = await load(0);
    busy = false;
    sync();
    if (!live()) return;
    if (page && newId && page.items.some((item) => item.id === newId)) {
      if (ui) ui.input.value = '';
      selected = null;
      sync();
      feedback.replaceChildren(statusNode('Đã tải ảnh bằng chứng.'));
      announce('Đã tải ảnh bằng chứng.');
    } else {
      // A failed list read proves nothing either way, so the copy stays uncertain.
      feedback.replaceChildren(alertNode(!page ? UNCERTAIN : uncertain ? UNCERTAIN_UPLOAD : NOT_CONFIRMED));
    }
  }

  async function showThumb(item, n, box) {
    if (!live()) return;
    box.replaceChildren(statusNode('Đang tải ảnh thu nhỏ…'));
    try {
      const blob = await api.binary(`/api/evidence/${item.id}/thumbnail`);
      // A reload may have replaced this card. Creating a URL for a detached card would leak it.
      if (!live() || !box.isConnected) return;
      const url = URL.createObjectURL(blob);
      if (thumbs.has(item.id)) URL.revokeObjectURL(thumbs.get(item.id));
      thumbs.set(item.id, url);
      const width = Math.min(THUMB_MAX_PX, item.width);
      box.replaceChildren(el('img', { src: url, alt: `Ảnh thu nhỏ bằng chứng ${n}`, width, height: Math.round((item.height * width) / item.width), loading: 'lazy' }));
    } catch (error) {
      if (!live() || !box.isConnected) return;
      box.replaceChildren(error?.code === 'THUMBNAIL_PENDING'
        ? statusNode('Ảnh thu nhỏ đang được chuẩn bị. Thử lại sau.')
        : alertNode(evidenceErrorMessage(error)));
    }
  }

  async function download(item, button) {
    if (!live() || button.disabled) return;
    button.disabled = true;
    try {
      const blob = await api.binary(`/api/evidence/${item.id}/content`);
      if (!live()) return;
      const url = URL.createObjectURL(blob);
      const link = el('a', { href: url, download: `bang-chung-${item.id}.${item.contentType === 'image/png' ? 'png' : 'jpg'}` });
      listBox.append(link);
      link.click();
      link.remove();
      downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, DOWNLOAD_GRACE_MS));
    } catch (error) {
      if (live()) feedback.replaceChildren(alertNode(evidenceErrorMessage(error)));
    } finally {
      button.disabled = false;
    }
  }

  const card = (item, n) => {
    const thumb = el('div', { 'aria-live': 'polite' });
    const thumbButton = el('button', { type: 'button', class: 'btn secondary', text: 'Xem ảnh thu nhỏ', click: () => showThumb(item, n, thumb) });
    const originalButton = el('button', { type: 'button', class: 'btn secondary', text: 'Tải ảnh gốc', click: () => download(item, originalButton) });
    return el('li', { class: 'card' }, [
      el('h3', { text: `Ảnh ${n}` }),
      el('p', { text: `${TYPES[item.contentType]}, ${item.width} × ${item.height} px, ${formatBytes(item.byteSize)}.` }),
      el('p', { text: `Tải lên lúc ${shortTime(item.createdAt)}.` }),
      el('div', { class: 'actions' }, [thumbButton, originalButton]),
      thumb,
    ]);
  };

  function listNodes(page) {
    const nodes = [];
    if (page.items.length) nodes.push(el('ul', { class: 'cards' }, page.items.map((item, i) => card(item, page.offset + i + 1))));
    else nodes.push(el('p', { text: page.offset ? 'Không còn ảnh ở trang này.' : 'Chưa có ảnh bằng chứng.' }));
    if (page.items.length || page.offset) {
      const prev = el('button', { type: 'button', class: 'btn secondary', text: 'Trang trước', click: () => load(Math.max(0, page.offset - PAGE)) });
      prev.disabled = page.offset === 0;
      const next = el('button', { type: 'button', class: 'btn secondary', text: 'Trang sau', click: () => load(page.offset + PAGE) });
      next.disabled = page.items.length < PAGE;
      nodes.push(el('p', { class: 'pager' }, [prev, next]));
    }
    return nodes;
  }

  async function load(next) {
    if (!live()) return null;
    listBox.replaceChildren(statusNode('Đang tải ảnh bằng chứng…'));
    try {
      const { data } = await api.request('GET', `/api/disputes/${id}/evidence?limit=${PAGE}&offset=${next}`, { auth: true });
      if (!live()) return null;
      const page = readEvidencePage(data, next);
      if (!page) throw badResponse();
      offset = next;
      needsVerification = false;
      buildUpload(page);
      sync();
      dropThumbs();
      listBox.replaceChildren(...listNodes(page));
      return page;
    } catch (error) {
      if (live()) listBox.replaceChildren(alertNode(evidenceErrorMessage(error)), el('button', { type: 'button', class: 'btn secondary', text: 'Tải lại', click: () => load(offset) }));
      return null;
    }
  }

  await load(0);
  return cleanup;
}
