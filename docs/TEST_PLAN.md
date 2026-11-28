# Kế hoạch kiểm thử BTTH5 | AgriDispatch VN

IE104.R11, nhóm N02. Phân vai đề xuất khi trình bày: Kiên tổng hợp và chạy bộ test, Thiện giải thích Unit/Integration, Hiếu trình bày E2E và lỗi. Cả nhóm chuẩn bị vấn đáp cả ba mức.

## Phạm vi và rủi ro

Điểm từ 1 (thấp) đến 3 (cao). Điểm rủi ro bằng tần suất × thiệt hại; đây là ước lượng của nhóm, không phải số liệu sử dụng.

| Chức năng | Tần suất (1–3) | Thiệt hại (1–3) | Điểm rủi ro |
| --- | ---: | ---: | ---: |
| Đăng nhập, phiên và vai trò | 3 | 3 | 9 |
| Đặt dịch vụ và tính tiền tạm tính | 3 | 3 | 9 |
| HTX gom đơn thành gói | 2 | 3 | 6 |

Không vào được tài khoản thì không thể đặt dịch vụ. Đơn sai lịch, sai giá hoặc bị trùng ảnh hưởng trực tiếp đến nông dân. Gom sai khung giờ có thể khiến HTX điều phối một gói không thực hiện được.

## Chiến lược

- **Đăng nhập:** Unit kiểm chuẩn hóa số điện thoại và quy tắc chọn màn theo vai trò. Integration kiểm phản hồi API, phiên trong DB và thu hồi khi đăng xuất. E2E kiểm nhập sai, đăng nhập lại, trở về đúng trang và chặn màn HTX với tài khoản nông dân.
- **Đặt dịch vụ:** Unit kiểm biên thời gian và cách làm tròn tiền ở UI/API. Integration kiểm khóa chống trùng, dữ liệu đã lưu và trường hợp phải từ chối. E2E kiểm từ chọn dịch vụ đến đọc lại đơn và sửa báo giá qua trình duyệt.
- **Gom gói:** Unit kiểm số lượng đơn và giao lịch. Integration kiểm quyền HTX, chuyển đơn sang `GROUPED` trong giao dịch và từ chối nếu lịch chỉ chạm mốc. Không lặp lại luồng này ở E2E vì rủi ro chính nằm ở quy tắc và dữ liệu lưu.

Tháp kiểm thử: **9 Unit, 6 Integration, 3 E2E**. Phần lớn ca biên chạy ở tầng Unit, chỉ đi qua trình duyệt cho luồng cần kiểm giao diện hoặc điều hướng.

## Ngoài phạm vi

Không kiểm xếp máy/thợ, dời lịch, nghiệm thu, thanh toán, tranh chấp, tải lớn hay hạ tầng cloud. Các phần đó cần dữ liệu hoặc môi trường riêng, không làm rõ ba rủi ro trên.

## Môi trường và cách chạy

Node.js 26 (`node:test`), Express qua HTTP loopback, PostgreSQL 17 tách biệt và Chromium headless qua CDP. Runner dùng container PostgreSQL tạm hoặc `TEST_DATABASE_URL` riêng (`*_test` trên loopback). Mỗi ca Integration/E2E tạo DB mới, áp migration rồi dọn; không đọc `.env` dev. Chạy toàn bộ: `npm run test:btth5`.
