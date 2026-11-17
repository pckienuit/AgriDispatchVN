# Hướng dẫn cho agent và người đóng góp

Đọc [README.md](README.md) trước. Repo là scaffold nền, chưa có nghiệp vụ.

## Stack

- JavaScript ES Modules thuần, Node.js 26 LTS.
- Express 5, pg, PostgreSQL 17, ESLint.
- Một root npm package, không dùng workspaces. Không TypeScript, không Bun.
- Giữ `package-lock.json` đã commit. Dùng `npm ci`, không dùng `npm install` để cập nhật lock ngoài ý muốn.

## Lệnh kiểm tra

- `npm run lint`
- `npm test`
- `npm run test:integration` (cần `TEST_DATABASE_URL` trỏ tới DB dùng một lần)

Chỉ báo "đạt" khi đã chạy lệnh và thấy kết quả. Không tự khai kết quả test.

## Ranh giới

- Nhánh `cloud/is402-2026-11-24` đã được duyệt triển khai UI/API theo `docs/api.md` và `docs/cloud-stages.md`. Giữ JavaScript thuần, không sao chép runtime demo hoặc coi giao diện cloud là bản Figma nhóm đã nghiệm thu.
- Không chạy migration khi app khởi động. Migration là bước triển khai riêng (`npm run db:migrate`).
- Không sửa file migration đã áp dụng; thêm file mới.
- Không thêm dependency khi vài dòng code là đủ. Không thêm abstraction hay cấu hình chưa cần.
- Không tạo tài nguyên cloud thật, không thêm pipeline deploy tự động khi chưa có tài khoản, quota và mục tiêu triển khai xác nhận.

## Dữ liệu và bí mật

- Không commit `.env`, secret, token, mật khẩu thật hay chuỗi kết nối production.
- `.env.example` chỉ chứa giá trị dev.
- Không đưa dữ liệu khảo sát, danh sách sinh viên hoặc thông tin nhận diện cá nhân vào repo. Dữ liệu khảo sát nằm ở workspace nghiên cứu riêng và chỉ dùng dạng tổng hợp hoặc đã ẩn danh.

## Quy ước nội dung

- Viết văn bản UI bằng tiếng Việt tự nhiên, cụ thể. Không dùng em-dash trong nội dung UI.
- Không ghi kết quả test, số liệu hay tính năng như đã có khi chưa kiểm chứng.
- Khi làm việc song song, giữ nguyên file người khác đang sửa; chỉ thay đổi phần được giao.
- Tài liệu: giữ ngắn, đúng với trạng thái thật của repo. Kiến trúc và phát triển không lặp lại nhau.
- Source dùng chung IE106, IE104, IS402; báo cáo và slide mỗi môn tách riêng theo rubric. Không coi scaffold cloud là đã hoàn thành yêu cầu IS402.
