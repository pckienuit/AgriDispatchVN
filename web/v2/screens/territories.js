import { apiButton, apiForm } from '../app/actions.js';
import { url } from '../app/routes.js';
import { ui } from '../kit/ui.js';

const h = ui.h;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME = (value) => typeof value === 'string' && value.trim().length > 0 && [...value.trim()].length <= 120;
const CODE = /^[A-Z0-9-]{2,32}$/;

function checkTerritory(row) {
  return row && UUID.test(row.id) && UUID.test(row.coopId) && NAME(row.provinceName) && NAME(row.communeName)
    && CODE.test(row.provinceCode) && CODE.test(row.communeCode);
}
export function territoryInput(values) {
  const input = {
    provinceName: String(values.provinceName || '').trim(),
    provinceCode: String(values.provinceCode || '').trim().toUpperCase(),
    communeName: String(values.communeName || '').trim(),
    communeCode: String(values.communeCode || '').trim().toUpperCase(),
  };
  const invalid = !NAME(input.provinceName) || !NAME(input.communeName) || !CODE.test(input.provinceCode) || !CODE.test(input.communeCode);
  return invalid ? { error: 'Nhập tên và mã tỉnh, xã hợp lệ.', payload: null } : { error: null, payload: input };
}

async function adminTerritories(ctx) {
  const accounts = await ctx.api.request('GET', '/api/admin/coops', { auth: true });
  const coops = accounts.data?.items || [];
  const selectedId = ctx.params.coop;
  const selected = coops.find((coop) => coop.userId === selectedId) || coops[0];
  if (!selected) return h('div', { class: 'stack' }, ui.screenHead({ title: 'Địa bàn HTX', sub: 'Chọn HTX đã được duyệt để quản lý địa bàn.' }), ui.empty({ icon: 'map-pin', title: 'Chưa có HTX được duyệt', text: 'Các HTX đã duyệt vai trò sẽ hiện tại đây.' }));
  const { data } = await ctx.api.request('GET', `/api/admin/coops/${selected.userId}/territories`, { auth: true });
  const territories = Array.isArray(data?.items) ? data.items.filter(checkTerritory) : null;
  if (!territories) throw new Error('Máy chủ trả về danh sách địa bàn không hợp lệ.');
  const select = ui.select({ name: 'coop', value: selected.userId, options: coops.map((coop) => [coop.userId, coop.userName]) });
  select.addEventListener('change', () => ctx.go(url('quan-tri', 'A-02', { coop: select.value })));
  const provinceName = ui.input({ name: 'provinceName', maxlength: 120 });
  const provinceCode = ui.input({ name: 'provinceCode', maxlength: 32 });
  const communeName = ui.input({ name: 'communeName', maxlength: 120 });
  const communeCode = ui.input({ name: 'communeCode', maxlength: 32 });
  const form = apiForm({
    submitLabel: 'Gán xã cho HTX',
    fields: [
      ui.field({ label: 'HTX', input: select }),
      ui.field({ label: 'Tên tỉnh', required: true, input: provinceName }),
      ui.field({ label: 'Mã tỉnh', hint: 'Mã do quản trị viên nhập, 2-32 ký tự A-Z, 0-9 hoặc dấu gạch nối.', required: true, input: provinceCode }),
      ui.field({ label: 'Tên xã', required: true, input: communeName }),
      ui.field({ label: 'Mã xã', hint: 'Mã do quản trị viên nhập, 2-32 ký tự A-Z, 0-9 hoặc dấu gạch nối.', required: true, input: communeCode }),
      ui.note({ tone: 'info', text: 'Tên và mã địa bàn do quản trị viên nhập. Danh sách này không đồng bộ với danh bạ hành chính quốc gia. Không giới hạn số HTX được gán cùng một xã.' }),
    ],
    async run(formData) {
      const validated = territoryInput(Object.fromEntries(formData));
      if (validated.error) throw new Error(validated.error);
      await ctx.api.request('POST', `/api/admin/coops/${selected.userId}/territories`, { auth: true, body: validated.payload });
    },
    onDone() { if (!ctx.stale()) { ctx.toast('Đã gán địa bàn cho HTX.', 'ok'); ctx.rerender(); } },
  });
  return h('div', { class: 'stack' },
    ui.screenHead({ title: 'Địa bàn HTX', sub: 'Quản trị viên gán hoặc gỡ xã cho từng HTX. Không đặt giới hạn số HTX trong một xã.' }),
    ui.card({ title: 'Địa bàn đang phụ trách', subtitle: selected.userName, body: territories.length
      ? h('div', { class: 'stack-sm' }, territories.map((row) => ui.card({ flat: true, title: `${row.communeName}, ${row.provinceName}`, subtitle: `Mã xã ${row.communeCode} · Mã tỉnh ${row.provinceCode}`, body: apiButton({ label: 'Gỡ địa bàn', kind: 'danger', confirm: { title: 'Gỡ địa bàn?', text: 'HTX sẽ không còn được phân quyền địa bàn này.' }, async run() { await ctx.api.request('DELETE', `/api/admin/coops/${selected.userId}/territories/${row.id}`, { auth: true }); }, onDone() { ctx.rerender(); } }) })))
      : ui.empty({ icon: 'map-pin', title: 'HTX chưa được gán xã', text: 'Nhập tên và mã hành chính đã được xác nhận tại đây.' }) }),
    ui.card({ title: 'Thêm xã phụ trách', body: form }));
}

async function coopOverview(ctx) {
  const { data } = await ctx.api.request('GET', '/api/htx/territories/overview', { auth: true });
  if (!Array.isArray(data?.communes) || !data.delegated) throw new Error('Máy chủ trả về phạm vi địa bàn không hợp lệ.');
  return h('div', { class: 'stack' },
    ui.screenHead({ title: 'Tổng quan địa bàn', sub: 'Danh sách xã được gán. Chỉ số bên dưới tính các đơn được giao trực tiếp cho HTX, không phải mọi đơn trong xã.' }),
    ui.note({ tone: 'info', text: 'Mã và tên địa bàn do quản trị viên nhập, không đối chiếu với danh bạ hành chính quốc gia. Tên xã trong hồ sơ ruộng chưa được đối chiếu tự động với mã địa bàn.' }),
    ui.summaryLine([['Đơn giao trực tiếp', data.delegated.bookingCount], ['Đang chờ gom', data.delegated.requestedCount], ['Đã gom', data.delegated.groupedCount], ['Đã có máy', data.delegated.assignedCount]]),
    data.communes.length ? data.communes.map((item) => ui.card({ title: `${item.communeName}, ${item.provinceName}`, subtitle: `Mã xã ${item.communeCode} · Địa bàn được gán` }))
      : ui.empty({ icon: 'map-pin', title: 'Chưa có xã được giao', text: 'Liên hệ quản trị viên để được phân công địa bàn.' }));
}

export const screens = [
  { code: 'A-02', title: 'Địa bàn HTX', render: adminTerritories },
  { code: 'H-01', title: 'Tổng quan địa bàn', render: coopOverview },
];
