# Cloud (kế hoạch)

## Trạng thái

- Chưa tạo tài nguyên cloud nào.
- Chưa có pipeline deploy tự động. CI chỉ gồm lint, test, integration và build image.
- CI có build app, test image và Function image; processor/adapter được chạy trong runtime Functions Node 24. Chưa publish image vào registry hay có digest release đã deploy.
- Không cam kết gói miễn phí, chi phí hay region. Kiểm tra trên trang chính thức của Azure trước khi quyết định.

## Hướng triển khai dự kiến

- Azure App Service (Linux container) chạy image của app.
- Azure Database for PostgreSQL Flexible Server.
- Azure Blob Storage cho tệp tĩnh hoặc tệp đính kèm sau này. Chưa triển khai.
- Tệp bằng chứng đã có API/UI riêng tư; Blob trigger/thumbnail chạy local với Azurite và endpoint mô phỏng. Phân biệt mã nguồn chạy được với dịch vụ Azure đã cấp quyền và triển khai.

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

## Điều kiện cloud còn chặn

- Ngân sách đã chốt: tối đa 50% credit còn lại lúc bắt đầu chi, không tiền ngoài credit. Ảnh portal do người dùng cung cấp ngày 18/11/2026 hiển thị 86,06 USD, tương ứng trần 43,03 USD; cần đọc lại trước hành động tính phí, không coi ngân sách này được dành riêng nếu tài nguyên khác vẫn dùng cùng credit.
- Spending limit đã đọc là On. Đây không thay thế kiểm chi phí và không tự bảo đảm dịch vụ tiếp tục chạy khi hết credit.
- Quota API App Service trả Japan East 0/1 và Korea Central 0/0; hiện có plan Azure Bot riêng nên chưa coi Japan East còn chỗ. SKU trong danh mục không chứng minh provision được. Không dùng thao tác tạo tài nguyên để thử quota khi chưa qua điều kiện chi phí/quyền.
- Không tái sử dụng hoặc nâng gói `rg-is402` của Azure Bot cho BT05. Giữ riêng tài nguyên và minh chứng.
- Function image chứa toàn bộ host, không phải worker-only container của Flex Consumption. Cần hosting tương thích; phương án chia sẻ S1 với hai web app là đề xuất chưa triển khai, có tranh chấp CPU/RAM khi đo tải.
- Dự toán phải gồm thời gian tồn tại tài nguyên, DB storage/backup, Blob/host storage, registry, log, network và phần dự phòng. Các ví dụ compute-only không phải tổng chi phí hay phê duyệt chi.

Trong lúc chờ xác minh quota, tiếp tục build/test, nguồn bàn giao và runbook local. Không tạo pipeline tự deploy vào target chưa xác nhận.
