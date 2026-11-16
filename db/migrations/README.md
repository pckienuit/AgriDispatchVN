# SQL migrations

Chưa có schema nghiệp vụ. Runner chỉ tạo bảng kỹ thuật `schema_migrations`.

Đặt file theo thứ tự `001_description.sql`, mỗi số dùng một lần. Không sửa/xóa migration đã áp dụng; thêm migration mới. Mỗi file chạy trong một transaction, không đặt `BEGIN`/`COMMIT` trong SQL. Không dùng `CREATE INDEX CONCURRENTLY` trong runner này.

Runner giữ advisory lock, kiểm checksum lịch sử, từ chối file thiếu hoặc chèn trước lịch sử đã chạy. Chạy `npm run db:migrate` từ repo root; đường dẫn migration được resolve từ script, không phụ thuộc CWD. Backup và xét kế hoạch khôi phục trước migration có nguy cơ mất dữ liệu; runner không tự rollback các migration đã commit trước đó.
