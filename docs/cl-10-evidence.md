# CL-10 · Blob private và upload ảnh staging

**Đạt các ca kiểm trên Azure staging ngày 23/11/2026 (UTC+7).** Ảnh synthetic được ghi vào Azure Blob riêng tư và tải lại với cùng SHA-256 trước và sau restart. Azure Storage ghi nhận `PutBlob` và `GetBlob` thành công qua OAuth.

## Cấu hình đã kiểm

| Hạng mục | Kết quả |
| --- | --- |
| Booking staging | `app-booking-bt05a1` ([URL staging](https://app-booking-bt05a1-dhedg0a2c0aecnfh.japaneast-01.azurewebsites.net)) |
| Bản booking | SHA `12154ad9000a77384c8dabecb024cf2809d02b67`, digest `sha256:737651fd587c06c992e38409126bab661d858afd744cf4c47f79023d56f9fb37` |
| Storage account | `stagriis402bt05a1`, `rg-is402-agri`, Japan East, StorageV2, Standard LRS |
| Bảo mật | HTTPS bắt buộc, TLS tối thiểu 1.2, anonymous access và Shared Key đều tắt. `evidence` và `thumbnails` đều Private (`publicAccess=None`) |
| Mạng | Firewall mặc định `Deny`, cho phép `vnet-agri-bt05/snet-webapp-integration` qua service endpoint `Microsoft.Storage` và IP vận hành đã duyệt |
| Managed Identity | System-assigned identity của booking có `Storage Blob Data Contributor` trên `evidence` và `Storage Blob Data Reader` trên `thumbnails` |
| App settings | `EVIDENCE_BLOB_ACCOUNT_URL=https://stagriis402bt05a1.blob.core.windows.net`, `EVIDENCE_CONTAINER=evidence`, `THUMBNAIL_CONTAINER=thumbnails` |

## Kiểm ghi và đọc ảnh

Kiên duyệt tạo admin demo riêng. Bootstrap đã cấp role `admin` trên staging, đăng nhập và `GET /api/admin/role-requests` đều trả HTTP 200. Tài khoản demo dùng để duyệt role và tạo dữ liệu synthetic qua API. Đơn mẫu `4997d661-492a-489f-8871-6a913adc1980` có tranh chấp `OPEN` mã `7f268b6c-6f0c-4dc8-aaa4-67e72926adc5`.

| Giờ (UTC+7) | Ca kiểm | Kết quả và dấu vết |
| --- | --- | --- |
| 00:46:39 | Bên mở tranh chấp tải lên ảnh PNG | HTTP **201**, `UPLOADED`. Request ID `cl10-015e5ec6-a3c2-4768-bb3e-8b4026634bbb` |
| 00:46:40 | Bên tải lên đọc lại ảnh | HTTP **200**, SHA-256 khớp. Request ID `cl10-b9dda6e8-2a29-4c0f-9ad8-4b5f6706cc93` |
| 00:46:42 | Bên còn lại trong tranh chấp đọc ảnh | HTTP **200**, SHA-256 khớp. Request ID `cl10-651c5db3-f3e0-4655-be51-6cbb589922bf` |
| 00:48:22–00:48:25 | Restart booking và đọc lại ảnh | Azure Activity Log `Succeeded`, correlation ID `dd458651-da3e-48b7-8edd-5e5244cbd605`. `/health` và `/ready` HTTP **200**, cùng SHA. Đọc ảnh HTTP **200**, cùng evidence ID, dung lượng và SHA-256. Request ID `cl10-b855d21d-b434-4ab4-a9b4-4839e2e3d9e3` |

Azure Monitor ghi nhận `Transactions` của Blob Service lúc bucket `2026-11-22T17:47:00Z` (00:47 giờ Việt Nam), lọc `ResponseType=Success` và `Authentication=OAuth`. `PutBlob` có 1 lượt, `GetBlob` có 2 lượt ở thời điểm truy vấn. Đây là số liệu tổng hợp theo phút của kho. Request ID trong bảng là log kiểm qua API staging.

## Ca lỗi đã chạy trên staging

| Ca kiểm | Kết quả | Request ID |
| --- | --- | --- |
| Đọc ảnh qua app khi chưa đăng nhập | HTTP **401**, `UNAUTHENTICATED` | `cl10-b99f4d5f-527b-4af4-9df0-7ce0294a7dbe` |
| Admin ngoài phạm vi tranh chấp đọc ảnh | HTTP **404**, `NOT_FOUND` | `cl10-28949fcd-66be-48eb-a536-a3e5f141f6b6` |
| Admin ngoài phạm vi tranh chấp tải ảnh lên | HTTP **404**, `NOT_FOUND` | `cl10-833f40c0-86c6-4f78-9d88-76fc3737d75a` |
| Tải tệp PDF | HTTP **415**, `UNSUPPORTED_MEDIA_TYPE` | `cl10-332cad11-a728-47d9-a28d-1cb4108430c4` |
| Khai báo PNG nhưng nội dung không phải PNG | HTTP **400**, `INVALID_IMAGE` | `cl10-26027338-0ad2-455c-8799-adfa906cbc5f` |
| Tải ảnh lớn hơn giới hạn 5 MiB | HTTP **413**, `PAYLOAD_TOO_LARGE` | `cl10-b9a78e98-cb46-4bdf-86d3-13938a4949ce` |
| Đọc trực tiếp object thật từ Blob khi chưa xác thực | HTTP **403** từ Azure Storage | `4ee92d19-d01e-007a-72a9-7a0b7c000000` |
| Tải ảnh PNG hợp lệ khi thiếu cấu hình Blob | HTTP **503**, `STORAGE_UNAVAILABLE`, lúc 00:55:10 | `cl10-f888f679-d541-45bb-86d4-160b9a30dee2` |

Booking báo `storageAvailable:false` sau khi tạm gỡ ba App settings Blob. Sau khi khôi phục ba giá trị, lúc 00:56:37 `/ready` và lượt đọc ảnh gốc đều trả HTTP 200. Danh sách còn đúng một ảnh. SHA-256 khớp, Request ID `cl10-cf9c7eb6-a99a-42e2-9cce-c6c4c8cfcec8`.

## Object đầu vào cho CL-09 (#55)

| Trường | Giá trị |
| --- | --- |
| Kho và container | `stagriis402bt05a1` / `evidence` |
| Evidence ID | `f84cb667-5067-4fb6-b57f-5d6d55149a40` |
| Object key | `7f268b6c-6f0c-4dc8-aaa4-67e72926adc5/f84cb667-5067-4fb6-b57f-5d6d55149a40/e626fd269a373f9dc80b08351e376dfeae2f69396008f9369ab7d5795d58a0ad` |
| SHA-256 | `e626fd269a373f9dc80b08351e376dfeae2f69396008f9369ab7d5795d58a0ad` |
| Nội dung | Synthetic, `image/png`, 64 × 48 px, 8.312 byte |
| ETag | `"0x8DF48C08F7F6EB5"` từ metadata DB ghi sau lượt upload |
| Blob version | Trống trong DB, versioning của kho tắt |

Ảnh gốc được giữ trong container `evidence` để CL-09 dùng kiểm tạo thumbnail. Đọc qua `GET /api/evidence/f84cb667-5067-4fb6-b57f-5d6d55149a40/content` bằng tài khoản thuộc tranh chấp.

Kiểm bổ sung trong Docker với PostgreSQL 17 dùng một lần. `node --test server/tests/integration/services.test.js` đạt 1/1, có kiểm API trả 503 khi booking chạy thiếu cấu hình Blob.
