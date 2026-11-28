# Cách chạy đo CL-12

Kết quả đo ghi ở [benchmark-cl12.md](benchmark-cl12.md). Chạy các lệnh dưới đây trong cùng một cửa sổ PowerShell, tại thư mục gốc repo. Thư mục kết quả phải mới, rỗng và nằm ngoài repo.

## Script

| Script | Đo | Local | Cloud |
| --- | --- | --- | --- |
| `server/scripts/benchmark-suite.js` | Cả ba ca, làm nóng 2 lượt rồi lấy 30 lượt hợp lệ | Cả ba ca | Cả ba ca (ghi qua API) |
| `server/scripts/benchmark-http.js` | Một lượt đọc | Có | Có |
| `server/scripts/benchmark-bookings.js` | Một lượt ghi đơn đặt | Có | Không |
| `server/scripts/benchmark-recruitment.js` | Một lượt tuyển thợ | Có | Không |
| `server/scripts/benchmark-cloud-writes.js` | Tạo tài khoản test; một lượt ghi đơn đặt hoặc tuyển thợ qua API | Có (server local) | Có |

## Local (cả ba ca)

Cần Docker Desktop đang chạy.

```powershell
docker compose --env-file .env -f infra/compose.yaml --profile test up -d --wait test-db
$out = "$HOME\agridispatch-bench\cl12-local-$(Get-Date -Format yyyyMMdd-HHmm)"; New-Item -ItemType Directory $out
$env:BUILD_SHA = git rev-parse HEAD
node --env-file=.env server/scripts/benchmark-suite.js --output-dir $out --label local-baseline --location "Mo ta may phat tai" > $null
Get-Content "$out\summary.md"
```

## Cloud (ca `read`)

Chỉ chạy khi đích đã được duyệt. Thay URL, host và nhãn theo từng region.

```powershell
$booking = 'https://app-booking-bt05a1-dhedg0a2c0aecnfh.japaneast-01.azurewebsites.net'
$out = "$HOME\agridispatch-bench\cl12-cloud-japaneast-$(Get-Date -Format yyyyMMdd-HHmm)"; New-Item -ItemType Directory $out
$env:BUILD_SHA = git rev-parse HEAD
node server/scripts/benchmark-suite.js --output-dir $out --cases read --base-url $booking --allow-remote --allowed-host app-booking-bt05a1-dhedg0a2c0aecnfh.japaneast-01.azurewebsites.net --label cloud-japaneast --location "Mo ta may phat tai va mang" > $null
Get-Content "$out\summary.md"
```

Ghi thêm SHA đang chạy trên staging (header `X-Build-SHA` của `/health`).

## Trước và sau tối ưu

Chạy cùng lệnh, cùng cấu hình với `--label before-opt`, deploy thay đổi, rồi chạy lại với `--label after-opt`.

## Kết quả

- `summary.md`: bảng tổng hợp từng ca.
- `summary.csv`: một dòng mỗi lượt, trỏ tới file gốc.
- `suite.json`: điều kiện chạy, cấu hình, mã lỗi, giới hạn.
- `runs/`: JSON và CSV gốc từng lượt.

## Lỗi thường gặp

| Lỗi | Cách xử lý |
| --- | --- |
| `OUTPUT_REQUIRED`, `--output-dir ... ambiguous` | Biến `$out` rỗng. Chạy lại lệnh tạo thư mục trong cùng cửa sổ. |
| `OUTPUT_DIR_NOT_EMPTY` | Tạo thư mục mới. |
| `OUTPUT_IN_REPO` | Đặt thư mục kết quả ngoài repo. |
| `INVALID_ROOT` | Chưa bật DB test hoặc không chạy từ thư mục gốc repo. |
| `REMOTE_WRITE_REFUSED` | Ghi lên cloud cần thêm `--allow-remote-writes`. |
| `CREDENTIALS_REQUIRED`, `CREDENTIALS_MISSING` | Thiếu `--credentials` hoặc chưa chạy `setup`. |
| `ROLE_MISSING` | Admin chưa duyệt vai trò. Chạy `status` để xem tài khoản nào còn chờ. |
| `setup` báo giới hạn đăng ký | Staging cho 10 lần đăng ký mỗi IP trong 15 phút. Đợi rồi chạy lại đúng lệnh `setup`. |

## Cloud (ca ghi qua API)

Chỉ chạy khi nhóm đã đồng ý ghi dữ liệu test lên staging. Công cụ chỉ dùng API công khai: không chạy SQL, không tạo hay xóa DB.

1. Tạo tài khoản một lần cho mỗi region. File tài khoản chứa mật khẩu, phải nằm ngoài repo và không gửi đi đâu.

```powershell
$booking = 'https://app-booking-bt05a1-dhedg0a2c0aecnfh.japaneast-01.azurewebsites.net'
$hostName = ([Uri]$booking).Host
$creds = "$HOME\agridispatch-bench\creds-japaneast.json"
node server/scripts/benchmark-cloud-writes.js setup --base-url $booking --allow-remote --allowed-host $hostName --credentials $creds
```

Lệnh tạo 1 nông dân, 1 chủ máy và 10 thợ (email `cl12-bench-…@bench.example.test`), rồi gửi yêu cầu vai trò. Nếu báo giới hạn đăng ký, đợi 15 phút rồi chạy lại đúng lệnh này.

2. Admin duyệt 11 yêu cầu vai trò trên giao diện quản trị. Kiểm tra:

```powershell
node server/scripts/benchmark-cloud-writes.js status --base-url $booking --allow-remote --allowed-host $hostName --credentials $creds
```

Mọi dòng phải là `sẵn sàng`.

3. Đo hai ca ghi:

```powershell
$out = "$HOME\agridispatch-bench\cl12-cloud-writes-japaneast-$(Get-Date -Format yyyyMMdd-HHmmss)"; New-Item -ItemType Directory $out
node server/scripts/benchmark-suite.js --output-dir $out --cases booking,recruitment --base-url $booking --allow-remote --allowed-host $hostName --allow-remote-writes --credentials $creds --label cloud-writes-japaneast --location "Mo ta may phat tai va mang" > $null
Get-Content "$out\summary.md"
```

Mỗi region tạo khoảng 320 đơn đặt (10 đơn mỗi lượt, 32 lượt kể cả làm nóng) và 32 tin tuyển. Tin tuyển được đóng sau mỗi lượt. Đơn đặt không có API xóa; dọn theo phương án nhóm đã chốt, ví dụ xóa theo email `cl12-bench-%`.

Bất biến được đọc lại qua API. Ca đơn đặt kiểm cùng ID khi gửi lại, giá, đọc lại và đúng 1 sự kiện `BOOKING_REQUESTED`. Ca tuyển thợ kiểm số đơn, số người được nhận, vượt chỗ; không kiểm được số sự kiện tuyển thợ qua API.

