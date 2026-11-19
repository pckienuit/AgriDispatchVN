# Chuyển giao diện sản phẩm sang demo v2

Ngày quyết định: 19/11/2026, trưởng dự án Kiên chốt trong chat. Nhánh làm việc: `feat/ui-demo-v2`, tách từ `cloud/is402-2026-11-24` (`af69cc5`). Không merge vào nhánh cloud hay `main` khi chưa được duyệt riêng.

## Vì sao

UI hiện tại của nhánh cloud đi theo một luồng chung kiểu cửa hàng (Dịch vụ, Gửi yêu cầu, Đơn của tôi) với một menu cho mọi vai trò. Demo v2 (`agri-rent-demo.vercel.app`, nguồn `demo/app/` trong workspace nghiên cứu, commit `0ff353c`) chia giao diện theo vai trò: nông dân dùng di động, chủ máy dùng máy tính bảng, thợ lái có màn ca máy nút lớn, HTX và quản trị dùng màn máy tính. Demo v2 là chuẩn giao diện cho sản phẩm.

## Quyết định

| Mã | Nội dung chốt |
| --- | --- |
| D1 | Báo cáo IS402 ngày 24/11 trình bày giao diện bằng bản demo trên Vercel. Bản demo dùng dữ liệu mô phỏng trong trình duyệt, không gọi API của bản triển khai cloud; khi trình bày phải nói rõ điều này. |
| D2 | Demo v2 là UI chuẩn. Được sao chép thành phần giao diện, token, khung vai trò và bố cục màn của demo vào `web/`. Không mang theo kho dữ liệu `localStorage`, đồng hồ mô phỏng hay ngăn "Điều khiển demo". Figma của IE106 vẫn làm riêng. |
| D3 | Khi demo khác quy tắc nghiệp vụ đã chốt, theo quy tắc đã chốt: dời lịch cả gói trước khi ca bắt đầu, mọi chủ đơn và chủ máy tự đồng ý cùng phiên bản (18/11); khiếu nại cần đồng thuận độc lập hai bên (14/11); nền tảng không giữ hay chuyển tiền. Demo chỉ quyết định giao diện. |
| D4 | Đăng nhập bằng số điện thoại và mật khẩu, bố cục theo màn C-01. Không gửi OTP thật. |
| D5 | Có cọc (F-09). Cọc là bản ghi chuyển khoản ngoài hệ thống, bên trả báo và bên nhận xác nhận. Chỉ mở sau khi chủ máy nhận gói và HTX gọi xác nhận. Mã VietQR và mức 10% gắn nhãn mô phỏng, giả định. |
| D6 | Theo dõi máy và buồng lái (F-10, O-02, H-06) dùng telemetry mô phỏng phía server, có nhãn mô phỏng. |
| D7 | Chưa chốt: HTX có thẩm định thực địa trước ca (H-04) không; HTX hòa giải cấp 1 kèm tránh xung đột lợi ích hay giữ quản trị độc lập; có địa bàn HTX và giới hạn 3 HTX mỗi xã (H-01, A-02) không. Không làm các màn này khi chưa chốt. |
| D8 | Phí phần mềm, hoa hồng HTX, phí tháng chủ máy chỉ hiển thị số giả định, không thu phí. |
| D9 | Gom cụm theo bán kính 1,5 km và ngưỡng diện tích chỉ là gợi ý có nhãn giả định; HTX chốt tay. |
| D10 | Luồng chính theo dịch vụ gặt. Danh mục giữ 3 dịch vụ mô phỏng. |

## Giai đoạn

Mỗi giai đoạn là một hoặc vài commit nhỏ, mỗi commit đạt lint, unit, integration và browser. Không push khi chưa được duyệt.

1. Phase 0: token, CSS, font, icon, bộ thành phần `ui`, khung vai trò và router `#/<vai-trò>/<mã>` dạng ES module, nối API thật. UI mới phát triển ở `web/v2/` để UI cũ và bộ kiểm thử trình duyệt cũ vẫn chạy cho tới khi thay thế xong.
2. Phase 1: 21 màn đã có API, gồm tranh chấp, tuyển thợ, ca máy, duyệt vai trò, hoạt động và dời lịch.
3. Phase 2: 22 màn cần mở rộng API và DB, gồm ranh thửa (JSON tọa độ, server tính diện tích, không bật PostGIS), thông tin đặt gặt, phụ phí giả định, hồ sơ máy và thợ, trạng thái ca, tin tuyển, tiền công, tham số quản trị.
4. Phase 3: 9 màn chưa có, sau khi chốt D7.

Bảng đối chiếu 52 màn nằm ở [ui-demo-v2-screens.md](ui-demo-v2-screens.md). Kế hoạch thực thi: [ui-demo-v2-plan.md](ui-demo-v2-plan.md).
