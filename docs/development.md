# Phát triển

## Yêu cầu

- Node.js 26 LTS và npm
- PostgreSQL 17 (cài local hoặc chạy qua Docker Compose)
- Docker và Docker Compose (tùy chọn)

## Cài đặt

```bash
npm ci
cp .env.example .env
```

`npm ci` dùng `package-lock.json` đã commit.

## Biến môi trường

| Biến | Ghi chú |
| --- | --- |
| `DATABASE_URL` | Chuỗi kết nối PostgreSQL. Production lấy từ môi trường, không commit. |
| `PORT` | Cổng app đọc khi chạy. Giá trị dev nằm trong `.env.example`. |
| `TEST_DATABASE_URL` | Chỉ dùng cho `npm run test:integration`. Tên DB phải kết thúc `_test`. Test xóa toàn bộ schema `public`; tuyệt đối không trỏ DB dùng chung. |
| `APP_PORT` | Compose: cổng trên máy host map tới app. Mặc định 3000, bind `127.0.0.1`. |
| `PG_PORT` | Compose: cổng trên máy host map tới PostgreSQL. Mặc định 5433, bind `127.0.0.1`. |

Thông tin đăng nhập mẫu chỉ dành local, không dùng cho production. Compose đọc `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`; URL nội bộ app dùng hostname `db`, còn lệnh npm trên host dùng `DATABASE_URL`. Nếu đổi mật khẩu, phải URL-encode khi đưa vào URL; Compose local hiện dùng mẫu chữ/số/underscore. Profile test dùng thông tin riêng, không đọc password DB ứng dụng.

## Lệnh

| Lệnh | Việc làm |
| --- | --- |
| `npm run dev` | Chạy server, tự khởi động lại khi đổi file |
| `npm start` | Chạy server không watch |
| `npm test` | Unit test và test HTTP/config bằng `node:test` |
| `npm run test:integration` | Test DB và migration thật, cần `TEST_DATABASE_URL` |
| `npm run lint` | Chạy `eslint .` |
| `npm run db:migrate` | Áp dụng migration |

Kiểm tra nhanh sau khi chạy dev:

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
```

`/ready` trả 503 khi không kết nối được DB.

## Docker Compose (local)

```bash
docker compose --env-file .env -f infra/compose.yaml up --build -d
docker compose --env-file .env -f infra/compose.yaml exec app npm run db:migrate
docker compose --env-file .env -f infra/compose.yaml down
```

- Service `app` chạy ở chế độ production. Service `db` dùng PostgreSQL 17 với hostname nội bộ `db`.
- Compose không tự chạy migration. Chạy `npm run db:migrate` như bước riêng.
- Chạy toàn bộ lint/test trong container bằng DB riêng dùng một lần:

```bash
docker compose --env-file .env -f infra/compose.yaml --profile test run --build --rm test
docker compose --env-file .env -f infra/compose.yaml --profile test down
```

Profile test bind PostgreSQL ở `127.0.0.1:5434`, dùng tmpfs cho dữ liệu. Không chạy đồng thời hai bộ integration test trên cùng DB. `down` giữ volume DB ứng dụng; `down -v` xóa dữ liệu nên chỉ dùng khi cố ý reset local.

Nếu chạy integration từ host: khởi động `docker compose --env-file .env -f infra/compose.yaml --profile test up -d test-db` trước, rồi `npm run test:integration`. `.env.example` khớp thông tin của DB test này.

## Làm việc theo task

- Tạo branch `feat/<ma-task>-<mo-ta>` hoặc `fix/<ma-task>-<mo-ta>` từ `main`; một PR tập trung một task.
- Người nhận task thêm module và test khi bắt đầu; không dựng trước hàng loạt module rỗng.
- Chỉ dùng dữ liệu giả lập có nhãn. Không đưa workspace demo/nghiên cứu vào dependency của repo.
- Chưa có branch protection hay lời mời collaborator; quyền truy cập team cần chủ repo cấp riêng.

## Quy tắc khi thay đổi

- Không commit `.env` hay secret.
- Migration mới là file mới. Không sửa file đã áp dụng.
- Trước khi mở PR, chạy các lệnh liên quan trong [pull_request_template](../.github/pull_request_template.md).
