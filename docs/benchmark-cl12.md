# Kết quả đo tải đọc và ghi (CL-12)

## Điều kiện chạy

- Thời gian: 23/11/2026, 10:31 đến 10:35 (UTC+07), nhãn `local-baseline`.
- Commit nền `bcb982e`, worktree có thay đổi CL-12 chưa commit.
- Mỗi ca: 2 lượt làm nóng, sau đó 30 lượt đo.
- Cấu hình: `read` concurrency 4, tối đa 2000 request mỗi lượt; `booking` 30 đơn, concurrency 4; `recruitment` 10 thợ, 3 chỗ, concurrency 10.
- Dữ liệu gốc nằm ngoài Git: `~/agridispatch-bench/cl12-local-baseline-20261123-1031/`.
- Cloud region 1: 23/11/2026, 14:08 đến 14:11 (UTC+07), nhãn `cloud-japaneast`. Đích là Booking staging `app-booking-bt05a1` ở Japan East, chỉ ca `read`. Phát tải từ laptop ở Việt Nam qua Internet. Commit máy phát tải `f76cceb`, có thay đổi bộ chạy chưa commit. Cấu hình `read` giống local: concurrency 4, làm nóng 1000 ms, đo 5000 ms. Dữ liệu gốc: `~/agridispatch-bench/cl12-cloud-japaneast-20261123-1408/`.

## Kết quả

| Đích | Ca | Trạng thái | Lượt hợp lệ | Lượt lỗi | p50 trung vị (ms) | p95 trung vị (ms) | p95 lớn nhất (ms) | Vi phạm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Local | read | Đủ | 30/30 | 0 | 4 | 6 | 13 | Không áp dụng |
| Local | booking | Đủ | 30/30 | 0 | 18 | 33,5 | 69 | 0 |
| Local | recruitment | Đủ | 30/30 | 0 | 51 | 98 | 139 | 0 |
| Cloud Japan East | read | Đủ | 30/30 | 0 | 102 | 128,5 | 420 | Không áp dụng |
| Cloud Japan East | booking, recruitment | Thiếu | Chưa chạy | | | | | |
| Cloud region 2 | Cả ba ca | Thiếu | Chưa chạy | | | | | |
| Sau tối ưu | Cả ba ca | Thiếu | Chưa chạy | | | | | |

- `read`: trung vị 1166,9 request/giây. `/health` p50 2 ms, p95 3 ms; `/api/services` 4 ms, 6 ms; `/api/jobs` 4 ms, 7 ms.
- `recruitment` theo pha (trung vị p50, p95): `apply` 33,5 ms, 74 ms; `offer` 68,5 ms, 117 ms; `accept` 46 ms, 62,5 ms. Cả 30 lượt đều có đúng 3 người được nhận, không lượt nào vượt chỗ.
- Cloud `read`: trung vị 35,2 request/giây, 5171 request, không có 4xx hoặc 5xx. `/health` p50 99 ms, p95 118,5 ms; `/api/services` 102,5 ms, 137 ms; `/api/jobs` 103 ms, 129,5 ms. Có 113 request bị cắt khi đóng cửa sổ đo; chúng vẫn ghi là `TIMEOUT` trong file gốc và được đếm riêng ở `cutAtWindowEnd`.
- Hai lần chạy cloud trước đó (`cl12-cloud-japaneast-20261123-1359` và `-1402`) ghi `read` 0/30 vì bộ chạy khi đó tính request bị cắt ở biên cửa sổ là lỗi. Không có lỗi 4xx hoặc 5xx trong hai lần này.
- Lần chạy trước đó cùng ngày (`cl12-local-before-20261123-1028`) có ca `recruitment` 0/30: cả 11 lượt lỗi `REGISTER_429`. Ca này được ghi là thiếu, rồi chạy lại sau khi sửa harness.

## Giới hạn

- Số liệu local đo trên một máy, nên không phản ánh mạng hay DB cloud. Số liệu cloud gồm cả độ trễ Internet từ Việt Nam tới Japan East, nên không tách được thời gian xử lý của server. Đây không phải SLA.
- Local dừng theo ngân sách 2000 request, còn cloud dừng theo thời lượng 5000 ms, nên không so sánh trực tiếp request/giây giữa hai đích.
- SHA của bản đang chạy trên staging chưa được ghi trong lần đo này.
- Hai lần chạy `read` trên cùng máy lệch nhau (1864,8 và 1166,9 request/giây). Không so sánh local với cloud chỉ dựa trên một lần chạy.
- Lần đo dùng Node 22.14, trong khi repo yêu cầu Node 26.
