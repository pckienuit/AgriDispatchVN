# SQL migrations

Chưa có schema nghiệp vụ. Runner chỉ tạo bảng kỹ thuật `schema_migrations`.

CLI dùng pool riêng với timeout SQL/chờ lock 60 giây, client timeout 61 giây; API vẫn giới hạn 5 giây. Migration vượt giới hạn sẽ thất bại, cần xem xét riêng trước khi tăng timeout. CLI in mã lỗi an toàn; lỗi PostgreSQL không in SQL hoặc thông tin kết nối.

Đặt file theo thứ tự `001_description.sql`, mỗi số dùng một lần. Không sửa/xóa migration đã áp dụng; thêm migration mới. Mỗi file chạy trong một transaction, không đặt `BEGIN`/`COMMIT` trong SQL. Không dùng `CREATE INDEX CONCURRENTLY` trong runner này.

Runner giữ advisory lock, kiểm checksum lịch sử, từ chối file thiếu hoặc chèn trước lịch sử đã chạy. Chạy `npm run db:migrate` từ repo root; đường dẫn migration được resolve từ script, không phụ thuộc CWD. Backup và xét kế hoạch khôi phục trước migration có nguy cơ mất dữ liệu; runner không tự rollback các migration đã commit trước đó.
