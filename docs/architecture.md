# Kiến trúc

## Tổng quan

Hai process Node.js dùng Express 5 và PostgreSQL 17 qua `pg`: account-service giữ tài khoản/session, booking-service giữ danh mục, thửa, máy, đơn và tuyển thợ. Booking-service gọi HTTP tới account-service để xác minh token; khi đối tác lỗi, thao tác được bảo vệ trả 503 thay vì bỏ qua xác thực. Chưa có queue hoặc Function chạy cloud.

## Thành phần

| Đường dẫn | Vai trò |
| --- | --- |
| `server/src/app.js` | `createApp({ pool })` tạo Express app: `/health`, `/ready`, phục vụ `web/` và 404 JSON |
| `server/src/config.js` | `readConfig(env)` đọc và kiểm tra biến môi trường |
| `server/src/db.js` | `createPool` tạo pool PostgreSQL |
| `server/src/server.js` | Điểm vào: khởi động HTTP và tắt êm |
| `server/scripts/migrate.js` | Runner migration |
| `db/migrations/` | Migration tài khoản, catalog, booking và tuyển thợ theo thứ tự |
| `web/` | Tài sản tĩnh; chưa có giao diện |
| `infra/Dockerfile`, `infra/compose.yaml` | Image container và stack chạy local |

## Luồng HTTP

- `GET /health`: liveness. Trả JSON, không truy vấn DB.
- `GET /ready`: chạy `SELECT 1`. Khi DB không phản hồi, trả 503.
- Route không tồn tại: 404 JSON.
- `web/` được phục vụ như tài sản tĩnh. File dotfile (ví dụ `.env`) bị chặn.

## Vòng đời

- Khởi động: đọc config, tạo pool, tạo app, lắng nghe trên `0.0.0.0` với cổng lấy từ `PORT`.
- Tắt: ngừng nhận kết nối mới, chờ request đang xử lý, đóng HTTP server, rồi đóng pool DB.

## Migration

- App không tự chạy migration khi khởi động. Chạy bằng `npm run db:migrate` như một bước riêng.
- Runner lấy advisory lock để tránh chạy đồng thời, lưu checksum trong `schema_migrations` và chạy mỗi migration trong một transaction.
- `schema_migrations` do runner tạo. Không tạo hay sửa tay.
- Checksum phát hiện file đã áp dụng bị thay đổi.

## Ranh giới hiện tại

- Xác thực, catalog, booking và tuyển thợ đã có API/test PostgreSQL local. Bản UI và các luồng điều phối/ca/khiếu nại đang triển khai. Không coi API local là dịch vụ production đã nghiệm thu.
- Chưa có production readiness. Kế hoạch cloud xem [cloud.md](cloud.md).
