# Cách chạy đo CL-12

Kết quả đo ghi ở [benchmark-cl12.md](benchmark-cl12.md). Chạy các lệnh dưới đây trong cùng một cửa sổ PowerShell, tại thư mục gốc repo. Thư mục kết quả phải mới, rỗng và nằm ngoài repo.

## Script

| Script | Đo | Local | Cloud |
| --- | --- | --- | --- |
| `server/scripts/benchmark-suite.js` | Cả ba ca, làm nóng 2 lượt rồi lấy 30 lượt hợp lệ | Cả ba ca | Chỉ `read` |
| `server/scripts/benchmark-http.js` | Một lượt đọc | Có | Có |
| `server/scripts/benchmark-bookings.js` | Một lượt ghi đơn đặt | Có | Không |
| `server/scripts/benchmark-recruitment.js` | Một lượt tuyển thợ | Có | Không |

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
| `REMOTE_WRITE_REFUSED` | Ca ghi chỉ chạy local. Trên cloud dùng `--cases read`. |

## Chưa hỗ trợ

Ca ghi đơn đặt và tuyển thợ trên cloud. Script ghi hiện tạo và xóa DB dùng một lần ở local, nên cần công cụ riêng được nhóm duyệt.
