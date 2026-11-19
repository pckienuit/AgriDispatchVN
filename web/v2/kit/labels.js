/* Nhãn và quy đổi dùng chung cho bộ thành phần giao diện. Trạng thái lấy theo dữ liệu thật của API, không theo FSM mô phỏng của demo. */
const HOUR = 3600000;
const DAY = 86400000;
const TZ_OFFSET = 7 * HOUR;
/* Công tầm cắt 1.296 m² là mặc định hiển thị; đổi được sang công tầm cấy 1.000 m². Đây là quy ước hiển thị, không phải quy tắc nghiệp vụ đã khảo sát xác nhận. */
const CONG_CUT_M2 = 1296;

/* Năm bước người dùng thấy trên một đơn. Gặt và Nghiệm thu suy ra từ ca máy và biên bản, không có cột trạng thái riêng trong đơn. */
const STEPS = ['Đặt', 'Gom', 'Nhận máy', 'Gặt', 'Nghiệm thu'];
const STEP_BY_STATE = { REQUESTED: 0, GROUPED: 1, ASSIGNED: 2, CANCELLED: -1 };

export const labels = {
  HOUR,
  DAY,
  CONG_CUT_M2,
  STEPS,
  STATE_LABEL: {
    REQUESTED: 'Đã gửi yêu cầu',
    GROUPED: 'Đã gom vào gói',
    ASSIGNED: 'Đã có máy và thợ',
    CANCELLED: 'Đã hủy',
  },
  SHIFT_LABEL: {
    RUNNING: 'Đang làm',
    PAUSED: 'Tạm dừng',
    COMPLETED: 'Đã xong',
  },
  /* state là trạng thái đơn từ API, hoặc tên bước 'harvest' và 'acceptance' khi màn đã biết ca máy hay biên bản. */
  stepIndex(state) {
    if (state === 'harvest') return 3;
    if (state === 'acceptance') return 4;
    if (state === 'done') return 5;
    return Object.hasOwn(STEP_BY_STATE, state) ? STEP_BY_STATE[state] : 0;
  },
  areaUnits(ha, congM2) {
    const unit = congM2 || CONG_CUT_M2;
    return { ha, m2: ha * 10000, cong: (ha * 10000) / unit };
  },
  dayStr(ms) {
    return new Date(ms + TZ_OFFSET).toISOString().slice(0, 10);
  },
  fmtSec(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  },
};
