# Harness tải ghi booking cục bộ (G12)

`server/scripts/benchmark-bookings.js` chạy tải ghi `POST /api/bookings` có giới hạn trên PostgreSQL dùng một lần cục bộ. Đây là kiểm thử tính đúng đắn dưới đồng thời (idempotency, báo giá, sự kiện), không phải đo thông lượng hay SLA. Repo không chứa số liệu đo nào.

## Phạm vi

- Chỉ chạy trên PostgreSQL loopback (`127.0.0.1`, `localhost`, `[::1]`) và DB có tên kết thúc `_test`. Root URL lấy từ biến `TEST_DATABASE_URL`, không có tùy chọn nhận URL từ xa hay credential qua CLI.
- Harness tạo DB con `agridispatch_acct_<hex>_test`, migrate, seed danh mục, rồi chạy account và booking app thật (`createAccountApp`, `createApp`) trên cổng ngẫu nhiên `127.0.0.1`.
- Mọi lệnh ghi nghiệp vụ trong phần tải đi qua HTTP với người dùng synthetic đăng ký và đăng nhập thật. SQL kiểm bất biến chỉ đọc; chuẩn bị DB chạy migration và seed riêng.
- Không dùng cloud, không dùng DB dùng chung. Cleanup sau lượt chạy cố đóng server, kết thúc pool và xóa đúng DB con vừa tạo, kể cả sau lỗi setup; lỗi cleanup được báo, không tính PASS.

## Tham số

| Tham số | Khoảng | Mặc định |
| --- | --- | --- |
| `count` (`--count`) | 1..300 booking logic | 30 |
| `concurrency` (`--concurrency`) | 1..20 | 4 |
| `timeoutMs` (`--timeout-ms`) | 100..10000 | 3000 |

Mỗi booking logic gửi hai request cùng `Idempotency-Key` và cùng payload, xếp liền nhau trong hàng đợi để các worker tranh chấp. Tối đa 600 request ghi cộng 1 probe không xác thực. Thời hạn toàn lượt 60 giây; request đang chạy bị hủy khi hết hạn. Body mỗi response tối đa 256 KiB.

## Bất biến kiểm tra

Một lần chạy đạt khi toàn bộ các điều kiện sau đúng:

- Mọi request ghi có HTTP 2xx và không có lỗi mạng, timeout hay body vượt giới hạn.
- `storedBookings` = `bookingsTotal` = `bookingEvents` = `idempotencyTotal` = `idempotencyComplete` = `quoteConsistent` = `replaySameId` = `distinctBookings` = `count`.
- Probe không có token trả 401.
- Cleanup thành công (server đóng, pool kết thúc, DB con bị xóa).

Nếu thiếu bất kỳ điều kiện nào, báo cáo có `ok: false` với `error.code` là `SETUP_FAILED`, `RUN_FAILED`, `DEADLINE_EXCEEDED`, `INCOMPLETE` hoặc `CLEANUP_FAILED`. Không có kết quả giả PASS.

## Cách chạy

```bash
TEST_DATABASE_URL='postgresql://<user>:<pass>@127.0.0.1:55432/<name>_test' \
BUILD_SHA=<sha> \
node server/scripts/benchmark-bookings.js \
  --count 30 --concurrency 4 --timeout-ms 3000 \
  --output "$HOME/agridispatch-bench/bookings-001"
```

`--output` là tiền tố file, bắt buộc, và nằm ngoài repo. Harness tạo `<tiền tố>.json` và `<tiền tố>.csv` bằng cờ `wx` (không ghi đè). Thư mục cha phải tồn tại sẵn. Thoát mã 2 khi sai tham số, 1 khi lần chạy không đạt.

`BUILD_SHA` là giá trị người vận hành khai báo, không được kiểm chứng với git. Chỉ được ghi vào `provenance` khi khớp dạng hex 7..40 ký tự.

## Nội dung kết quả

- `ok`, `error`, `config`, `requests` (setup, writesPlanned, writesIssued, probe).
- `aggregates`: `attempted`, `http2xx`, `http4xx`, `http5xx`, `errors` theo mã, `businessErrors` theo mã lỗi nghiệp vụ, `p50Ms`, `p95Ms` (nearest-rank trên request hoàn tất), `racedPairs`.
- `invariants`, `cleanup`.
- JSON `rows`: `index`, `attempt`, `status`, `error`, `durationMs`, `bytes`, `offsetMs`, `businessError`. Không có token, mật khẩu, khóa idempotency hay email. CSV dùng cột chung của runner đọc (`phase,path,offsetMs,durationMs,status,error,bytes`); đối chiếu cặp request và lỗi nghiệp vụ bằng JSON, không chỉ CSV.

Quy tắc đọc:

- `racedPairs` đếm cặp có khoảng thời gian HTTP chồng nhau. Đây là thông tin, không chứng minh DB đã chặn ở unique index. Chứng minh dedupe nằm ở `replaySameId` và `idempotencyTotal`.
- `p50Ms` và `p95Ms` là số đo cục bộ trên một máy, không phải SLA và không suy ra tải thực tế.
- Số liệu chỉ có giá trị khi đã chạy thật. Không lấy số từ tài liệu hay từ lần chạy mẫu.

## Giới hạn đã biết

- Helper HTTP đã được kiểm với server thực gửi header rồi treo body: timeout và abort toàn lượt đều không thành công giả. Chưa chèn lỗi treo vào chính DB/account-service khi chạy harness đầy đủ.
- Bước migrate và seed không dùng thời hạn toàn lượt. Chúng dựa vào `statementTimeout` và `connectionTimeoutMillis` của pool.
- Không có đo cloud, không có kiểm tra quota, không có pipeline deploy.
- Tải closed-loop: mỗi worker đợi request xong mới gửi tiếp.

## Lần chạy coordinator đã kiểm

Ngày 18/11/2026 (UTC+07), chạy count 300, concurrency 20, timeout 3000 ms trên PostgreSQL 17 dùng một lần. Có 600 request ghi nhận 2xx; DB giữ đúng 300 booking, 300 sự kiện và 300 khóa idempotency hoàn tất. Cả 300 cặp trả cùng ID; probe không xác thực trả 401. Hai server đã đóng, pool kết thúc, DB con đã xóa. JSON và CSV đều được mở lại, đối chiếu đủ 600 dòng.

Đây là một lần kiểm tính đúng đắn dưới đồng thời trên loopback. Không dùng để kết luận công suất tối đa, SLA, hiệu năng Azure hoặc khác biệt region.
