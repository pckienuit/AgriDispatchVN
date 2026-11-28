# Lỗi ghi nhận trong BTTH5

Hai lỗi giao diện tái hiện khi chạy `TC-18`. Bản bàn giao sửa mã giao diện và giữ nguyên kiểm tra hành vi tương ứng. Lần chạy cuối trong [test-results.txt](test-results.txt) ghi kết quả sau sửa.

## BUG-01: Quay lại từ báo giá làm mất lịch đã nhập

1. **Mã và tiêu đề:** `BUG-01`, nút sửa ở F-06 mở F-05 nhưng không giữ lịch.
2. **Bước tái hiện:** Dùng nông dân chọn thửa và dịch vụ gặt ở F-05, nhập 15:00–19:00 ngày 01/12/2026 (giờ địa phương). Mở F-06, tải lại trang, đăng nhập lại theo thiết kế, chọn **Sửa thông tin đặt dịch vụ**.
3. **Kỳ vọng / thực tế:** F-05 phải điền lại 15:00–19:00 ngày 01/12. Trước sửa, hai ô hiện mặc định 12:00–22:00 ngày 29/11 ở lần chạy tái hiện, dù không có đơn nào trong DB. Link sửa không mang tham số và tải lại đã xóa bản nháp trong bộ nhớ. Bản sửa đưa thông tin từ báo giá về lại form; ca chạy cuối kiểm cả lịch, lựa chọn và thông tin vụ.
4. **Mức độ:** Trung bình. Có thể gửi nhầm lịch nếu không nhận ra giá trị đã đổi; thao tác sửa chưa tự tạo đơn.
5. **Ca phát hiện:** `TC-18`, [tests/e2e/browser.test.js](../tests/e2e/browser.test.js). Lỗi tái hiện trên mã ứng dụng từ `7326791`; test hồi quy đã Pass sau sửa `web/v2/screens/farmer.js`.

## BUG-02: Đăng nhập lại không trở về báo giá có thông tin vụ

1. **Mã và tiêu đề:** `BUG-02`, C-01 bỏ đích trở về của báo giá khi URL dài quá 200 ký tự.
2. **Bước tái hiện:** Làm như BUG-01 nhưng nhập thêm giống `OM 5451`, ngày sạ 01/09/2026, ngày gặt 01/12/2026 trước khi mở F-06. Tải lại ở F-06 rồi đăng nhập lại.
3. **Kỳ vọng / thực tế:** Đăng nhập phải quay lại F-06 và hiện `Tổng tạm tính`. Trước sửa, Chromium không thấy F-06 sau khi đăng nhập; kiểm tra router riêng xác nhận đích dài 217 ký tự bị loại khỏi tham số `tiep`. Bản sửa nới giới hạn riêng cho `tiep`, giữ bước kiểm đích nội bộ (`safeNext`) và giới hạn 200 của các tham số khác.
4. **Mức độ:** Trung bình. Người dùng không trở lại báo giá đang xem, phải mở lại luồng đặt dịch vụ.
5. **Ca phát hiện:** `TC-18`, [tests/e2e/browser.test.js](../tests/e2e/browser.test.js). Test hồi quy đã Pass sau sửa `web/v2/app/routes.js`.
