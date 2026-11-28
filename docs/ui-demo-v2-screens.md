# Đối chiếu 52 màn demo v2 với UI nhánh cloud

Nguồn demo: agri-rent-demo.vercel.app (khớp commit 0ff353c). Sản phẩm: AgriDispatchVN nhánh cloud/is402-2026-11-24, commit af69cc5. Ngày đối chiếu 19/11/2026.

| Mã | Vai trò | Lõi | Màn | Yêu cầu | Số trạng thái | Phân loại | UI sản phẩm hiện có | Ghi chú |
|---|---|---|---|---|---|---|---|---|
| C-01 | chung | Có | Đăng nhập | FR-01 | 6 | Chưa có, cần Kiên quyết | #login, #register (email+mật khẩu) | Demo đăng nhập SĐT+OTP mô phỏng. OTP thật cần SMS trả phí. |
| C-02 | chung |  | Chọn vai trò và hồ sơ cơ bản | FR-01, Luật 91/2025 | 2 | Có nền, mở rộng API/DB | #roles (xin vai trò) | Thiếu đồng ý dữ liệu vị trí (Luật 91/2025), đơn vị công. |
| C-03 | chung |  | Thông báo | FR-16, FR-26 | 2 | Có API, port giao diện | #activity | Chỉ lịch sử hoạt động, không gửi Zalo/SMS. |
| C-04 | chung |  | Không tìm thấy trang hoặc không có quyền | AC-OP-09 | 3 | Có API, port giao diện | Trang 404 hiện có | Thêm trạng thái không có quyền. |
| C-05 | chung |  | Danh mục dịch vụ công khai | DEV-14 | 3 | Có API, port giao diện | #services | Không có trong 52 màn demo; thêm cho lối vào công khai. Đọc `GET /api/services`. |
| C-06 | chung |  | Chi tiết dịch vụ công khai | DEV-14 | 3 | Có API, port giao diện | #services/:id | Không có trong 52 màn demo. Khách bấm đặt thì sang C-01 rồi quay lại đây. |
| F-01 | nong-dan | Có | Trang chính | FR-21 | 6 | Có nền, mở rộng API/DB | Không có | Cần API tổng hợp đơn đang chạy và việc cần làm. |
| F-02 | nong-dan | Có | Danh sách thửa ruộng | MOD-01 | 2 | Có API, port giao diện | #fields | Thửa hiện chỉ có tên, địa phương, m². |
| F-03 | nong-dan | Có | Thêm thửa | FR-05, FR-06, FR-07 | 6 | Có nền, mở rộng API/DB | #fields (form m²) | Cần lưu ranh thửa, kiểm tự cắt/chồng lấn, nhập nhanh, nhờ HTX vẽ. |
| F-04 | nong-dan |  | Đường vào và đất ruộng | FR-08 | 3 | Có nền, mở rộng API/DB | Không có | Thuộc tính đường vào, cầu, đất lún. |
| F-05 | nong-dan | Có | Đặt dịch vụ | FR-09, FR-10 | 3 | Có nền, mở rộng API/DB | #request/:id | Thiếu giống lúa, ngày sạ, ngày gặt dự kiến, cửa thời vụ. |
| F-06 | nong-dan | Có | Bảng giá trước khi xác nhận | FR-11 | 3 | Có nền, mở rộng API/DB | Giá/ha x diện tích | Phụ phí sình lầy, lúa đổ chưa có; mức phí là giả định. |
| F-07 | nong-dan | Có | Chi tiết đơn và dòng thời gian | Chương 4 | 10 | Có API, port giao diện | #booking/:id + sự kiện | Map trạng thái DB sang thanh 5 bước. |
| F-08 | nong-dan | Có | Xác nhận ruộng sẵn sàng | FR-12 | 2 | Có API, port giao diện | Khối xác nhận sẵn sàng trong #booking/:id | Demo có thêm bước HTX duyệt (xem H-04). |
| F-09 | nong-dan | Có | Nộp cọc | FR-19, Mục 3.3 | 6 | Chưa có, cần Kiên quyết | Không có | Cọc sau khi chủ máy nhận gói. Sản phẩm chưa có cọc. |
| F-10 | nong-dan |  | Theo dõi máy trên ruộng | FR-21, FR-22 | 4 | Chưa có, cần Kiên quyết | Không có | Cần nguồn tiến độ/vị trí máy. |
| F-11 | nong-dan | Có | Nghiệm thu | FR-23, FR-24 | 5 | Có nền, mở rộng API/DB | #settlement/:id (đồng ý theo phiên bản) | Thiếu đối soát diện tích 3%/5% và phụ phí phát sinh. |
| F-12 | nong-dan |  | Quyết toán phần còn lại | FR-25 | 2 | Có API, port giao diện | #settlement/:id (ghi nhận chuyển tiền) | Ghi nhận ngoài hệ thống, không chuyển tiền. |
| F-13 | nong-dan |  | Khiếu nại | FR-26 | 4 | Có API, port giao diện | #complaint/:id + ảnh bằng chứng | Demo có hạn 12 giờ; sản phẩm chưa áp hạn. |
| F-14 | nong-dan |  | Kết quả hòa giải | FR-27 | 2 | Có API, port giao diện | #dispute/:id (đồng ý phương án) | Theo cơ chế đồng thuận độc lập đã chốt. |
| F-15 | nong-dan |  | Hủy hoặc hoãn đơn | FR-09, Userflow 5.1, Userflow 5.4 | 5 | Có nền, mở rộng API/DB | Dời lịch theo gói | Demo có hủy kèm mức hoàn cọc 48h/24h chưa duyệt. |
| P-01 | chu-may | Có | Bảng tin gói việc | FR-16, FR-17 | 3 | Có API, port giao diện | #dispatch (gói mở) |  |
| P-02 | chu-may | Có | Chi tiết gói việc | FR-17 | 3 | Có nền, mở rộng API/DB | #package/:id | Cảnh báo cầu yếu/máy nặng cần thuộc tính đường vào. |
| P-03 | chu-may | Có | Nhận việc: chọn máy và thợ | FR-18 | 5 | Có nền, mở rộng API/DB | Nhận gói kèm máy và thợ | Thiếu kiểm KYC, giấy tờ hết hạn của thợ. |
| P-04 | chu-may |  | Đội máy và khai báo máy | FR-02 | 4 | Có nền, mở rộng API/DB | Tạo máy (tên, loại) | Thiếu kiểm định, tải trọng, MTOW drone, phép bay. |
| P-05 | chu-may |  | Thợ của tôi và chứng chỉ | FR-03 | 3 | Có nền, mở rộng API/DB | Danh sách thợ đã nhận đề nghị | Thiếu chứng chỉ và hạn giấy tờ. |
| P-06 | chu-may |  | Ca máy đang chạy | FR-21 | 2 | Có API, port giao diện | #shifts (chỉ xem) |  |
| P-07 | chu-may |  | Tiền | FR-25, Mục 3.3 | 3 | Có nền, mở rộng API/DB | Ghi nhận thanh toán theo đơn | Demo có sổ tiền, số dư, phí; sản phẩm chỉ có bản ghi theo đơn. |
| P-08 | chu-may |  | Đăng tin tuyển thợ | UC-OP-01 | 4 | Có nền, mở rộng API/DB | #my-jobs | Thiếu hình thức tiền công, loại máy, kỹ năng. |
| P-09 | chu-may |  | Ứng viên và đề nghị nhận việc | UC-OP-01, AC-OP-05 | 2 | Có API, port giao diện | #job/:id (ứng viên, đề nghị) | Demo cho sửa điều khoản đề nghị; sản phẩm chưa có. |
| P-10 | chu-may |  | Phản hồi khiếu nại | FR-26, FR-27 | 1 | Có API, port giao diện | #dispute/:id (phản hồi) |  |
| O-01 | tho-lai | Có | Ca hôm nay | SH-01..SH-08 | 7 | Có nền, mở rộng API/DB | #shifts, #shift/:id | Ca sản phẩm: chạy, tạm dừng, xong. Demo thêm bốc xe fooc, hạ tải, tạm dừng vì mưa/hỏng. |
| O-02 | tho-lai | Có | Buồng lái | FR-20 | 4 | Chưa có, cần Kiên quyết | Không có | Buồng lái cần telemetry tốc độ, dao cắt. |
| O-03 | tho-lai |  | Tìm việc | AC-OP-02 | 3 | Có API, port giao diện | #jobs | Bộ lọc loại máy, xã, hình thức trả công cần thêm. |
| O-04 | tho-lai |  | Chi tiết tin tuyển | AC-OP-03 | 4 | Có API, port giao diện | #job/:id |  |
| O-05 | tho-lai |  | Ứng tuyển | AC-OP-04 | 2 | Có API, port giao diện | Ứng tuyển trong #job/:id |  |
| O-06 | tho-lai |  | Đơn của tôi và đề nghị nhận việc | AC-OP-05, AC-OP-06, AC-OP-07, AC-OP-10 | 5 | Có API, port giao diện | #applications, #offers | Sửa lỗi nút Rút ứng tuyển sau khi đã nhận. |
| O-07 | tho-lai |  | Hoàn thành và nhận tiền công | AC-OP-08 | 2 | Có nền, mở rộng API/DB | Không có | Ghi nhận hoàn thành và nhận tiền công. |
| O-08 | tho-lai |  | Hồ sơ kỹ năng | AC-OP-01, AC-OP-09 | 2 | Có nền, mở rộng API/DB | Không có | Hồ sơ kỹ năng tự khai và đã xác minh. |
| H-01 | htx |  | Tổng quan địa bàn | FR-04 | 2 | Chưa có, cần Kiên quyết | Không có | Địa bàn HTX chưa có trong DB. |
| H-02 | htx | Có | Hàng chờ đơn | FR-09, FR-06 | 3 | Có API, port giao diện | #dispatch (đơn được ủy quyền) |  |
| H-03 | htx | Có | Bàn gom cụm | FR-13, FR-14, FR-15 | 5 | Có nền, mở rộng API/DB | #dispatch (gom tay theo danh sách) | Cần bản đồ, ranh thửa, gợi ý gom có nhãn giả định. |
| H-04 | htx | Có | Thẩm định thực địa | FR-08, FR-12 | 3 | Chưa có, cần Kiên quyết | Không có | Bước HTX thẩm định thực địa trước khi bắt đầu ca. |
| H-05 | htx | Có | Chào việc | FR-16 | 2 | Có nền, mở rộng API/DB | Gói mở cho mọi chủ máy | Demo có vòng chào việc và mở rộng bán kính. |
| H-06 | htx |  | Giám sát hiện trường | FR-21 | 2 | Có API, port giao diện | #shifts (chỉ xem) | Không có vị trí máy. |
| H-07 | htx |  | Sự cố | Userflow 5.1, Userflow 5.2 | 2 | Có API, port giao diện | Dời lịch có đồng thuận | Theo quy tắc 18/11: dời cả gói trước khi ca bắt đầu. |
| H-08 | htx |  | Hòa giải | FR-27 | 2 | Chưa có, cần Kiên quyết | Không có (admin độc lập hòa giải) | Demo cho HTX hòa giải cấp 1. |
| H-09 | htx |  | Hoa hồng theo kỳ đối soát | FR-25 | 1 | Chưa có, cần Kiên quyết | Không có | Hoa hồng HTX là giả định, chưa duyệt. |
| A-01 | quan-tri |  | Duyệt hồ sơ | FR-02, FR-03, FR-04 | 2 | Có API, port giao diện | #admin/roles | Sản phẩm duyệt vai trò; demo duyệt hồ sơ máy, thợ, HTX. |
| A-02 | quan-tri |  | Địa bàn HTX | FR-04 | 2 | Chưa có, cần Kiên quyết | Không có | Gắn với H-01, giới hạn 3 HTX mỗi xã. |
| A-03 | quan-tri |  | Trọng tài cấp 2 | FR-28 | 1 | Có API, port giao diện | Hàng chờ hòa giải của admin | Không có chế tài trừ điểm, khóa tài khoản. |
| A-04 | quan-tri |  | Tham số | FR-13, FR-14 | 1 | Có nền, mở rộng API/DB | Không có | Bảng tham số có nhãn giả định. |
| A-05 | quan-tri |  | Cổng tuân thủ và nhật ký | SRS 6.5 | 2 | Có nền, mở rộng API/DB | Nhật ký sự kiện theo nghiệp vụ | Cổng tuân thủ chưa có. |
| A-06 | quan-tri |  | Báo cáo tin tuyển nghi lừa đảo | UC-OP-01 | 1 | Có nền, mở rộng API/DB | Không có | Báo cáo và gỡ tin tuyển. |

## Tổng

- Chưa có, cần Kiên quyết: 9 màn (lõi: 4)
- Có nền, mở rộng API/DB: 22 màn (lõi: 10)
- Có API, port giao diện: 21 màn (lõi: 5)
