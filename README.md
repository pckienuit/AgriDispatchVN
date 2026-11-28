# AgriDispatch VN

Nền tảng điều phối dịch vụ cơ giới hóa nông nghiệp Việt Nam, trọng tâm ĐBSCL.

Nhánh cloud đang triển khai ứng dụng trên nền Express 5, PostgreSQL 17, migration, Docker và CI. Hai service nghiệp vụ dùng HTTP để kiểm danh tính.

## Trạng thái

- Có account-service: đăng ký/đăng nhập, session lưu PostgreSQL, giới hạn thử sai và phân quyền không cho tự nâng vai trò.
- Có danh mục dịch vụ, thửa ruộng và máy theo chủ sở hữu. Booking-service gọi account-service thật qua HTTP; API từ chối khi không xác minh được danh tính.
- Seed danh mục có nhãn synthetic, giá chỉ dùng thử. Chưa có dữ liệu thực địa trong DB.
- Đã có luồng local: đặt dịch vụ, HTX gom đơn, phân máy/thợ, tuyển thợ, ca làm, nghiệm thu, ghi nhận chuyển tiền bên ngoài, khiếu nại/hòa giải và hoãn lịch có đồng thuận từng bên.
- Contract và các mốc bàn giao: [docs/api.md](docs/api.md), [docs/cloud-stages.md](docs/cloud-stages.md).
- UI JavaScript thuần có các luồng trên, hoạt động trong app, upload bằng chứng riêng tư và hàng chờ quản trị duyệt vai trò. Đây không phải bản Figma nhóm UX/UI đã nghiệm thu.
- Có processor thumbnail, container Azure Functions Node 24 và công cụ khôi phục upload treo. Host/trigger/output/replay đã kiểm local với Azurite và endpoint mô phỏng có nhãn; chưa chứng minh managed identity/RBAC hay invocation Azure thật.
- Chưa triển khai lên cloud. Xem [docs/cloud.md](docs/cloud.md) cho kế hoạch và các điều kiện cần.
- Không phải bản production.

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
- [AGENTS.md](AGENTS.md): quy ước cho người và agent làm việc trong repo
- [web/README.md](web/README.md) và [db/README.md](db/README.md)

## Yêu cầu

- Node.js 26 LTS
- npm
- Docker và Docker Compose (tùy chọn, để chạy PostgreSQL và app bằng container)
