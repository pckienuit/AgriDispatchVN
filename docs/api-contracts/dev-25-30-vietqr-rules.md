# DEV-25 và DEV-30: tài khoản nhận cọc, VietQR và hạn giữ chỗ

## Tài khoản nhận cọc của chủ máy

`GET /api/provider/bank-account` trả `200 { "bankAccount": null }` nếu chưa cấu hình. `PUT /api/provider/bank-account` tạo hoặc thay toàn bộ cấu hình và trả `200`. Cả hai chỉ dành cho vai trò `provider`, luôn dùng ID từ phiên đăng nhập và trả `Cache-Control: no-store`.

```json
{
  "bankBin": "970436",
  "bankName": "Ngân hàng kiểm thử",
  "accountNumber": "001234567890",
  "accountHolder": "Nguyễn Văn A"
}
```

`bankBin` gồm đúng 6 chữ số ASCII. `accountNumber` gồm từ 4 đến 34 chữ cái ASCII hoặc chữ số. Cả hai là chuỗi để giữ số 0 ở đầu. `bankName` và `accountHolder` được bỏ khoảng trắng đầu cuối, dài từ 1 đến 120 ký tự và không chứa ký tự điều khiển. Dữ liệu sai định dạng trả `400 VALIDATION_FAILED`; trường không được hỗ trợ trả `400 UNKNOWN_FIELD`. Không nhận query. Gửi `providerUserId` hoặc `provider_user_id` trong body PUT trả `403 FORBIDDEN`. Chưa đăng nhập trả `401`; sai vai trò trả `403`.

Nếu đã cấu hình, cả GET và PUT trả `{ "bankAccount": { "bankBin": ..., "bankName": ..., "accountNumber": ..., "accountHolder": ..., "updatedAt": ... } }`. `updatedAt` là thời điểm UTC ISO 8601. Server kiểm tra định dạng, không đối chiếu tài khoản với ngân hàng.

## Lấy mã VietQR

`POST /api/bookings/:id/vietqr` (hoặc `GET` để tương thích) chỉ cho người đứng tên đơn có vai trò `farmer` hoặc `coop`. Đơn ngoài phạm vi trả `404 NOT_FOUND`. Chỉ lấy mã khi người trả yêu cầu hiện mã; không lấy trước trong danh sách hoặc lúc tải nền. Với phiên cookie, yêu cầu khác origin bị từ chối (`403 CROSS_ORIGIN_REQUEST`), kể cả `GET`. `HEAD` không mở hạn cọc. Lần lấy mã thành công đầu tiên có thể mở hạn giữ chỗ nhưng không tạo báo chuyển tiền. Không còn `vietqrExample` trong API đọc cọc.

Phản hồi `200`, `Cache-Control: no-store`:

```ts
{
  bookingId: string, // UUID đơn
  packageId: string, // UUID gói
  expiresAt: string, // ISO 8601 UTC
  vietqr: {
    bankBin: string,
    bankName: string,
    accountNumber: string,
    accountHolder: string,
    amountVnd: string, // Số nguyên dương, đơn vị VND
    description: string, // Nội dung chuyển khoản ASCII, tối đa 25 ký tự
    payload: string, // Chuỗi EMVCo đầy đủ, gồm CRC
    svg: string, // Tài liệu SVG chứa đúng payload
    notice: string
  }
}
```

Payload có thứ tự tag `00=01`, `01=12`, `38` chứa `00=A000000727`, `01` chứa BIN (`00`) và số tài khoản (`01`), `02=QRIBFTTA` trong tag `38`, sau đó `53=704`, `54` là số tiền, `58=VN`, `62` chứa nội dung chuyển khoản (`08`), cuối cùng `63`. CRC-16/CCITT-FALSE dùng đa thức `0x1021`, giá trị đầu `0xFFFF`, tính trên toàn chuỗi đến hết `6304`; kết quả gồm 4 ký tự hex in hoa. SVG là QR byte mode, ECC M, có vùng trắng 4 ô quanh mã. Có thể hiển thị SVG bằng phần tử ảnh; không chèn HTML thô. Không chỉnh payload hoặc nội dung chuyển khoản khi hiển thị.

Số tiền cọc lấy từ báo giá đã lưu của đơn, bằng 10% làm tròn nửa lên tới đồng. Nông dân chuyển khoản trực tiếp cho chủ máy. Nền tảng không giữ tiền, không xác minh tài khoản và không tự xác nhận hay hoàn tiền. Kiểm tra lại người nhận trong ứng dụng ngân hàng trước khi chuyển.

## Báo đã chuyển và xác nhận đã nhận

- `GET /api/bookings/:id/deposit`: trả trạng thái cho người đứng tên đơn, HTX phụ trách hoặc chủ máy nhận gói. Không mở hạn cọc. Thêm `expiresAt`, `expiredAt`, `releaseReason` ở cấp phản hồi; các trường chưa có giá trị trả `null`. `permissions.blockReason` báo điều kiện chưa đạt.
- `POST /api/bookings/:id/deposit`: cùng phạm vi với API lấy mã. Body `{ "reference": "FT123456", "amountVnd": "120000" }`; `reference` bắt buộc, từ 4 đến 64 ký tự thuộc `[A-Za-z0-9._-]`. `amountVnd` không bắt buộc; nếu gửi phải khớp số tiền server tính. Trả `201` khi tạo và `200` khi gửi lại cùng tham chiếu, kể cả sau khi hết hạn hoặc kết quả kiểm tra thực địa thay đổi. Nếu gửi số tiền, số tiền phải khớp báo chuyển đã ghi. `deposit.status` là `REPORTED` và `confirmedAt` là `null` nếu chủ máy chưa xác nhận. Đây chỉ là lời báo của người chuyển.
- `POST /api/deposits/:id/confirm`: body `{}` hoặc không có body. Chỉ chủ máy được ghi là người nhận mới xác nhận. Trả `200` với `deposit.status: "CONFIRMED"` và `confirmedAt` sau khi xác nhận, kể cả khi gửi lại. Một báo chuyển chưa xác nhận không làm giảm số tiền còn phải trả.

Để lấy mã hoặc báo chuyển, đơn phải được phân công, chủ máy đã nhận gói, HTX đã xác nhận cuộc gọi, người trả khác người nhận, không có tranh chấp đang chặn thanh toán và khoản cọc nằm trong hạn mức. Một số lỗi `409`: `HTX_CALL_NOT_CONFIRMED`, `PROVIDER_BANK_ACCOUNT_REQUIRED`, `DEPOSIT_ALREADY_EXISTS`, `DEPOSIT_AMOUNT_MISMATCH`, `REFERENCE_CONFLICT`, `AMOUNT_EXCEEDS_OUTSTANDING`, `DEPOSIT_EXPIRED`.

### Kiểm tra thực địa

Cả lấy mã, báo chuyển và `POST /api/packages/:id/shifts/start` đều yêu cầu kết quả `PASSED` mới nhất từ HTX. Kết quả chỉ còn hiệu lực nếu phiên xác nhận chuẩn bị ruộng và khung giờ gói không đổi. Mở ca còn yêu cầu thông tin chuẩn bị ruộng của người đứng tên đơn đạt đủ các mục cho từng đơn đang phân công; nếu không, trả `409 READINESS_INCOMPLETE`.

| HTTP | `error.code` | Khi nào trả lỗi |
| --- | --- | --- |
| 409 | `FIELD_INSPECTION_REQUIRED` | Chưa kiểm tra, đang chờ kết quả hoặc kết quả đã cũ. |
| 409 | `FIELD_INSPECTION_NOT_PASSED` | Kết quả hiện hành là `FAILED`. |

Hai lỗi có `error.message` bằng tiếng Việt. Nếu bị chặn, server không phát mã QR, không tạo báo chuyển và không mở ca. API đọc trạng thái vẫn truy cập được theo phạm vi để hiển thị lý do và lịch sử.

## Chính sách hết hạn

`DEPOSIT_EXPIRY_HOURS` nhận số nguyên từ 1 đến 720, mặc định `24`. PostgreSQL tính `expiresAt` khi lần đầu lấy mã thành công hoặc khi báo chuyển thành công nếu chưa lấy mã. Đọc trạng thái, tải lại mã, gửi lại báo chuyển hoặc đổi cấu hình không gia hạn cửa sổ đã mở. Bản ghi cọc từ trước migration `029` không bị gán hạn hồi tố. Dùng `expiresAt` để đếm ngược; thứ tự xử lý luôn dựa trên đồng hồ server, không dựa trên giờ thiết bị.

Đến chính thời điểm `expiresAt`, server chặn phát mã, báo chuyển và xác nhận lần đầu với `409 DEPOSIT_EXPIRED` nếu chưa xác nhận. Một mã đã tải hoặc chụp lại không tự mất hiệu lực trong app ngân hàng. Không chuyển theo mã cũ; nếu đã chuyển mà quá hạn, liên hệ HTX và chủ máy để đối soát ngoài hệ thống.

Chạy `node --env-file-if-exists=.env server/scripts/expire-deposits.js` bằng tài khoản DB `booking_runtime`. Booking-service tự chạy mỗi `DEPOSIT_EXPIRY_SWEEP_INTERVAL_MS` mili giây (mặc định `300000`, đặt `0` để tắt). Các lượt chạy trong cùng tiến trình không chồng nhau. Không có endpoint công khai; dùng lệnh trên để chạy một lượt thủ công. Lệnh xuất `{ "expiredCount": n }` và trả mã thoát khác 0 nếu lỗi. Job khóa gói và đơn trong cùng giao dịch, bỏ qua hàng đang khóa, kiểm tra lại sự kiện xác nhận rồi mới đánh dấu `expiredAt` và `releaseReason: "DEPOSIT_EXPIRED"`. Chạy lại không sửa lại bản ghi và không sinh thêm sự kiện.

Nếu chưa mở ca, chỉ hủy đơn đã hết hạn và chưa có xác nhận. Không đổi trạng thái đơn khác trong cùng gói và chỉ giải phóng lịch máy, thợ lái khi không còn đơn đang phân công trong gói. Nếu ca đã mở, chỉ đóng hạn cọc, không sửa ca hay trạng thái đơn đã chạy. Không bao giờ sửa sổ ghi nhận chuyển cọc hoặc xác nhận đã lưu; báo chuyển hết hạn không còn chiếm hạn mức quyết toán sau khi job xử lý. Migration và cấp lại quyền DB bằng bootstrap phải hoàn tất trước khi chạy server mới hoặc job.
