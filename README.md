# AgriDispatch VN

Nền tảng điều phối dịch vụ cơ giới hóa nông nghiệp Việt Nam, trọng tâm ĐBSCL.

Repo này hiện chỉ là scaffold nền: server Express 5, kết nối PostgreSQL 17, runner migration, cấu hình container và CI.

## Trạng thái

- Chưa có nghiệp vụ, xác thực hoặc dữ liệu thật.
- Chưa có frontend. `web/` chưa có `index.html`; giao diện đang được thiết kế lại.
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
- [Cloud (kế hoạch)](docs/cloud.md)
- [AGENTS.md](AGENTS.md): quy ước cho người và agent làm việc trong repo
- [web/README.md](web/README.md) và [db/README.md](db/README.md)

## Yêu cầu

- Node.js 26 LTS
- npm
- Docker và Docker Compose (tùy chọn, để chạy PostgreSQL và app bằng container)
