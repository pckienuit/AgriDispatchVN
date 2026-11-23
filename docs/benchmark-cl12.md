# Đo tải đọc và ghi (CL-12)

Bộ chạy loạt `server/scripts/benchmark-suite.js` gom ba ca đo vào một lần chạy. Mỗi ca có lượt làm nóng (bị loại khỏi tổng hợp) và chạy đến khi đủ số lượt hợp lệ. Mọi lượt, kể cả lượt lỗi, đều được lưu nguyên bản.

| Ca | Công cụ | Hợp lệ khi |
| --- | --- | --- |
| `read` | `benchmark-http.js` ([benchmark.md](benchmark.md)) | Có request hoàn tất; không có 4xx, 5xx, timeout, lỗi mạng, redirect hay vượt body |
| `booking` | `benchmark-bookings.js` ([benchmark-bookings.md](benchmark-bookings.md)) | `ok: true` (mọi bất biến đặt dịch vụ đúng, dọn DB thành công) |
| `recruitment` | `benchmark-recruitment.js` (mới) | Chạy hết các pha, mọi request có phản hồi, dọn DB thành công. Vi phạm bất biến được đếm riêng |

## Ca tuyển thợ

Mỗi lượt dựng DB PostgreSQL loopback dùng một lần, chạy account và booking app thật trên `127.0.0.1`. Một chủ máy đăng một tin tuyển có `capacity` chỗ. `operators` thợ đăng ký và đăng nhập qua HTTP. Vai trò được cấp bằng SQL tin cậy ở bước chuẩn bị, giống fixture integration test. Sau đó có ba pha đo:

1. `apply`: mỗi thợ ứng tuyển hai lần liền nhau để các worker tranh chấp unique index.
2. `offer`: chủ máy gửi đề nghị cho mọi đơn.
3. `accept`: mọi thợ nhận việc cùng lúc. Chỉ `capacity` người được nhận, số còn lại phải nhận `409 CAPACITY_FULL`.

Mỗi bất biến sai lệch tính là một vi phạm (`violations`, `violationCount`): số đơn và người ứng tuyển, số lần bị từ chối vì trùng, số đề nghị, số người nhận được việc, `overCapacity`, số sự kiện trong `dispatch.recruitment_events`, và probe không token phải trả 401. Harness nâng giới hạn đăng ký/đăng nhập theo IP lên 100 chỉ trong tiến trình đo, vì mỗi lượt tạo `1 + operators` tài khoản từ một IP. Giá trị này được ghi trong `config.throttle`. Mặc định của app không đổi.

```bash
TEST_DATABASE_URL='postgresql://<user>:<pass>@127.0.0.1:5434/agridispatch_test' \
node server/scripts/benchmark-recruitment.js --operators 10 --capacity 3 --concurrency 10 \
  --output "$HOME/agridispatch-bench/recruitment-001"
```

Giới hạn: `operators` 2..40, `capacity` 1..`operators`, `concurrency` 1..40, `timeout-ms` 100..10000. Thời hạn toàn lượt 60 giây.

## Bộ chạy loạt

```bash
mkdir -p "$HOME/agridispatch-bench/cl12-local-baseline"
BUILD_SHA=$(git rev-parse HEAD) node --env-file=.env server/scripts/benchmark-suite.js \
  --output-dir "$HOME/agridispatch-bench/cl12-local-baseline" \
  --label local-baseline --location "Máy phát tải local"
```

- `--runs` tối thiểu 30 (mặc định 30), `--warmup-runs` mặc định 2, `--max-invalid` mặc định 10. Khi vượt số lượt lỗi cho phép, bộ chạy dừng ca đó và đánh dấu `thiếu`.
- `--output-dir` phải có sẵn, rỗng và nằm ngoài repo. Kết quả gồm `runs/<ca>-NNN.json|csv` (file gốc từng lượt), `suite.json` (điều kiện chạy, cấu hình, mã lỗi, giới hạn), `summary.csv` (một dòng mỗi lượt, trỏ tới file gốc) và `summary.md` (bảng tổng hợp).
- Ca `read` có thể đo một host HTTPS đã duyệt bằng `--base-url --allow-remote --allowed-host <host> --cases read`. Ca ghi chỉ chạy cục bộ. Không chạy lên cloud khi chưa có xác nhận tài khoản, quota và mục tiêu (xem `AGENTS.md`).
- Lệnh thoát mã 1 nếu có ca `thiếu` hoặc có vi phạm bất biến.

## Kết quả

Lần chạy `local-baseline` ngày 23/11/2026, 10:31 đến 10:35 (UTC+07). Phát tải, app và PostgreSQL 17 (Docker, tmpfs) cùng chạy trên một laptop Windows 11, i7-13650HX 20 luồng, 16 GB RAM, Node v22.14.0 (repo yêu cầu Node 26; lần sau cần chạy lại bằng Node 26). Commit nền `bcb982e`, có thay đổi CL-12 chưa commit trong worktree. Dữ liệu gốc nằm ngoài Git, ở `~/agridispatch-bench/cl12-local-baseline-20261123-1031/`.

Cấu hình: `read` concurrency 4, warmup 1000 ms, tối đa 5000 ms hoặc 2000 request đo mỗi lượt; `booking` count 30, concurrency 4; `recruitment` 10 thợ, 3 chỗ, concurrency 10. Mỗi ca 2 lượt làm nóng.

| Đích | Ca | Trạng thái | Lượt hợp lệ | Lượt lỗi | p50 trung vị (ms) | p95 trung vị (ms) | p95 lớn nhất (ms) | Vi phạm |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Local | read | Đủ | 30/30 | 0 | 4 | 6 | 13 | Không áp dụng |
| Local | booking | Đủ | 30/30 | 0 | 18 | 33,5 | 69 | 0 |
| Local | recruitment | Đủ | 30/30 | 0 | 51 | 98 | 139 | 0 |
| Cloud region 1 | Cả ba ca | Thiếu | Chưa chạy | | | | | |
| Cloud region 2 | Cả ba ca | Thiếu | Chưa chạy | | | | | |
| Sau tối ưu | Cả ba ca | Thiếu | Chưa có lần tối ưu để so | | | | | |

Chi tiết từ file gốc:

- `read`: trung vị thông lượng 1166,9 request/giây. Lượt nào cũng chạm ngân sách 2000 request trước khi hết 5000 ms, nên đây là đo theo ngân sách, không phải tải duy trì. Theo đường: `/health` p50 2/p95 3 ms, `/api/services` 4/6 ms, `/api/jobs` 4/7 ms (danh sách tin tuyển rỗng trên DB mới).
- `recruitment` theo pha (trung vị p50/p95): `apply` 33,5/74 ms (600 request), `offer` 68,5/117 ms (300), `accept` 46/62,5 ms (300). Cả 30 lượt đều đúng 3 người nhận được việc, `overCapacity` bằng 0.
- Lần chạy đầu cùng ngày (thư mục `cl12-local-before-20261123-1028`) có ca `recruitment` 0/30: cả 11 lượt dừng ở `SETUP_FAILED` với `REGISTER_429` do giới hạn đăng ký 10 tài khoản/IP. Bộ chạy đã ghi ca đó là `thiếu`. Sau khi harness nâng giới hạn như mô tả ở trên, toàn bộ bộ đo được chạy lại. Hai lần chạy cho ca `read` lệch nhau (1864,8 và 1166,9 request/giây trung vị) trên cùng máy, nên không dùng một lần chạy để so sánh local với cloud.

## Giới hạn

- Phát tải, app và DB cùng một máy, nên số liệu không phản ánh độ trễ mạng hay DB cloud. Đây không phải SLA hay công suất tối đa.
- Ca ghi tạo DB con mới cho từng lượt, nên số đo gồm cả DB vừa migrate còn lạnh.
- Tải closed-loop: mỗi worker đợi request xong rồi mới gửi tiếp.
- So sánh hai region và trước/sau tối ưu còn phụ thuộc CL-03, CL-05, CL-10 và việc xác nhận đích cloud. Khi chạy, ghi mỗi đích bằng `--label` riêng, giữ cấu hình giống nhau và ghi rõ hai bên khác nhau ở đâu.
