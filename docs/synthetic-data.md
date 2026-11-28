# Dữ liệu synthetic (G11)

`server/scripts/generate-data.js` sinh dữ liệu quan hệ giả lập để chuẩn bị thử tải và kiểm tra ràng buộc. Dịch vụ có `data_label=synthetic`; tài khoản dùng email riêng, thửa/tin tuyển có chữ giả lập; booking và sự kiện truy vết qua ID quan hệ. Không phải mỗi bảng đều có cột nhãn. Phân phối là kịch bản thiết kế sẵn, không phải số liệu khảo sát, thị trường hay mùa vụ đo được.

## Phạm vi

- Chỉ chạy trên PostgreSQL loopback (`127.0.0.1`, `localhost`, `[::1]`) và không có `NODE_ENV=production`.
- CLI không nhận URL có query hoặc fragment, tránh tham số ghi đè host/DB sau bước kiểm tra. Không có biến môi trường bỏ qua kiểm tra này. Chạy từ xa hoặc trên cloud cần phê duyệt riêng.
- Không xóa, không `TRUNCATE`, không reset. Không sửa dòng đã có.
- Không có dữ liệu khảo sát, dữ liệu người thật, ảnh hay file đệm.

## Cách chạy

```bash
# Xem kế hoạch, không kết nối DB
node server/scripts/generate-data.js --seed 2026 --count 1000 --batch-size 100

# Ghi thật vào DB dùng một lần trên loopback
SYNTHETIC_PASSWORD='<mật khẩu synthetic 12-128 ký tự>' DATABASE_URL=postgresql://...@127.0.0.1:55432/agridispatch_test \
  node server/scripts/generate-data.js --seed 2026 --count 1000 --batch-size 100 --confirm-synthetic
```

- `--seed`: số nguyên 0 đến 4294967295. Cùng seed và count thì ra cùng ID và cùng nội dung.
- `--count`: số booking chính, 1 đến 1000000. Batch mặc định 100, tối đa 1000.
- `SYNTHETIC_PASSWORD` là mật khẩu chỉ dùng cho tài khoản synthetic, không có giá trị mặc định. Không dùng `local_dev_only` hay `disposable_test_only`. Mật khẩu không được in ra.
- Kết quả là một dòng JSON: số dòng chèn mới, số dòng đã có, batch, kết quả kiểm tra và `pg_database_size`. Kích thước này chỉ là số đo thực tế, không suy ra mốc 4 GB.

## API

- `generateData(pool, { seed, count, batchSize, password })`: trả `{ inserted, existing, batches }`. Số đếm `inserted` lấy từ `rowCount` của INSERT. Số đếm `existing` lấy từ SELECT theo ID.
- `checkGeneratedData(pool, { seed, count })`: chỉ đếm và kiểm tra namespace của seed đó. Trả `{ ok, violations, counts }`.
- Hàm thuần để test: `assertSeed`, `assertCount`, `assertBatchSize`, `assertGenerateAllowed`, `syntheticUuid`, `prngFor`, `expectedCounts`, `bookingPlan`, `jobPlan`.

## Dữ liệu sinh ra

| Bảng | Số dòng với count = N |
| --- | --- |
| `account.users` / `user_roles` | 13 tài khoản (4 farmer, 2 provider, 5 operator, 1 coop, 1 admin) |
| `dispatch.services` | 4 dịch vụ, `data_label = 'synthetic'` |
| `dispatch.fields` | 12 thửa, chủ là farmer synthetic |
| `dispatch.bookings` | N, mỗi dòng có snapshot khớp thửa và dịch vụ |
| `dispatch.booking_events` | N, đúng một `BOOKING_REQUESTED` mỗi booking |
| `dispatch.jobs` | max(1, floor(N/8)), sức chứa 3 |
| `dispatch.applications` | 4 mỗi job, luôn nhiều hơn sức chứa |
| `dispatch.offers` | 3 mỗi job, đều `OFFERED` |
| `dispatch.recruitment_events` | 11 mỗi job (job.created, 4 application.created, 3 offer.created, 3 application.offered) |

Quy tắc:

- Email có dạng `syn<digest seed>.<vai trò><số>@example.invalid`. Mã dịch vụ có dạng `syn<digest seed>-<slug>`.
- ID xác định từ hash SHA-256 của (seed, loại, chỉ số), đặt bit phiên bản 5 để đúng định dạng UUID API; không phải thuật toán UUIDv5 chuẩn SHA-1. Salt mật khẩu vẫn dùng nguồn ngẫu nhiên hệ thống.
- Snapshot trong booking copy giá trị thửa và dịch vụ. Tiền là số nguyên VND, làm tròn half-up theo quy tắc demo hiện có.
- Không tạo offer `ACCEPTED`. Chấp nhận offer là nghiệp vụ của API, không phải dữ liệu sinh sẵn.
- `created_at` nằm trong 60 ngày đầu, trước mọi mùa, để không có lịch sử nằm sau thời điểm bắt đầu.

## Phân phối thiết kế

- Thửa nóng: 30% lượt chọn trực tiếp thửa 1; 70% còn lại phân đều cả 12 thửa, nên thửa 1 còn nhận thêm lượt từ nhánh này. Đây là xác suất thiết kế, không phải tần suất đã đo.
- Mùa: 45% booking vào mùa 1 (tháng 2 đến tháng 4 năm 2027), 30% vào mùa 2 (tháng 6 đến tháng 8), 25% vào mùa 3 (tháng 10 đến giữa tháng 12).
- Thời lượng booking: 2 đến 10 giờ.
- Các trọng số này là lựa chọn của kịch bản demo. Chưa được khảo sát hay dữ liệu thị trường xác nhận.

## Idempotent và resume

- Mỗi batch chạy trong một transaction. Lỗi giữa chừng thì batch đó rollback hoàn toàn và hàm báo lỗi.
- Chạy lại cùng seed và count không chèn gì, mọi dòng được báo là đã có.
- Tăng count thì chỉ chèn phần mở rộng. Dòng cũ không đổi.
- Giảm count dưới số booking đã có trong namespace bị từ chối trước khi ghi.
- Booking và sự kiện là append-only theo trigger của migration 003 và 005, nên rerun không cập nhật booking.

## Kiểm thử

- Unit (`server/tests/generate-data.test.js`): kiểm seed, count, batch, UUID, PRNG, công thức số dòng, mật khẩu, guard loopback và ngày tạo.
- Integration (`server/tests/integration/generate-data.test.js`): dùng DB dùng một lần `*_test`. Kiểm count 25 batch 7, rerun, mở rộng, rollback batch lỗi, tái lập qua DB khác, nhiều seed chung DB, phân phối thiết kế, checker phát hiện lệch snapshot và offer sai trạng thái, dry-run, CLI từ chối remote, URL ghi đè host, production và mật khẩu sai. Thiếu xác nhận chỉ xuất kế hoạch, không ghi dữ liệu.

## Giới hạn

- Số thửa, dịch vụ, vai trò và địa phương cố định. Cấu hình hóa khi có mục tiêu tải được chốt.
- Không có phương tiện, ảnh, file đính kèm hay dữ liệu địa lý thật.
- Không đo tải trên cloud. Chỉ có số đo local trên DB test loopback.
- Không suy ra độ đầy đủ của dữ liệu thật từ dữ liệu synthetic.
- Guard môi trường thuộc CLI. Hàm `generateData` nhận pool do bên gọi cấp; chỉ dùng trong kiểm thử hoặc công cụ đã kiểm đích kết nối, không đưa vào request handler.
- Chạy một tiến trình ghi cho mỗi seed. Hai tiến trình đồng thời có thể gặp unique conflict; lỗi được báo, batch hiện tại rollback, có thể chạy lại. Checker giả định dữ liệu fixture chưa được người dùng sửa qua API.

## Kiểm tra local đã chạy

Ngày 18/11/2026 (UTC+07), coordinator chạy lại trên DB PostgreSQL dùng một lần, seed 2026, count 1000, batch 100. Tạo được 1000 booking, 1000 booking event, 125 tin tuyển, 500 ứng tuyển, 375 đề nghị và 1375 recruitment event; checker không có vi phạm. Lần chạy lại không chèn dòng nào.

Một lần sinh mất 154 ms; một lần chạy lại mất 26 ms. Chỉ đo thời gian hàm sinh, không gồm migration/checker và không có lặp thống kê. `pg_database_size` sau chạy là 11 007 667 byte, gồm cả nền DB/migration. Đây không phải kết quả thử tải HTTP, so sánh region hoặc bằng chứng đạt 4 GB. Mức 1 000 000 booking mới được kiểm dry-run, chưa đo thực thi.
