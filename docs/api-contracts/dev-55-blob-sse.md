# DEV-55 (#70): Ảnh bằng chứng và thông báo thời gian thực

Hợp đồng tích hợp cho DEV-33 (ảnh bằng chứng) và DEV-41 (Thiện, thông báo).

## Xác thực

Gọi API cùng origin bằng cookie phiên HttpOnly `agri_session` của DEV-53, hoặc dùng `Authorization: Bearer <token>` cho client hiện tại. Nếu gửi cả hai, server ưu tiên header. Không truyền token qua URL. Request ghi dùng cookie từ origin khác bị từ chối với `403 CROSS_ORIGIN_REQUEST`. Tài khoản không có phiên hợp lệ nhận `401 UNAUTHENTICATED`.

## DEV-33: ảnh bằng chứng

| Thao tác | Request | Kết quả |
| --- | --- | --- |
| Tải ảnh lên | `POST /api/disputes/:id/evidence`, body là byte ảnh, `Content-Type: image/jpeg` hoặc `image/png` | `201 { evidence }` khi lưu mới, `200 { evidence }` nếu cùng người tải lại đúng nội dung đã lưu trong hồ sơ |
| Danh sách | `GET /api/disputes/:id/evidence?limit=20&offset=0` | `200 { items, limit, offset, canUpload, storageAvailable }` |
| Tải bản gốc | `GET /api/evidence/:id/content` | `200`, byte ảnh gốc, `Content-Disposition: attachment` |
| Xem ảnh thu nhỏ | `GET /api/evidence/:id/thumbnail` | `200`, JPEG tối đa 320 × 320 pixel, giữ tỷ lệ, xử lý hướng ảnh và bỏ EXIF khi tạo. `Content-Disposition: inline` |

`evidence` và từng phần tử `items` gồm `id`, `status`, `contentType`, `byteSize`, `width`, `height`, `createdAt`. API chỉ trả mục `UPLOADED` và không trả URL Blob, SAS hay khoá lưu trữ. Request upload không dùng JSON, multipart hoặc `Content-Encoding` nén. Giới hạn mỗi ảnh 5 MiB, tối đa 4096 pixel mỗi cạnh; tối đa 10 ảnh đang tải hoặc đã lưu cho mỗi hồ sơ.

Chỉ bên khiếu nại và bên bị khiếu nại được tải ảnh lên khi hồ sơ còn `OPEN`. Hai bên và người hoà giải đang được phân công, còn đủ điều kiện, được xem danh sách và lấy ảnh. Quản trị viên không phụ trách hồ sơ không có quyền mở ảnh. Hồ sơ ngoài phạm vi trả `404 NOT_FOUND`; người hoà giải có quyền đọc nhưng tải ảnh lên nhận `403 FORBIDDEN`.

- `400 INVALID_IMAGE`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`: đổi ảnh hoặc định dạng trước khi thử lại.
- `409 UPLOAD_PENDING`, `DISPUTE_NOT_OPEN` hoặc `EVIDENCE_LIMIT`: tải lại danh sách để kiểm tra trạng thái; không tự động gửi lại liên tục.
- `404 THUMBNAIL_PENDING`: chỉ hiện khi thumbnail chưa có và server không tạo tại chỗ. Có thể thử lại hoặc tải bản gốc nếu vẫn có quyền. `404 CONTENT_UNAVAILABLE` nghĩa là không tìm thấy bản gốc đã ghi nhận.
- `503 STORAGE_UNAVAILABLE`: không báo tải thành công. Nếu mất phản hồi, gọi lại danh sách trước khi cho phép gửi ảnh mới.

Bản gốc giữ nguyên byte, có thể chứa EXIF/GPS; cần thông báo trước khi chọn ảnh. Hai API đọc ảnh trả byte riêng tư, có `Cache-Control: private, no-store`, không redirect. Server đọc vào bộ nhớ có giới hạn để xác minh bản gốc trước khi gửi. Client dùng `fetch` có xác thực, tạo object URL nếu cần xem trước, thu hồi URL khi đổi ảnh, rời màn hình hoặc đăng xuất.

Azure App Service dùng Managed Identity qua `IDENTITY_ENDPOINT` và `IDENTITY_HEADER`; đặt `AZURE_CLIENT_ID` để chọn identity do người dùng gán. Dùng hai container riêng tư cho bản gốc và thumbnail. Mặc định API ghi cả hai trước khi công bố ảnh và tạo lại thumbnail còn thiếu từ bản gốc đã kiểm SHA-256. Đặt `EVIDENCE_INLINE_THUMBNAILS=false` nếu thumbnail do Azure Function tạo riêng và identity của API chỉ có quyền đọc container đầu ra. Khi bật tạo tại chỗ, identity của API cần quyền ghi và dọn dẹp cả hai container. Không dùng account key hoặc SAS.

## DEV-41: thông báo và SSE

`GET /api/events/stream` trả `text/event-stream`. UI cùng origin dùng `EventSource` với cookie phiên; client dùng Bearer phải đọc SSE qua `fetch`. Lần đầu, nếu không có cursor, server gửi lịch sử của tài khoản từ đầu. Khi kết nối lại, header `Last-Event-ID` được ưu tiên hơn `?lastEventId=<id>` (dùng query khi tạo `EventSource` mới). Cursor là chuỗi số thập phân từ `0` đến `9223372036854775807`, sai định dạng trả `400 INVALID_EVENT_CURSOR`.

```text
id: 103
event: BOOKING_ASSIGNED
data: {"id":"103","eventType":"BOOKING_ASSIGNED","entityType":"booking","entityId":"00000000-0000-4000-8000-000000000001","title":"Đơn dịch vụ có cập nhật","body":null,"payload":{"state":"ASSIGNED"},"createdAt":"2026-11-28T15:10:00.000Z","readAt":null}

event: unread_sync
data: {"unreadCount":1}

: keepalive

```

- Đăng ký `addEventListener` theo tên event, không chỉ `onmessage`. Server gửi các bản ghi có ID lớn hơn cursor, theo thứ tự ID tăng dần, không lặp ID đã xác nhận. ID có thể nhảy số; luôn giữ dạng chuỗi. Chỉ lưu cursor sau khi xử lý sự kiện có `id`, tách cursor theo tài khoản; xoá trạng thái khi đăng xuất. Lần gọi với cursor cũ có thể nhận lại sự kiện đã nhận nhưng chưa xác nhận. Client nên bỏ qua ID trùng khi cập nhật UI.
- `unread_sync` không có `id`: lấy `unreadCount` làm giá trị mới, không đổi cursor. Server gửi số hiện tại khi kết nối, khi số thay đổi và sau khi có bản ghi được đánh dấu đã đọc. Comment `: keepalive` gửi mỗi 20 giây. Kết nối tự đóng sau tối đa 60 giây hoặc khi phiên hết hạn để lần kết nối sau kiểm tra lại phiên.
- `GET /api/notifications?limit=20&offset=0` trả `{ items, limit, offset, unreadCount }`. `items` có cấu trúc như `data` của event, sắp theo ID giảm dần; `limit` từ 1 đến 100, `offset` từ 0 đến 10000. `unreadCount` tính trên toàn bộ thông báo của tài khoản, không chỉ trang hiện tại.
- `POST /api/notifications/read` nhận đúng một trường: `{"id":"103"}`, `{"upToId":"103"}` hoặc `{"all":true}`. Hai dạng ID phải lớn hơn 0. Trả `{ "unreadCount": 0 }` nếu không còn mục chưa đọc. Không cập nhật hoặc tiết lộ ID thuộc tài khoản khác. Đọc SSE hoặc tải danh sách không tự đánh dấu đã đọc. Body sai trả `400 INVALID_READ_TARGET`.

| Nhóm event | Tên event | Người nhận |
| --- | --- | --- |
| Đơn | `BOOKING_REQUESTED`, `COORDINATOR_ASSIGNED`, `BOOKING_GROUPED`, `BOOKING_ASSIGNED`, `BOOKING_CANCELLED` | Chủ đơn, điều phối viên được giao và thành viên vận hành của gói liên quan nếu có |
| Gói | `PACKAGE_OPEN`, `PACKAGE_CLAIMED`, `PACKAGE_CANCELLED`, `PACKAGE_RESCHEDULED` | Chủ các đơn trong gói, HTX của gói, chủ máy và thợ được giao nếu có |
| Ca | `SHIFT_STARTED`, `SHIFT_PAUSED`, `SHIFT_RESUMED`, `SHIFT_COMPLETED` | Cùng phạm vi với gói liên quan |
| Nghiệm thu | `ACCEPTANCE_PROPOSED`, `ACCEPTANCE_CONSENTED` | Chủ đơn, chủ máy và HTX được phân công. `entityId` là ID đơn; `payload.version` là phiên bản nghiệm thu |
| Khiếu nại | `DISPUTE_OPENED`, `DISPUTE_RESPONSE_ADDED`, `DISPUTE_MEDIATOR_ASSIGNED`, `DISPUTE_MEDIATION_ESCALATED`, `REMEDY_PROPOSED`, `REMEDY_CONSENTED`, `REMEDY_RESOLVED`, `REMEDY_CLOSED_UNRESOLVED` | Hai bên và người hoà giải được phân công tại thời điểm cập nhật |
| Vai trò | `ROLE_REQUEST_PENDING`, `ROLE_REQUEST_APPROVED`, `ROLE_REQUEST_REJECTED` | Người gửi yêu cầu và quản trị viên ra quyết định, nếu đã có quyết định |

Thông báo chỉ xuất hiện sau khi giao dịch nghiệp vụ commit. Lịch sử chỉ tính từ migration `030`, không nhập lại sự kiện cũ. Payload không chứa nội dung khiếu nại, ảnh, ghi chú riêng hay token. Dùng `entityType` và `entityId` để tải dữ liệu mới qua API nghiệp vụ; việc từng nhận thông báo không thay thế kiểm tra quyền hiện tại trên API chi tiết.
