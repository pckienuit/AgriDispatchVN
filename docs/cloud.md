# Cloud (kế hoạch)

## Trạng thái

- Chưa tạo tài nguyên cloud nào.
- Chưa có pipeline deploy tự động. CI chỉ gồm lint, test, integration và build image.
- Không cam kết gói miễn phí, chi phí hay region. Kiểm tra trên trang chính thức của Azure trước khi quyết định.

## Hướng triển khai dự kiến

- Azure App Service (Linux container) chạy image của app.
- Azure Database for PostgreSQL Flexible Server.
- Azure Blob Storage cho tệp tĩnh hoặc tệp đính kèm sau này. Chưa triển khai.

## Điều kiện trước khi triển khai thủ công

1. Xác nhận quota, region và ngân sách trên tài khoản thật.
2. Chọn registry cho image: Docker Hub hoặc Azure Container Registry.
3. GitHub Actions dùng OIDC với quyền tối thiểu. Không lưu credential dài hạn trong repo.
4. Kết nối DB dùng `sslmode=verify-full` với CA tin cậy.
5. Secret không commit. Lưu trong cơ chế secret của nền tảng.
6. Container hiện dùng `/health` làm liveness; CI/CD tương lai dùng `/ready` để kiểm tra kết nối DB trước khi chuyển traffic. App Service Health Check có cơ chế loại instance khỏi cân bằng tải, không đồng nhất Docker liveness; đọc tài liệu Azure và quyết định probe riêng khi triển khai.
7. Deployment slot (blue-green) cần tầng dịch vụ hỗ trợ. Xác nhận trước khi thiết kế quy trình.
8. Migration chạy như tác vụ triển khai riêng, không chạy khi app khởi động.

## Chưa làm

- Blob Storage: chưa triển khai.
- FaaS: chưa triển khai.
- Rubric đo hai service giao tiếp với nhau, FaaS và region: chưa hoàn thành.
- Xác thực và cấu hình production: chưa có.
