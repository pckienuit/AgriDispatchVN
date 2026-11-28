# AgriDispatch VN

Nền tảng điều phối dịch vụ cơ giới hóa nông nghiệp Việt Nam, trọng tâm ĐBSCL.

Ứng dụng dùng Express 5, PostgreSQL 17, Docker và CI. Booking-service gọi account-service qua HTTP để xác minh danh tính.

## Trạng thái

- Có account-service: đăng ký/đăng nhập, session lưu PostgreSQL, giới hạn thử sai và phân quyền không cho tự nâng vai trò.
- Có danh mục dịch vụ, thửa ruộng và máy theo chủ sở hữu. Booking-service gọi account-service thật qua HTTP; API từ chối khi không xác minh được danh tính.
- Seed danh mục có nhãn synthetic, giá chỉ dùng thử. Chưa có dữ liệu thực địa trong DB.
- Đã có luồng local: đặt dịch vụ, HTX gom đơn, phân máy/thợ, tuyển thợ, ca làm, nghiệm thu, ghi nhận chuyển tiền bên ngoài, khiếu nại/hòa giải và hoãn lịch có đồng thuận từng bên.
- Hợp đồng API: [docs/api.md](docs/api.md). Các mốc bàn giao nội bộ nằm trong `docs/cloud-stages.md` ở repo phát triển.
- UI JavaScript thuần có các luồng trên, hoạt động trong app, upload bằng chứng riêng tư và hàng chờ quản trị duyệt vai trò. Đây không phải bản Figma nhóm UX/UI đã nghiệm thu.
- Đã triển khai và kiểm chứng trên Azure staging. Đây không phải bản production.

## Kết quả triển khai và kiểm chứng trên Microsoft Azure (`rg-is402-agri`, Japan East)

### FaaS: tạo thumbnail riêng tư

`func-thumbnail-bt05a1` chạy Azure Functions v4 trong container Docker Node 24 trên gói Dedicated Linux B1, bật Always On (không dùng Consumption). Blob Trigger dùng polling trên container riêng tư `evidence`. Function kiểm SHA-256, giải mã ảnh, tạo JPEG tối đa `320x320` giữ tỷ lệ và bỏ EXIF khỏi bản thu nhỏ. Function ghi sang container riêng tư `thumbnails` bằng Managed Identity và `If-None-Match: *` để không ghi đè.

| Ca kiểm ngày 23/11/2026 (UTC+7) | `FunctionAppLogs` | Kết quả |
| --- | --- | --- |
| Tạo mới | `588de769-2fc3-4d72-93ba-e03aff8fc57f` | `created=true`. PNG `640x480` (810.049 byte) cho JPEG `320x240` (14.826 byte). |
| Kích hoạt lại với cùng nội dung | `00f8640b-9827-4c4e-b5c8-05d8c56d30f1` | `created=false`. Blob giữ nguyên ETag `0x8DF48C9F42AF0A4`. |
| Ba tệp lỗi | `thumbnail_rejected`, `INVALID_IMAGE` | Không sinh thumbnail; cả ba lượt `HEAD` trên blob đầu ra trả `404 BlobNotFound`. |

[Minh chứng CL-09](https://github.com/pckienuit/AgriDispatchVN/blob/bc46506d5ea1621425e6da701a2c9e6c81a8c909/docs/cl-09-evidence.md): bản chạy trên Azure ghim digest ACR `sha256:12b2fd26…` (`BUILD_SHA=62e4455…`). Mã nguồn repo đã có cùng bản vá `409 BlobAlreadyExists` trong [`server/src/blob-store.js`](server/src/blob-store.js); đó không phải SHA của image đang chạy.

### Dữ liệu quan hệ và hiệu năng

**10.326.473 bản ghi trên 11 bảng** sau đợt nạp dữ liệu synthetic vào `psql-agri-bt05a1` (PostgreSQL 17.11):

| Nhóm dữ liệu | Số bản ghi | Chi tiết |
| --- | ---: | --- |
| Nghiệp vụ lõi | 3.845.117 | `bookings`: 1.920.334; `jobs`: 240.001; `applications`: 960.001; `offers`: 720.001; `fields`: 4.108; `users`: 672 |
| Sự kiện | 4.560.342 | `booking_events`: 1.920.337; `recruitment_events`: 2.640.005 |
| Khóa chống xử lý trùng | 1.920.334 | `idempotency_keys` chiếm 46,9% dung lượng DB, chủ yếu do lưu JSON snapshot. |
| Vai trò và danh mục | 680 | `user_roles`: 676; `services`: 4 |

**0 byte ảnh trong PostgreSQL**: các bảng ứng dụng không có cột `bytea` và `pg_largeobject` không có bản ghi. PostgreSQL chỉ lưu metadata của ảnh; bản gốc và thumbnail nằm trong Azure Blob Storage riêng tư. `pg_database_size` sau khi tạo chỉ mục: **4.497.348.275 byte (4,188 GiB)**, vượt ngưỡng 4 GB của BT05.

Trên 720.001 dòng `offers`, chỉ mục `offers_job_status_idx` (`job_id`, `status`) giảm thời gian thực thi truy vấn danh sách tin tuyển đo bằng `EXPLAIN (ANALYZE, BUFFERS)` từ **2.086,914 ms** xuống **0,510 ms** (giảm 99,98%). Với `GET /api/jobs` từ ngoài Azure, trung vị giảm từ **2.390,86 ms** (3 lượt) xuống **361,95 ms** (5 lượt), giảm 84,9%. Đây là phép đo riêng sau khi nạp dữ liệu, không phải kết quả trong bảng hai vùng dưới đây.

[Benchmark CL-12](https://github.com/pckienuit/AgriDispatchVN/blob/15c55107dce6111b237bad9da6e134f81b52164d/docs/benchmark-cl12.md): độ trễ là trung vị của p95 theo lượt, đơn vị ms. Mỗi ca đã đo có 30/30 lượt hợp lệ.

| Ca đo | Local | Japan East | Central India (app) / Indonesia Central (DB theo hồ sơ nhóm) |
| --- | ---: | ---: | ---: |
| Đọc (`/health`, `/api/services`, `/api/jobs`) | 6 | 128,5 | 182 |
| Tạo đơn | 33,5 | 196 | 864 |
| Tuyển thợ | 98 | Chưa đo | Chưa đo |

Số đo cloud gồm độ trễ Internet từ Việt Nam, không phải SLA. Ca tuyển thợ chưa chạy trên hai vùng vì tài khoản thử chưa được duyệt vai trò.

### Công cụ BT05

| Công cụ | Kết quả và giới hạn |
| --- | --- |
| Azure Container Registry (ACR) | `acris402agri` lưu image theo SHA; đã đối chiếu digest của bản staging. |
| Azure Kubernetes Service (AKS) | `aks-agri-bt05a1` chạy account-service. [Ca kiểm CL-08](https://github.com/pckienuit/AgriDispatchVN/blob/5f420a2449672da581e36b44f22f7e19a88fc847/docs/cl-08-evidence.md) trong Job cô lập xác nhận Booking trả 503 và không ghi đơn khi Account không phản hồi. |
| Azure Web Apps | [Blue/Green CL-07](https://github.com/pckienuit/AgriDispatchVN/blob/6b3f6aa4708d6a86ddb7aa900e034e133eea917d/docs/cl-07-evidence.md) đã chuyển từ A sang B rồi về A. Lượt riêng xác nhận `/ready` trả 503 ở slot B thì cổng readiness chặn swap. |
| Azure Key Vault | Staging dùng `kv-agri-bt05a1` cho tham chiếu bí mật kết nối DB và xác thực giữa dịch vụ. |
| Azure Monitor | [CL-11](https://github.com/pckienuit/AgriDispatchVN/blob/c61e6d40475bee9bf37d63361ae2b606d40e9d6b/docs/cl-11-evidence.md): `law-agri-bt05a1` ghi log của ba dịch vụ trong `AppServiceConsoleLogs`, `ContainerLogV2` và `FunctionAppLogs`. Alert thử `cl11-booking-demo-401` đã phát, tự hết cảnh báo rồi được tắt. ActualCost của RG là 2,077631 USD trước thuế lúc 23:14 ngày 23/11 (UTC+7) và 6,60 USD trên Azure Portal Cost Analysis ngày 24/11; Budget 49 USD/tháng chỉ gửi cảnh báo, không ngắt chi tiêu. |
| Azure DevOps | [Run #2](https://dev.azure.com/agridispatch-is402-bt05/AgriDispatchVN/_build/results?buildId=2) build và deploy Web Apps B1 sau khi push nhánh `demo/cl05-b1`. |
| Jenkins | [Build #3](https://github.com/pckienuit/AgriDispatchVN/blob/4b8aa3c5e4b8125063d8f43b7fdb366c66eb3285/docs/cl-05-evidence.md) chạy trên Docker local, xuất manifest; chưa chạy trên controller cloud. |
| Terraform | Đã chạy `fmt`, `validate` và 23 mock test; chưa `terraform apply` lên resource group dùng chung. |

GitHub Actions là CI bổ sung, không thay Azure DevOps hay Jenkins. [Ca test cố ý thất bại](https://github.com/pckienuit/AgriDispatchVN/actions/runs/44783268975) xác nhận cổng kiểm thử chặn publish image lên ACR.

## Bắt đầu nhanh

```bash
npm ci
cp .env.example .env
docker compose --env-file .env -f infra/compose.yaml up --build -d --wait db account app
docker compose --env-file .env -f infra/compose.yaml exec app npm run db:migrate
curl http://127.0.0.1:3000/ready
```

Trước khi chạy Compose, đặt `POSTGRES_PASSWORD` local và `INTERNAL_SERVICE_TOKEN` ngẫu nhiên ít nhất 32 ký tự trong môi trường riêng; không commit hoặc dùng credential mẫu cho cloud. `/` phục vụ UI; nghiệp vụ cần cả account-service và DB đã migration. Seed danh mục synthetic bằng bước riêng trong [hướng dẫn phát triển](docs/development.md). Không tự tạo admin thật; quyền mẫu được cấp riêng trong fixture kiểm thử.

## Bài thực hành 5: Kiểm thử (IE104)

Cài dependencies bằng `npm ci`, chuẩn bị Node.js 26, Chromium (mặc định tìm `chromium` trên `PATH`, hoặc đặt `CHROMIUM_BIN`), và Docker local đang chạy với quyền gọi `docker`. Sau đó chạy toàn bộ bằng một lệnh:

```bash
npm run test:btth5
```

- `tests/unit/`: 9 ca logic UI/API, không cần mạng hay PostgreSQL.
- `tests/integration/`: 6 ca HTTP qua gateway, account-service và PostgreSQL thật.
- `tests/e2e/`: 3 ca UI v2 bằng Chromium/CDP trên cùng stack thật; mỗi ca dùng profile trình duyệt riêng.

Runner mặc định tạo PostgreSQL 17 tạm bằng ảnh `postgres:17-alpine`, dùng ổ `tmpfs` và cổng loopback ngẫu nhiên. Docker có thể cần mạng để tải ảnh lần đầu. Nếu đã có PostgreSQL test, đặt `TEST_DATABASE_URL` trong môi trường trỏ tới DB riêng tên `*_test` trên loopback, tài khoản có quyền `CREATEDB`. Runner không đọc `.env` hay `DATABASE_URL` của dev. Mỗi ca integration/E2E tự tạo và migrate DB ngẫu nhiên, mở hai cổng HTTP tạm, rồi đóng server, pool và xóa DB của ca. Runner xóa container do nó tạo khi kết thúc; không xóa DB gốc do người chạy cấu hình.

[Kế hoạch](docs/TEST_PLAN.md) · [Bảng ca kiểm thử](docs/TEST_CASES.md) · [Log và coverage](docs/test-results.txt) · [Lỗi ghi nhận](docs/BUGS.md)

## Tài liệu

- [Kiến trúc](docs/architecture.md)
- [Phát triển](docs/development.md)
- [Sinh dữ liệu synthetic local](docs/synthetic-data.md)
- [Cloud (kế hoạch)](docs/cloud.md)
- [Thumbnail Function và giới hạn minh chứng](functions/README.md)
- [Khôi phục upload treo](docs/evidence-recovery.md)
- `AGENTS.md`: quy ước làm việc trong repo phát triển
- [web/README.md](web/README.md) và [db/README.md](db/README.md)

## Yêu cầu

- Node.js 26 LTS
- npm
- Docker và Docker Compose (tùy chọn, để chạy PostgreSQL và app bằng container)
