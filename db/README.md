# db/

Thư mục chứa file migration SQL cho PostgreSQL 17.

## Trạng thái

- Chưa có migration nghiệp vụ. Schema nghiệp vụ chưa được thiết kế trong repo này.
- Bảng `schema_migrations` do runner tạo khi chạy lần đầu.

## Quy tắc

- Mỗi thay đổi schema là một file mới trong `db/migrations/`, đặt tên có thứ tự tăng dần (ví dụ `001_ten_thay_doi.sql`). Xem [quy tắc runner](migrations/README.md).
- Không sửa file đã áp dụng. Checksum sẽ báo lỗi nếu file đã áp dụng bị thay đổi.
- Không tạo hay sửa `schema_migrations` bằng tay.
- Không chạy migration khi app khởi động. Chạy bằng `npm run db:migrate`.
- Test migration thật: `npm run test:integration` với `TEST_DATABASE_URL` trỏ tới DB dùng một lần.
