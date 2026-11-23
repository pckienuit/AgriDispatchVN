# Benchmark đọc HTTP (G12)

Công cụ `server/scripts/benchmark-http.js` đo tải đọc có giới hạn trên ba đường cố định: `/health`, `/api/services?limit=20`, `/api/jobs?limit=20`. Không hỗ trợ đường dẫn tùy ý, method khác GET, header xác thực hay ghi dữ liệu. Mỗi request đọc đầy đủ body, tối đa 256 KiB.

Kết quả đo CL-12 nằm ở [benchmark-cl12.md](benchmark-cl12.md), cách chạy ở [benchmark-cl12-run.md](benchmark-cl12-run.md).

Công cụ chỉ chứa mã đo. Repo không chứa file số liệu gốc. Số liệu chỉ được ghi sau khi có lần chạy thật theo giao thức bên dưới.

## Phạm vi

- Mặc định chỉ nhận host loopback (`127.0.0.1`, `localhost`, `[::1]`).
- Host từ xa cần đủ ba điều kiện: `--allow-remote`, `--allowed-host <host>` (host đã được phê duyệt), và URL HTTPS chỉ gồm origin. Không có query, userinfo, fragment hay path.
- Được phép cấu hình host từ xa không có nghĩa là được phép chạy. Chỉ chạy lên cloud khi có xác nhận tài khoản, quota và mục tiêu triển khai (xem `AGENTS.md`).
- Không redirect: phản hồi 3xx được ghi là `REDIRECT_REFUSED`.

## Giới hạn tham số

| Tham số | Khoảng | Mặc định CLI |
| --- | --- | --- |
| `--concurrency` | 1..100 | 4 |
| `--duration-ms` | 1000..300000 | 10000 |
| `--warmup-ms` | 0..30000 | 2000 |
| `--timeout-ms` | 100..30000 | 5000 |
| `--max-requests` | 1..100000 | 10000 |

Giá trị ngoài khoảng hoặc không phải số nguyên bị từ chối trước khi gửi request (mã `INVALID_OPTION`, thoát với mã 2).

Warmup có ngân sách riêng, tối đa 10000 request (tùy chọn API `warmupMaxRequests`). Tổng số dòng giữ trong bộ nhớ không vượt 100000. Hết ngân sách warmup thì runner chờ hết cửa sổ warmup rồi mới đo, nên warmup không làm mất request đo.

## Cách chạy

```bash
node server/scripts/benchmark-http.js \
  --base-url http://127.0.0.1:3000 \
  --concurrency 4 --duration-ms 10000 --warmup-ms 2000 \
  --timeout-ms 5000 --max-requests 10000 \
  --output "$HOME/agridispatch-bench/run-local-001"
```

`--output` là tiền tố file, bắt buộc, và phải nằm ngoài repo (lỗi `OUTPUT_IN_REPO` nếu nằm trong repo). Công cụ tạo hai file `<tiền tố>.json` và `<tiền tố>.csv` bằng cờ `wx`. Nếu file đã tồn tại, lệnh thất bại và không ghi đè. Khi lỗi giữa chừng, công cụ chỉ xóa file do chính lần chạy đó tạo ra. Thư mục cha phải tồn tại sẵn; công cụ không tự tạo thư mục.

## Nội dung kết quả

- `aggregates`: `attempted`, `completed`, `http2xx`, `http4xx`, `http5xx`, `redirectRefused`, `timeouts`, `network`, `bodyLimit`, `p50Ms`, `p95Ms`, `measuredSeconds`, `throughputRps`.
- `perPath`: cùng bộ số liệu cho từng đường dẫn.
- `rows`: từng request gồm `phase` (`warmup` hoặc `measure`), `path`, `offsetMs`, `durationMs`, `status`, `error`, `bytes`.
- `startedAt`, `finishedAt`: mốc UTC ISO của lần chạy. Mốc tương đối dùng đồng hồ monotonic; thời gian body tính đến hoàn tất hoặc bị hủy.

Quy tắc tính:

- Warmup được ghi trong `rows` nhưng không vào `aggregates` hay `perPath`.
- `durationMs` tính đến khi đọc xong body. Phản hồi chỉ có header rồi treo bị tính là `TIMEOUT`, không phải thành công.
- Hạn toàn lượt hủy cả request đang chạy, không chỉ chặn gửi request mới. Request bị hủy ở biên thời gian vẫn tính là lỗi timeout, không xóa khỏi mẫu.
- `completed` là request nhận đủ body mà không lỗi. Mã 4xx và 5xx không tính là thành công, và được đếm riêng theo lớp.
- Percentile dùng nearest-rank trên các `durationMs` của request `completed`. Không có mẫu thì trả `null`.
- `throughputRps` = `completed` / `measuredSeconds`. `measuredSeconds` là khoảng từ offset sớm nhất đến lúc kết thúc muộn nhất của các request đo.
- Không ghi token, mật khẩu, cookie hay query nhạy cảm vào output. Origin trong output đã chuẩn hóa.
- Đây là tải closed-loop: mỗi worker đợi request xong rồi gửi tiếp, không phải mức request/giây cố định. Tổng hợp trộn cả health và DB reads, nên phải đọc `perPath`; không coi throughput tổng là thông lượng nghiệp vụ. Percentile chỉ gồm request hoàn tất, luôn đọc cùng số timeout/lỗi để tránh kết luận thiên lệch.

## Giao thức đo cloud (chưa thực hiện)

Mỗi lần chạy phải ghi kèm vào báo cáo:

1. Vùng hoặc máy chạy công cụ (ví dụ: máy phát tải local, hoặc vùng cloud đã xác nhận).
2. Commit SHA của repo và SHA của cấu hình triển khai được đo.
3. Cấu hình tham số CLI đầy đủ.
4. Thời điểm bắt đầu chạy, theo múi giờ +07.
5. File JSON và CSV gốc, không chỉnh sửa.

Quy tắc:

- Chạy tuần tự, lặp lại ít nhất ba lần trên cùng cấu hình. Báo cáo cả ba lần, không chỉ lần đẹp nhất.
- So sánh local và cloud phải ghi rõ hai bên khác nhau ở điều gì (máy, mạng, DB, số instance).
- Không suy ra kết luận về tải thực tế từ một lần chạy ngắn trên loopback.
- Không lấy số liệu từ `docs/` hay từ bài viết làm số liệu đo của dự án.

## Chưa nằm trong phạm vi

- Tải POST hoặc endpoint cần xác thực chưa được công cụ này hỗ trợ. Đó là phần triển khai/kiểm thử còn thiếu trong G12 đã duyệt, không phải lý do đợi duyệt lại code local.
- Tải cloud thật: chưa có tài khoản, quota và mục tiêu triển khai được xác nhận.
- Việc hoàn thành G12 không dựa vào công cụ này một mình.

## Smoke local đã chạy

Coordinator chạy ba lượt tuần tự ngày 18/11/2026 (UTC+07), hai service HTTP và PostgreSQL 17 dùng một lần. Dataset seed 2026, 1000 booking; concurrency 4, warmup 200 ms/tối đa 100 request, thời lượng tối đa 2000 ms, timeout 1000 ms, ngân sách 600 request đo/lượt. Mỗi lượt nhận đủ 600 phản hồi 2xx, chia 200 mỗi đường; checker dataset sau mỗi lượt không đổi. Không có 4xx, 5xx, timeout, lỗi mạng hoặc vượt giới hạn body ở ba lượt đó.

Các lượt chạm ngân sách request trước thời lượng, nên chỉ là smoke ngắn của công cụ và DB reads, không chứng minh tải duy trì, công suất tối đa, SLA hay so sánh region. Raw JSON/CSV giữ ngoài Git. API đang đo trả danh sách dịch vụ/tin tuyển giới hạn 20 dòng; 1000 booking nền không có nghĩa công cụ đã đo truy vấn booking hay toàn bộ nghiệp vụ.
