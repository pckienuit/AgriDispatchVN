# AgriDispatch VN

Nền tảng điều phối dịch vụ cơ giới hóa nông nghiệp Việt Nam, trọng tâm ĐBSCL.

Nhánh cloud đang triển khai ứng dụng trên nền Express 5, PostgreSQL 17, migration, Docker và CI. Hai service nghiệp vụ dùng HTTP để kiểm danh tính.

## Trạng thái

- Có account-service: đăng ký/đăng nhập, session lưu PostgreSQL, giới hạn thử sai và phân quyền không cho tự nâng vai trò.
- Có danh mục dịch vụ, thửa ruộng và máy theo chủ sở hữu. Booking-service gọi account-service thật qua HTTP; API từ chối khi không xác minh được danh tính.
- Seed danh mục có nhãn synthetic, giá chỉ dùng thử. Chưa có dữ liệu thực địa trong DB.
- Đặt dịch vụ, điều phối, tuyển thợ và các luồng mở rộng đang triển khai, chưa coi là hoàn tất.
- Contract và các mốc bàn giao: [docs/api.md](docs/api.md), [docs/cloud-stages.md](docs/cloud-stages.md).
- Có UI cloud JavaScript thuần: đăng ký/đăng nhập, catalog, chi tiết dịch vụ, thửa ruộng, gửi/xem đơn và lịch sử. Chưa có UI điều phối hoặc tuyển thợ. Đây không phải bản Figma nhóm UX/UI đã nghiệm thu.
- Chưa triển khai lên cloud. Xem [docs/cloud.md](docs/cloud.md) cho kế hoạch và các điều kiện cần.
- Không phải bản production.

## Bắt đầu nhanh

```bash
npm ci
cp .env.example .env
docker compose --env-file .env -f infra/compose.yaml up -d --wait db
npm run db:migrate
npm run dev
curl http://127.0.0.1:3000/health
```

Chạy `curl` từ terminal thứ hai. `/` trả 404 vì chưa có frontend. Chi tiết cài đặt, biến môi trường và lệnh: [docs/development.md](docs/development.md).

## Tài liệu

- [Kiến trúc](docs/architecture.md)
- [Phát triển](docs/development.md)
- [Sinh dữ liệu synthetic local](docs/synthetic-data.md)
- [Cloud (kế hoạch)](docs/cloud.md)
- [AGENTS.md](AGENTS.md): quy ước cho người và agent làm việc trong repo
- [web/README.md](web/README.md) và [db/README.md](db/README.md)

## Yêu cầu

- Node.js 26 LTS
- npm
- Docker và Docker Compose (tùy chọn, để chạy PostgreSQL và app bằng container)
