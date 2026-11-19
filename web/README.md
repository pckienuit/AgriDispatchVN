# web/

Thư mục tài sản tĩnh. Server phục vụ nội dung ở đây; file dotfile bị chặn.

## Trạng thái

- `index.html` và các module ở gốc là UI nhánh cloud cũ, giữ để bộ kiểm thử trình duyệt hiện có chạy cho tới khi UI mới thay thế xong.
- `v2/` là UI mới phát triển từ demo v2 (`docs/ui-demo-v2.md`), phục vụ tại `/v2/`. Mọi dữ liệu lấy từ API thật; không có dữ liệu giả dự phòng.
- Không đặt dữ liệu khảo sát, thông tin cá nhân hay secret vào đây; mọi thứ trong `web/` có thể được phục vụ công khai.
