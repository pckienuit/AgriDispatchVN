# DEV-53: Phiên đăng nhập và đặt lại mật khẩu

Bàn giao cho DEV-43. Gọi API cùng origin với `/v2/`, dùng `credentials: 'same-origin'`. Các endpoint ghi nhận JSON dùng `Content-Type: application/json`; không chấp nhận trường JSON ngoài hợp đồng. Phản hồi `204` không có body.

## Phiên đăng nhập

`POST /api/auth/login` và `POST /api/auth/register` cấp cookie `agri_session` chứa token ngẫu nhiên 256 bit. Cookie dùng `HttpOnly; Path=/; SameSite=Lax; Max-Age=<SESSION_TTL_SECONDS>`, có thêm `Secure` khi `NODE_ENV=production`, kết nối HTTPS trực tiếp hoặc `X-Forwarded-Proto: https`. Không cần đọc cookie hay đưa token vào bộ nhớ trình duyệt. Header `Authorization: Bearer <token>` vẫn dùng được và có ưu tiên cao hơn cookie, kể cả khi giá trị Bearer sai.

`User` có dạng `{ "id": UUID, "email": string|null, "phone": string|null, "name": string, "roles": string[] }`. `UUID` là chuỗi UUID; các mốc thời gian là chuỗi ISO 8601 UTC. Vai trò: `farmer`, `provider`, `operator`, `coop`, `admin`.

| Endpoint | Yêu cầu | Thành công | Lỗi riêng |
| --- | --- | --- | --- |
| `POST /api/auth/register` | `{ "email": string, "password": string, "name": string }` hoặc thay `email` bằng `phone` | `201 { "user": User }` và cookie | `409 CONFLICT` nếu email hoặc số điện thoại đã dùng; `429 RATE_LIMITED` |
| `POST /api/auth/login` | `{ "email": string, "password": string }` hoặc thay `email` bằng `phone` | `200 { "token": string, "expiresAt": string, "user": User }` và cookie; gửi `Prefer: session-cookie` để bỏ `token` khỏi JSON | `401 INVALID_CREDENTIALS`; `429 RATE_LIMITED` |
| `GET /api/me` | Cookie hoặc Bearer; không có body | `200 { "user": User }` | `401 UNAUTHORIZED` |
| `POST /api/auth/logout` | Cookie hoặc Bearer; không cần body | `204`, thu hồi phiên xác thực và xóa cookie | `401 UNAUTHORIZED`, vẫn xóa cookie |
| `GET /api/auth/sessions` | Cookie hoặc Bearer; không có body | `200 { "sessions": Session[] }` | `401 UNAUTHORIZED` |
| `DELETE /api/auth/sessions/:sessionId` | Cookie hoặc Bearer; `sessionId` là UUID; không có body | `204`, xóa cookie nếu thu hồi phiên hiện tại | `400 INVALID_REQUEST` nếu ID sai định dạng; `401 UNAUTHORIZED`; `404 NOT_FOUND` nếu phiên không tồn tại, không thuộc tài khoản, đã hết hạn hoặc đã bị thu hồi |

Tại gateway `/v2/`, có thể gửi `Prefer: anonymous` khi gọi `GET /api/me` lúc khởi động. Không có cookie hợp lệ về định dạng lẫn header `Authorization` thì nhận `204`; nếu gửi cookie đúng định dạng nhưng phiên đã hết hạn hoặc bị thu hồi thì vẫn nhận `401`. Sau khi tải lại trang, chỉ mở màn cần xác thực khi đã nhận `200` và đọc được `user`.

```ts
type Session = {
  id: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  userAgent: string | null;
  ip: string | null;
  isCurrent: boolean;
};
```

Danh sách tối đa 20 phiên thuộc tài khoản đang gọi. Phiên đang dùng xếp đầu, sau đó là các phiên còn hiệu lực, rồi các phiên gần đây theo thời điểm tạo giảm dần. Phiên hết hạn quá 24 giờ không xuất hiện. `userAgent` tối đa 160 ký tự, có thể là `null`; `ip` chỉ là mạng con IPv4 `/24` hoặc IPv6 `/48`, có thể là `null`. Không trả token hoặc hash của token. Phiên hết hạn hoặc đã bị thu hồi không dùng được ở API tài khoản và API nghiệp vụ. API nghiệp vụ trả `401 UNAUTHENTICATED` thay cho `UNAUTHORIZED`.

## Đổi và đặt lại mật khẩu

| Endpoint | Yêu cầu | Thành công | Lỗi riêng |
| --- | --- | --- | --- |
| `POST /api/auth/change-password` | Cookie hoặc Bearer và `{ "currentPassword": string, "newPassword": string, "revokeOtherSessions"?: boolean }` | `204`; giữ phiên đang dùng; mặc định `revokeOtherSessions=true` | `401 UNAUTHORIZED` nếu mất phiên; `401 INVALID_CREDENTIALS` nếu mật khẩu hiện tại không đúng; `429 RATE_LIMITED` |
| `POST /api/auth/forgot-password` | Công khai; `{ "identifier": string }` | `200 { "ok": true }` cho mọi định danh đúng định dạng, kể cả tài khoản không tồn tại, đang bị giới hạn hoặc không gửi được | `400 INVALID_REQUEST` nếu đầu vào không hợp lệ |
| `POST /api/auth/reset-password` | Công khai; `{ "identifier": string, "otp": string, "newPassword": string }` | `204`; đổi mật khẩu và thu hồi tất cả phiên của tài khoản đó trong một transaction. Sau đó đăng nhập lại bằng mật khẩu mới. | `400 INVALID_REQUEST` nếu đầu vào sai định dạng; `400 INVALID_OTP` nếu mã sai, hết hạn, đã dùng, hết lượt thử hoặc không tồn tại; `429 RATE_LIMITED` |

- `identifier` là email hoặc số điện thoại Việt Nam. Email được trim, chuyển về chữ thường và giới hạn 254 ký tự. Số điện thoại chấp nhận `0`, `+84` hoặc `84`, có thể chứa khoảng trắng, dấu chấm hoặc dấu gạch nối, tối đa 32 ký tự trước khi chuẩn hóa. Tên đăng ký dài từ 1 đến 120 ký tự sau khi trim, không chứa ký tự điều khiển.
- `newPassword` và mật khẩu đăng ký dài từ 12 đến 128 byte UTF-8; mật khẩu đăng nhập và `currentPassword` dài từ 1 đến 128 byte UTF-8. Không trim mật khẩu.
- OTP là chuỗi 22 ký tự theo `[A-Za-z0-9_-]{22}`, không phải 6 chữ số. OTP dùng một lần, hết hạn sau 900 giây, tối đa 5 lượt kiểm tra cho mỗi mã. Mã mới thay mã cũ; đổi mật khẩu cũng vô hiệu hóa mã đang chờ. DB chỉ lưu SHA-256 của mã.
- Mặc định mỗi cửa sổ 900 giây: yêu cầu gửi mã tối đa 15 lần theo IP và 3 lần theo định danh; đặt lại tối đa 30 lần theo IP và 15 lần theo định danh; đổi mật khẩu tối đa 10 lần theo tài khoản. `429` có header `Retry-After` tính bằng giây. Giao diện gửi mã chỉ nên báo: “Nếu tài khoản tồn tại và nhận được mã, hãy kiểm tra kênh đã đăng ký.”

Các lỗi trên dùng `{ "error": { "code": string } }`. Lỗi chung: `400 INVALID_REQUEST` (đầu vào không hợp lệ), `400 INVALID_JSON`, `413 PAYLOAD_TOO_LARGE` (JSON vượt 64 KiB), `403 CROSS_ORIGIN_REQUEST` (ghi từ origin khác), `503 SERVICE_UNAVAILABLE` (lỗi phụ thuộc ở account-service) và `503 IDENTITY_UNAVAILABLE` (gateway không gọi được account-service). Account-service có thể trả `400 INVALID_CLIENT_IDENTITY` khi chữ ký địa chỉ client không hợp lệ hoặc thiếu theo cấu hình.

## Cấu hình account-service

| Biến | Giá trị / cách dùng |
| --- | --- |
| `SESSION_TTL_SECONDS` | Số giây tồn tại của phiên và cookie; mặc định `28800`, từ `60` đến `86400`. |
| `NODE_ENV` | `production` luôn bật `Secure` và từ chối gửi OTP qua kết nối không mã hóa. Proxy TLS cần đặt `X-Forwarded-Proto` theo kết nối bên ngoài, không chuyển nguyên giá trị do client gửi. |
| `OTP_DELIVERY_MODE` | `webhook` hoặc `smtp`. Nếu thiếu hoặc cấu hình không hợp lệ, service không cấp hay gửi mã mới; phản hồi của `forgot-password` không đổi. |
| `OTP_WEBHOOK_URL` | URL nhận `POST`. Dùng HTTPS; HTTP chỉ cho loopback ngoài production. URL không có thông tin đăng nhập hoặc fragment. |
| `OTP_WEBHOOK_SECRET` | Không bắt buộc. Khi có, `X-OTP-Signature` là `sha256=<HMAC-SHA256 dạng hex của raw JSON body>`. |
| `SMTP_HOST`, `SMTP_PORT` | Host SMTP; port mặc định `587`. |
| `SMTP_FROM` | Địa chỉ email người gửi, không kèm tên hiển thị. |
| `SMTP_USER`, `SMTP_PASS` | Đặt cả hai để dùng `AUTH PLAIN` hoặc `AUTH LOGIN`; bỏ cả hai nếu relay không yêu cầu xác thực. |
| `SMTP_TLS_MODE` | `implicit` mặc định cho port `465`; các port khác mặc định `starttls`. `plain` chỉ dùng với loopback ngoài production. TLS kiểm tra chứng chỉ; không hạ xuống kết nối không mã hóa. |

Webhook nhận `{ "identifier": string, "channel": "email"|"phone", "otp": string, "expiresInSeconds": 900 }`. Trả `2xx` để xác nhận; không chuyển hướng. SMTP chỉ gửi đến email đã lưu của tài khoản; tài khoản chỉ có số điện thoại cần dùng webhook. Gửi mã chạy sau phản hồi HTTP với thời gian chờ tối đa 5 giây cho mỗi lần giao. Không ghi OTP, token hay thông tin xác thực vào log.

Chạy migration `027_auth_sessions_otp.sql` trước khi khởi động bản mới. Repository dùng schema `account`; bảng mới là `account.password_reset_tokens`. Nếu tạo runtime role mới hoặc dùng tên role tùy chỉnh, chạy `server/scripts/bootstrap-db.js` sau migration. Booking-service không được đọc bảng mã đặt lại mật khẩu.
