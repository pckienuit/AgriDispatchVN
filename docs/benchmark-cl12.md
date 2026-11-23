# Kết quả đo tải đọc và ghi (CL-12)

## Điều kiện chạy

- Thời gian: 23/11/2026, 10:31 đến 10:35 (UTC+07), nhãn `local-baseline`.
- Commit nền `bcb982e`, worktree có thay đổi CL-12 chưa commit.
- Máy phát tải (dùng cho mọi lượt, cả local và cloud): laptop Windows 11 (10.0.26300), Intel Core i7-13650HX 20 luồng, 16 GB RAM, Node v22.14.0. Ở local, app và PostgreSQL 17 (Docker, tmpfs) chạy chung máy này.
- Mỗi ca: 2 lượt làm nóng, sau đó 30 lượt đo.
- Cấu hình: `read` concurrency 4, tối đa 2000 request mỗi lượt; `booking` 30 đơn, concurrency 4; `recruitment` 10 thợ, 3 chỗ, concurrency 10.
- Dữ liệu gốc nằm ngoài Git: `~/agridispatch-bench/cl12-local-baseline-20261123-1031/`.
- Cloud region 1: 23/11/2026, 14:08 đến 14:11 (UTC+07), nhãn `cloud-japaneast`. Đích là Booking staging `app-booking-bt05a1` ở Japan East, chỉ ca `read`. Phát tải từ laptop ở Việt Nam qua Internet. Commit máy phát tải `f76cceb`, có thay đổi bộ chạy chưa commit. Cấu hình `read` giống local: concurrency 4, làm nóng 1000 ms, đo 5000 ms. Dữ liệu gốc: `~/agridispatch-bench/cl12-cloud-japaneast-20261123-1408/`.
- Cloud region 2: 23/11/2026, 21:08 đến 21:11 (UTC+07), nhãn `cloud-centralindia`. Đích là `app-booking-bench-ce` ở Central India (DNS trỏ tới `centralindia.cloudapp.azure.com`), chỉ ca `read`. Phát tải từ cùng laptop ở Việt Nam qua Internet. Commit máy phát tải `2270120`. Cấu hình `read` giống region 1. Dữ liệu gốc: `~/agridispatch-bench/cl12-cloud-centralindia-20261123-2108/`.
- Hai region cloud Japan East và Central India đã được nhóm chốt để đo. Nhóm đồng ý ghi dữ liệu test lên staging cho ca ghi.
- Ca ghi trên cloud (`benchmark-cloud-writes.js`, commit `5cd545c`): chỉ qua API công khai, tài khoản tổng hợp `cl12-bench-…@bench.example.test` dùng lại cho mọi lượt, bất biến đọc lại bằng API. Cấu hình `booking`: 10 đơn mỗi lượt, mỗi đơn gửi 2 lần cùng khóa idempotency, concurrency 4, timeout 5000 ms. Central India chạy 23/11/2026 23:59 đến 24/11/2026 00:02, Japan East chạy 24/11/2026 00:16 đến 00:17 (UTC+07). Dữ liệu gốc: `~/agridispatch-bench/cl12-cloud-writes-{centralindia,japaneast}-booking-*/`.
- Hạ tầng Japan East (nhóm `rg-is402-agri`, đọc qua Azure Resource Graph): App Service plan `sp-agri-bt05` B1; booking `app-booking-bt05a1` và account `app-account-bt05a1` cùng chạy trên Web App; PostgreSQL `psql-agri-bt05a1` ở Japan East, `Standard_B1ms`; `DATABASE_URL` lấy từ Key Vault `kv-agri-bt05a1`.
- Hạ tầng Central India: nằm ở subscription khác, chưa đọc được SKU plan và vị trí PostgreSQL. App dùng DB riêng, không chung với Japan East: `/api/jobs` hai bên trả về tin tuyển khác nhau. Dữ liệu đọc hai bên cùng quy mô: 3 dịch vụ, 1 tin tuyển.
- Bản đang chạy trên cả hai region: `12154ad`, đọc từ header `X-Build-SHA` ngày 23/11/2026. Image ghim digest `sha256:737651fd…6f9fb37`.

## Kết quả

| Đích | Ca | Trạng thái | Lượt hợp lệ | Lượt lỗi | p50 trung vị (ms) | p95 trung vị (ms) | p95 lớn nhất (ms) | Vi phạm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Local | read | Đủ | 30/30 | 0 | 4 | 6 | 13 | Không áp dụng |
| Local | booking | Đủ | 30/30 | 0 | 18 | 33,5 | 69 | 0 |
| Local | recruitment | Đủ | 30/30 | 0 | 51 | 98 | 139 | 0 |
| Cloud Japan East | read | Đủ | 30/30 | 0 | 102 | 128,5 | 420 | Không áp dụng |
| Cloud Japan East | booking (qua API) | Đủ | 30/30 | 0 | 136 | 196 | 702 | 0 |
| Cloud Japan East | recruitment | Thiếu | Chưa chạy: vai trò tài khoản test chưa được duyệt trên staging | | | | | |
| Cloud Central India | read | Đủ | 30/30 | 0 | 158 | 182 | 313 | Không áp dụng |
| Cloud Central India | booking (qua API) | Đủ | 30/30 | 0 | 763 | 864 | 1222 | 0 |
| Cloud Central India | recruitment | Thiếu | Chưa chạy: vai trò tài khoản test chưa được duyệt trên staging | | | | | |
| Local, sau tối ưu | read | Đủ | 30/30 mỗi lượt, 2 lượt | 0 | Xem mục Trước và sau tối ưu | | | Không áp dụng |
| Local, sau tối ưu | booking, recruitment | Thiếu | Chưa chạy (tối ưu không chạm đường ghi) | | | | | |
| Cloud, sau tối ưu | Cả ba ca | Thiếu | Chưa deploy bản có cache | | | | | |

- `read`: trung vị 1166,9 request/giây. `/health` p50 2 ms, p95 3 ms; `/api/services` 4 ms, 6 ms; `/api/jobs` 4 ms, 7 ms.
- `recruitment` theo pha (trung vị p50, p95): `apply` 33,5 ms, 74 ms; `offer` 68,5 ms, 117 ms; `accept` 46 ms, 62,5 ms. Cả 30 lượt đều có đúng 3 người được nhận, không lượt nào vượt chỗ.
- Japan East `read`: trung vị 35,2 request/giây, 5171 request, không có 4xx hoặc 5xx. `/health` p50 99 ms, p95 118,5 ms; `/api/services` 102,5 ms, 137 ms; `/api/jobs` 103 ms, 129,5 ms. Có 113 request bị cắt khi đóng cửa sổ đo; chúng vẫn ghi là `TIMEOUT` trong file gốc và được đếm riêng ở `cutAtWindowEnd`.
- Central India `read`: trung vị 27,6 request/giây, 4176 request, không có 4xx hoặc 5xx. `/health` p50 89 ms, p95 105,5 ms; `/api/services` 163 ms, 185,5 ms; `/api/jobs` 163 ms, 185,5 ms. Có 117 request bị cắt khi đóng cửa sổ đo. Lần gọi `/health` và `/ready` đầu tiên trước khi đo bị timeout 30 giây do container khởi động lạnh; các lần sau trả 200.
- `recruitment` trên cloud: đã tạo 1 chủ máy và 10 thợ tổng hợp ở mỗi region và gửi yêu cầu vai trò. Kiểm lại ngày 24/11/2026 qua API, cả 22 yêu cầu vẫn ở trạng thái `PENDING`, nên ca này ghi thiếu. Khi được duyệt, chạy lại theo `benchmark-cl12-run.md` với cùng file tài khoản.
- `booking` qua API trên cloud: mỗi region 640 request ghi (kể cả 2 lượt làm nóng), tất cả trả 201, không lỗi mạng hay timeout. Mỗi lượt đúng 10 đơn, hai lần gửi cùng khóa trả cùng ID, giá khớp báo giá, đọc lại được và có đúng 1 sự kiện `BOOKING_REQUESTED`. Mỗi region để lại 320 đơn đặt tổng hợp trên staging; chưa dọn.
- Hai lần chạy cloud trước đó (`cl12-cloud-japaneast-20261123-1359` và `-1402`) ghi `read` 0/30 vì bộ chạy khi đó tính request bị cắt ở biên cửa sổ là lỗi. Không có lỗi 4xx hoặc 5xx trong hai lần này.
- Lần chạy trước đó cùng ngày (`cl12-local-before-20261123-1028`) có ca `recruitment` 0/30: cả 11 lượt lỗi `REGISTER_429`. Ca này được ghi là thiếu, rồi chạy lại sau khi sửa harness.

## Trước và sau tối ưu

Tối ưu: cache danh sách dịch vụ `GET /api/services` trong bộ nhớ của booking app, theo từng trang, hết hạn sau 30 giây. Bật bằng biến `SERVICES_CACHE_MS=30000`; mặc định 0 là tắt.

Lý do: danh mục dịch vụ không có API sửa, chỉ đổi khi chạy seed hoặc migration, nhưng mỗi request đều đọc DB. Ở Central India, đường đọc DB chậm hơn `/health` khoảng 74 ms.

Đánh đổi: sau khi sửa danh mục bằng seed hoặc SQL, mỗi instance có thể trả dữ liệu cũ tối đa 30 giây.

Cách đo: cùng commit, cùng máy, cùng cấu hình `read` như `local-baseline`, chỉ khác `SERVICES_CACHE_MS`. Chạy xen kẽ trước, sau, trước, sau ngày 23/11/2026, 23:05 đến 23:10 (UTC+07). Giá trị cache được ghi ở `config.read.localServicesCacheMs` trong `suite.json`. Dữ liệu gốc: `~/agridispatch-bench/cl12-local-{before,after}-opt-{1,2}-20261123-2305/`.

| Lượt | Cache | `/health` p50 / p95 (ms) | `/api/services` p50 / p95 (ms) | `/api/jobs` p50 / p95 (ms) | Cả ca req/s | Lượt hợp lệ |
| --- | --- | --- | --- | --- | --- | --- |
| before-opt 1 | Tắt | 1 / 1 | 2 / 4 | 2 / 4 | 2171,6 | 30/30 |
| after-opt 1 | 30 giây | 1 / 2 | 1 / 2 | 3 / 5 | 1873,6 | 30/30 |
| before-opt 2 | Tắt | 2 / 4 | 4 / 8 | 4 / 8,5 | 1009,1 | 30/30 |
| after-opt 2 | 30 giây | 2 / 5 | 2 / 5 | 6 / 11 | 962,6 | 30/30 |

- Khi tắt cache, `/api/services` chậm như `/api/jobs` (cùng phải đọc DB). Khi bật cache, `/api/services` nhanh ngang `/health`: lượt đọc DB đã được bỏ. Trên loopback, mức giảm chỉ khoảng 1 đến 2 ms mỗi request.
- Số req/s của cả ca dao động theo trạng thái máy (2171,6 rồi 1009,1 ở hai lượt tắt cache), lớn hơn nhiều so với tác động của cache, nên không dùng để kết luận. Tải closed-loop xoay vòng ba đường, nên một đường nhanh hơn không làm tăng req/s của cả ca.
- Chưa đo trên cloud. Staging đang chạy `12154ad`, chưa có code cache; cần deploy bản mới và đặt `SERVICES_CACHE_MS` mới đo được.

## Giới hạn

- Số liệu local đo trên một máy, nên không phản ánh mạng hay DB cloud. Số liệu cloud gồm cả độ trễ Internet từ Việt Nam tới từng region, nên không tách được thời gian xử lý của server. Đây không phải SLA.
- Ở Central India, `/health` (không gọi DB) nhanh hơn Japan East nhưng hai đường đọc DB chậm hơn `/health` khoảng 74 ms, trong khi ở Japan East chỉ chênh khoảng 3 ms. Hai region dùng DB riêng, nhưng chưa xác nhận DB của Central India đặt ở region nào và dùng SKU gì, nên chưa kết luận nguyên nhân.
- Ca ghi trên local và trên cloud khác cách kiểm: local kiểm bằng SQL trên DB dùng một lần, cloud kiểm bằng API trên DB staging có sẵn dữ liệu. Chỉ so độ trễ, không so số bất biến.
- Hạ tầng Central India chưa ghi đủ (SKU plan, vị trí và SKU PostgreSQL), nên chưa khẳng định hai region cùng cấu hình.
- Local dừng theo ngân sách 2000 request, còn cloud dừng theo thời lượng 5000 ms, nên không so sánh trực tiếp request/giây giữa hai đích.
- Hai lần chạy `read` trên cùng máy lệch nhau (1864,8 và 1166,9 request/giây). Không so sánh local với cloud chỉ dựa trên một lần chạy.
- Lần đo dùng Node 22.14, trong khi repo yêu cầu Node 26.
