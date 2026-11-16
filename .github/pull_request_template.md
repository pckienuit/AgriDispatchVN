# Mô tả thay đổi

<!-- Thay đổi gì và vì sao. -->

## Loại thay đổi

- [ ] Hạ tầng hoặc cấu hình
- [ ] Server
- [ ] Migration DB
- [ ] Tài liệu
- [ ] Khác

## Kiểm tra

- [ ] `npm ci` chạy được
- [ ] `npm run lint` đã chạy và đạt
- [ ] `npm test` đã chạy và đạt
- [ ] `npm run test:integration` đã chạy và đạt (nếu đụng DB hoặc migration)
- [ ] `docker build` đã chạy (nếu đụng `infra/`)
- [ ] Ghi rõ lệnh nào chưa chạy và lý do

## Kiểm tra an toàn

- [ ] Không commit `.env`, secret, token hay chuỗi kết nối thật
- [ ] Không đưa dữ liệu khảo sát hoặc thông tin cá nhân vào repo
- [ ] Migration mới là file mới; không sửa file đã áp dụng
- [ ] Không thêm dependency mới nếu không cần thiết

## Tài liệu

- [ ] Đã cập nhật `docs/` liên quan, hoặc không cần
- [ ] Không mô tả tính năng hay tài nguyên cloud như đã có khi chưa triển khai
