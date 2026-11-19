# Kế hoạch thực thi UI demo v2 trên API thật

Bàn giao cho model thực thi. Quyết định gốc ở [ui-demo-v2.md](ui-demo-v2.md), bảng 52 màn ở [ui-demo-v2-screens.md](ui-demo-v2-screens.md). Nhánh `feat/ui-demo-v2`. Không merge vào `cloud/is402-2026-11-24` hay `main`, không push khi Kiên chưa duyệt.

## 1. Đã xong (Phase 0)

| Commit | Nội dung | Kiểm chứng |
| --- | --- | --- |
| `cff58d5` | Ghi quyết định D1..D10 và bảng đối chiếu 52 màn | Tài liệu |
| `a690a38` | Đăng nhập bằng số điện thoại (D4): migration `018_phone_login.sql`, chuẩn hóa `+84`/`84`/dấu cách, email cũ vẫn dùng được, khóa throttle tách namespace | unit 488/488, integration 238/238 (PostgreSQL 17 tạm) |
| `73486a7` | `web/v2/`: kit port từ demo (`kit/ui.js`, `kit/labels.js`), router `#/<vai-trò>/<mã>`, khung mobile/tablet/desk theo vai trò, `app/actions.js` (apiButton, apiForm), màn C-01..C-04. `web/api.js` tách lớp API dùng chung, `web/app.js` re-export nên UI cũ và test cũ không đổi | `server/tests/web-v2.test.js` 6/6; trình duyệt 390px: đăng ký, đăng nhập sai/đúng, C-02, chặn quyền, 404, đăng xuất, 0 lỗi JS, không tràn ngang |

UI mới chạy ở `/v2/`, UI cũ vẫn ở `/` cho tới khi thay xong.

## 2. Môi trường cho người thực thi

File cục bộ ngoài repo (không commit) ở `/home/pckien/.agridispatch-local/`, quyền 700:

- `v2-brief.md`: brief chung bắt buộc đọc trước mọi task (file được sửa, ctx của màn, quy tắc nghiệp vụ, chính sách chất lượng, cách kiểm).
- `v2-task-{farmer,provider,operator,coop,admin}.md`: danh sách màn Phase 1 theo vai trò.
- `v2dev.sh`: chạy account `:3101` và app `:3100` từ mã nguồn, nối DB compose `127.0.0.1:5433`. File tĩnh đọc trực tiếp từ đĩa nên sửa UI không cần khởi động lại.
- `v2-seed.mjs`: tạo tài khoản demo bằng số điện thoại và duyệt vai trò qua admin. `demo-accounts-phone.txt`, `demo-accounts.txt` (600) chứa mật khẩu demo cục bộ.
- `v2check/cdp.mjs` (driver Chromium qua CDP), `v2check/phase0.mjs` (mẫu kịch bản kiểm).
- `pg-v2.url`: PostgreSQL tạm (tmpfs) cho integration test. Container có thể đã bị dọn; nếu mất, tạo lại theo `docs/testing.md`.

Khởi động lại khi cần: `docker compose --env-file .env -f infra/compose.yaml up -d --wait db`, rồi `bash ~/.agridispatch-local/v2dev.sh &`, rồi `curl -s http://127.0.0.1:3100/ready`.

## 3. Phase 1: 21 màn trên API sẵn có (không đổi server)

Năm vai trò độc lập, mỗi vai trò chỉ sửa đúng một file `web/v2/screens/<vai-trò>.js`, nên chạy song song được. Giao cho mỗi executor: nội dung `v2-brief.md` + `v2-task-<vai-trò>.md`.

| Vai trò | File | Màn | Endpoint chính |
| --- | --- | --- | --- |
| Nông dân | `screens/farmer.js` | F-01, F-02, F-03 (nhập m², chưa bản đồ), F-05+F-06, F-07 (kèm danh sách đơn, ủy quyền HTX), F-08, F-11, F-12, F-13, F-14, F-15 (đồng ý dời lịch) | fields, services, bookings (Idempotency-Key), coordinators, readiness, acceptance, payments, disputes, evidence, proposals, postponement |
| Chủ máy | `screens/provider.js` | P-01, P-02 (kèm đồng ý dời lịch), P-03 (`{machineId, operatorId}`), P-04, P-05, P-06, P-07, P-08, P-09, P-10 | packages, claim, machines, dispatch/operators, shifts, payments, acceptance, jobs, applications, offers, disputes |
| Thợ lái | `screens/operator.js` | O-01, O-03, O-04, O-05, O-06 | shift-packages, shifts start/pause/resume/complete, jobs, applications, offers |
| HTX | `screens/coop.js` | H-02, H-03 (gom theo danh sách, chưa bản đồ), H-05, H-06, H-07 | dispatch/bookings, packages, cancel, shifts, postponement |
| Quản trị | `screens/admin.js` | A-01, A-03 | admin/role-requests, dispute-review, mediator, proposals, close-unresolved |

Điểm bắt buộc trong Phase 1:

- O-06 sửa lỗi audit: nút Rút ứng tuyển chỉ hiện ở trạng thái server cho phép (`server/src/recruitment.js`). Sửa luôn bản cũ `web/recruitment.js:122` trong một commit riêng.
- Mọi giá có nhãn "Giá mô phỏng"; mọi ghi nhận tiền ghi rõ "ngoài hệ thống, nền tảng không giữ tiền".
- Không làm phần demo có mà API chưa có (bản đồ, GPS, telemetry, cọc, phụ phí, OTP, Zalo). Không để nút chết hay khung giữ chỗ.

Cổng hoàn thành Phase 1 (người duyệt chạy lại, không tin báo cáo tự khai):

1. `npx eslint .` sạch; `npm test` xanh; `node --test server/tests/web-v2.test.js` xanh.
2. Kịch bản trình duyệt mỗi vai trò trong `~/.agridispatch-local/v2check/<vai-trò>.mjs` chạy qua mọi màn, có ít nhất một thao tác ghi mỗi màn có ghi, 0 page error, `scrollWidth == innerWidth` ở 390x844 và khung chuẩn của vai trò (tablet 1024x768, desk 1440x900).
3. Một kịch bản xuyên vai trò `e2e.mjs`: nông dân tạo thửa và đặt gặt, ủy quyền HTX; HTX gom gói; chủ máy đăng tin, thợ ứng tuyển, chủ máy gửi đề nghị, thợ nhận; chủ máy nhận gói với máy và thợ; nông dân xác nhận ruộng; thợ chạy, tạm dừng, xong ca; nghiệm thu hai bên; ghi nhận và xác nhận chuyển tiền; mở khiếu nại có ảnh; admin phân công hòa giải, đề xuất, hai bên đồng ý.
4. Xem ảnh chụp từng màn, sửa lỗi thị giác. Không có ký tự gạch ngang dài trong UI.
5. Commit theo vai trò: `feat(web-v2): <vai-trò> screens on real API`.

## 4. Phase 2: 22 màn cần mở rộng API và DB

Làm tuần tự từng gói (migration đánh số liên tiếp từ `019`, không chạy song song vì đụng số migration và `docs/api.md`). Mỗi gói: migration + API + unit + integration + màn + kịch bản trình duyệt + cập nhật `docs/api.md`.

| Thứ tự | Gói | Màn | Nội dung |
| --- | --- | --- | --- |
| 2.1 | Ranh thửa | F-03, F-02, H-03 | Cột JSON tọa độ (không PostGIS), server kiểm đa giác hợp lệ, tự cắt, giới hạn số đỉnh, tự tính diện tích; vendor Leaflet + Turf vào `web/v2/vendor` giữ license; mở lại helper bản đồ đã bỏ khỏi `kit/ui.js` khi port. Nền bản đồ phải xử lý được khi không có mạng (hiện ranh không có nền), không gọi tile ngoài nếu chưa duyệt CSP |
| 2.2 | Đường vào, đất ruộng | F-04, P-02 | Thuộc tính đường vào, cầu, đất lún; cảnh báo máy nặng ở P-02 |
| 2.3 | Thông tin đặt gặt | F-05 | Giống lúa, ngày sạ, ngày gặt dự kiến, cửa thời vụ |
| 2.4 | Phụ phí giả định | F-06, F-11 | Bảng tham số phụ phí có nhãn "Giả định", snapshot vào đơn, không coi là giá đã khảo sát |
| 2.5 | Tham số quản trị | A-04 | Bảng tham số (ngưỡng gom 1,5 km, 15/20/50 ha, phụ phí, mức cọc) có nhãn giả định, lịch sử thay đổi |
| 2.6 | Hồ sơ máy | P-04, P-03 | Kiểm định, tải trọng, hạn giấy tờ; chặn nhận gói khi giấy tờ hết hạn |
| 2.7 | Hồ sơ thợ | O-08, P-05, P-03, A-01 | Kỹ năng tự khai và đã xác minh, chứng chỉ, hạn giấy tờ, admin duyệt |
| 2.8 | Tin tuyển mở rộng | P-08, O-03 | Hình thức tiền công, loại máy, kỹ năng, bộ lọc |
| 2.9 | Hoàn thành và tiền công thợ | O-07 | Ghi nhận hoàn thành khác với đã nhận tiền (AC-OP-08), ngoài hệ thống |
| 2.10 | Trạng thái ca mở rộng | O-01 | Bốc xe fooc, hạ tải, tạm dừng vì mưa/hỏng theo SH-01..SH-08, giữ tương thích sự kiện ca hiện có |
| 2.11 | Gom cụm gợi ý | H-03, H-05 | Gợi ý theo khoảng cách và ngưỡng có nhãn giả định, HTX chốt tay (D9); vòng chào việc |
| 2.12 | Sổ tiền chủ máy | P-07 | Tổng hợp bản ghi theo đơn; phí phần mềm chỉ hiển thị số giả định (D8) |
| 2.13 | Đồng ý dữ liệu vị trí | C-02 | Ghi nhận đồng ý và rút lại theo Luật 91/2025, chặn vẽ thửa khi chưa đồng ý |
| 2.14 | Nhật ký tuân thủ | A-05 | Xem nhật ký sự kiện nghiệp vụ hiện có; cổng tuân thủ chỉ liệt kê, không tự đánh giá pháp lý |
| 2.15 | Báo cáo tin tuyển | A-06 | Báo cáo và gỡ tin nghi lừa đảo |
| 2.16 | Theo dõi tiến độ | F-01, H-06 | Tiến độ m² từ ca máy thực tế, không vị trí GPS |

## 5. Phase 3: đã có quyết định, cần mở rộng lớn

| Màn | Quyết định | Việc |
| --- | --- | --- |
| F-09 Cọc | D5 | Bản ghi chuyển khoản ngoài hệ thống, bên trả báo, bên nhận xác nhận; chỉ mở sau khi chủ máy nhận gói và HTX gọi xác nhận; mã VietQR và mức 10% gắn nhãn mô phỏng, giả định |
| F-10, O-02, H-06 | D6 | Telemetry mô phỏng phía server (tiến trình sinh dữ liệu có nhãn), không giả làm thiết bị thật |
| H-09 | D8 | Hoa hồng HTX chỉ hiển thị số giả định |

## 6. Còn chặn: chờ Kiên chốt D7

Không làm khi chưa có câu trả lời:

- H-04: HTX có bước thẩm định thực địa trước khi bắt đầu ca không.
- H-08: HTX hòa giải cấp 1 (kèm tránh xung đột lợi ích) hay giữ admin độc lập như hiện tại.
- H-01, A-02: có địa bàn HTX và giới hạn 3 HTX mỗi xã không.

## 7. Sau khi đủ màn

1. Thay `web/index.html` bằng UI v2, chuyển `server/tests/browser-smoke.mjs` và `npm run test:system` sang luồng v2, rồi xóa module UI cũ trong cùng một commit.
2. Cập nhật `web/README.md`, `docs/testing.md`, `docs/api.md`, bảng 52 màn (cột phân loại).
3. Build lại image compose, chạy migrate, chạy lại toàn bộ cổng: lint, unit, integration, system, compose smoke từ DB trống.
4. Báo Kiên trước khi merge sang nhánh cloud; Hơn và Duyên đang dùng nhánh đó cho pipeline.
