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
- Hai region cloud Japan East và Central India đã được nhóm chốt để đo.
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
| Cloud Japan East | booking, recruitment | Thiếu | Chưa chạy | | | | | |
| Cloud Central India | read | Đủ | 30/30 | 0 | 158 | 182 | 313 | Không áp dụng |
| Cloud Central India | booking, recruitment | Thiếu | Chưa chạy | | | | | |
| Sau tối ưu | Cả ba ca | Thiếu | Chưa chạy | | | | | |

- `read`: trung vị 1166,9 request/giây. `/health` p50 2 ms, p95 3 ms; `/api/services` 4 ms, 6 ms; `/api/jobs` 4 ms, 7 ms.
- `recruitment` theo pha (trung vị p50, p95): `apply` 33,5 ms, 74 ms; `offer` 68,5 ms, 117 ms; `accept` 46 ms, 62,5 ms. Cả 30 lượt đều có đúng 3 người được nhận, không lượt nào vượt chỗ.
- Japan East `read`: trung vị 35,2 request/giây, 5171 request, không có 4xx hoặc 5xx. `/health` p50 99 ms, p95 118,5 ms; `/api/services` 102,5 ms, 137 ms; `/api/jobs` 103 ms, 129,5 ms. Có 113 request bị cắt khi đóng cửa sổ đo; chúng vẫn ghi là `TIMEOUT` trong file gốc và được đếm riêng ở `cutAtWindowEnd`.
- Central India `read`: trung vị 27,6 request/giây, 4176 request, không có 4xx hoặc 5xx. `/health` p50 89 ms, p95 105,5 ms; `/api/services` 163 ms, 185,5 ms; `/api/jobs` 163 ms, 185,5 ms. Có 117 request bị cắt khi đóng cửa sổ đo. Lần gọi `/health` và `/ready` đầu tiên trước khi đo bị timeout 30 giây do container khởi động lạnh; các lần sau trả 200.
- Hai lần chạy cloud trước đó (`cl12-cloud-japaneast-20261123-1359` và `-1402`) ghi `read` 0/30 vì bộ chạy khi đó tính request bị cắt ở biên cửa sổ là lỗi. Không có lỗi 4xx hoặc 5xx trong hai lần này.
- Lần chạy trước đó cùng ngày (`cl12-local-before-20261123-1028`) có ca `recruitment` 0/30: cả 11 lượt lỗi `REGISTER_429`. Ca này được ghi là thiếu, rồi chạy lại sau khi sửa harness.

## Giới hạn

- Số liệu local đo trên một máy, nên không phản ánh mạng hay DB cloud. Số liệu cloud gồm cả độ trễ Internet từ Việt Nam tới từng region, nên không tách được thời gian xử lý của server. Đây không phải SLA.
- Ở Central India, `/health` (không gọi DB) nhanh hơn Japan East nhưng hai đường đọc DB chậm hơn `/health` khoảng 74 ms, trong khi ở Japan East chỉ chênh khoảng 3 ms. Hai region dùng DB riêng, nhưng chưa xác nhận DB của Central India đặt ở region nào và dùng SKU gì, nên chưa kết luận nguyên nhân.
- Hạ tầng Central India chưa ghi đủ (SKU plan, vị trí và SKU PostgreSQL), nên chưa khẳng định hai region cùng cấu hình.
- Local dừng theo ngân sách 2000 request, còn cloud dừng theo thời lượng 5000 ms, nên không so sánh trực tiếp request/giây giữa hai đích.
- Hai lần chạy `read` trên cùng máy lệch nhau (1864,8 và 1166,9 request/giây). Không so sánh local với cloud chỉ dựa trên một lần chạy.
- Lần đo dùng Node 22.14, trong khi repo yêu cầu Node 26.
