# CL-09 · Function tạo thumbnail trên Azure

## Đích và cách nghiệm thu

Kiểm theo [issue CL-09 #55](https://github.com/pckienuit/AgriDispatchVN/issues/55). Dùng Azure Functions Blob trigger cho ảnh synthetic trong container `evidence`; kết quả JPEG nằm trong `thumbnails`. Hai container thuộc kho riêng tư `stagriis402bt05a1`. Booking đọc thumbnail thông qua API chỉ cho người thuộc tranh chấp.

| Hạng mục | Giá trị xác nhận |
| --- | --- |
| Subscription và môi trường | Azure for Students, `rg-is402-agri`, Japan East |
| App Service plan | `sp-agri-bt05`, Linux B1, một instance hiện có |
| Function App | `func-thumbnail-bt05a1`, chạy image đã ghim digest, dùng Managed Identity |
| Host storage | `stagrihostbt05a1`, StorageV2 Standard LRS, firewall mặc định Deny. Chỉ subnet `snet-webapp-integration` được phép |
| Image ACR trước bản sửa replay | `acris402agri.azurecr.io/agridispatch-thumbnail@sha256:3b107622a44beffcd0d0c19193adb17391d50c35a4a2d5a6a771077999e7fe04`, commit `bcb982ec2ede30ca5f3d4cc610f29b4f565e0109` |
| Azure Monitor | Dùng `law-agri-bt05a1`, gửi `FunctionAppLogs` để bổ sung log service thứ ba cho CL-11 |
| Quota 23/11/2026 lúc 01:33 UTC+7 | DSv4 4/4 vCPU, toàn vùng 4/6 vCPU. Dùng plan B1 hiện có nên không cần tăng số node |

Đã kiểm lại giá Japan East. Azure Retail Prices báo Hot LRS khoảng 0,020 USD/GB/tháng và thao tác ghi Hot LRS khoảng 0,065 USD/10.000 thao tác. Dự trù thêm 1 USD cho 48 giờ để tính kho host, thao tác Blob/Queue và tải image. Tổng dự toán BT05 khoảng 27,29 USD trong 48 giờ. Phần log dùng workspace CL-11 trong giới hạn thu hiện có. Kiên duyệt phương án CL-09 và Hơn xác nhận credit **98,52 USD** ngay trước khi tạo, lúc khoảng 01:33 ngày 23/11/2026 (UTC+7). Trần 50% là **49,26 USD**. [Azure Retail Prices](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)

## Kiểm local

Kiểm trước triển khai bằng Docker local đạt **21/21**. Bản sửa replay chạy lại `server/tests/blob-store.test.js`, `functions/thumbnail/handler.test.cjs` và `functions/thumbnail/processor.test.cjs` trong chính image Functions Node 24, đạt **48/48**. Có ca JPEG/PNG hợp lệ, quá 5 MiB, sai định dạng, giả ảnh, giải mã lỗi, bỏ EXIF/GPS và output create-only khi xử lý lặp.

## Kết quả Azure

Azure xác nhận `func-thumbnail-bt05a1` và `stagrihostbt05a1` đã tạo lúc 01:34–01:36. Function dùng plan B1, Always On, System-assigned Managed Identity, `AcrPull` trên ACR, quyền đọc `evidence` và ghi `thumbnails` ở phạm vi từng container. Host storage dùng xác thực Entra ID, TLS 1.2, Shared Key và anonymous access đều tắt.

Host ban đầu gặp `AuthorizationPermissionMismatch` ở `GetBlobServiceProperties` và `SetBlobServiceProperties`. `Reader` trên kho host cho phép đọc cấu hình. Quyền tạm chỉ có action `Microsoft.Storage/storageAccounts/blobServices/write` giúp BlobLogListener bật Storage Analytics ghi ở kho host. Azure Metrics ghi một lượt `SetBlobServiceProperties` thành công ở bucket 01:54. Quyền tạm và role definition đã được thu hồi lúc 01:55. [Get Blob Service Properties](https://learn.microsoft.com/en-us/rest/api/storageservices/get-blob-service-properties) · [Set Blob Service Properties](https://learn.microsoft.com/en-us/rest/api/storageservices/set-blob-service-properties)

### Ảnh thật qua Booking API

Evidence ID `032fe3b1-7563-4035-bcbd-c198a2ee5c92` trong tranh chấp synthetic CL-10. Lượt upload đầu trả 503; lần kiểm lại đọc được ảnh cũ rồi upload ảnh mới thành công.

| Ca kiểm | Giờ UTC+7 | Kết quả |
| --- | --- | --- |
| Upload PNG | 01:37:47 | HTTP 201, **640 × 480**, **341.390 byte**, SHA-256 `93f41f0b1a96a699af605b42e0a2810c4ff53e2259a386335025759c36de459e` |
| Bên thuộc tranh chấp đọc thumbnail | 01:54:02 | HTTP 200, JPEG **320 × 240**, **16.142 byte**, SHA-256 `26f722e3109303adbf96f162f1ae3134f6447283d6eac497f00cecac8215b8c9`, request `cl10-b28d3067-fda8-4258-a6f6-15ff6b779219` |
| Gửi lại cùng PNG | 01:54:04 | HTTP 200, cùng evidence ID và cùng SHA-256 của JPEG. Request `cl10-80bfa350-ecf5-4ce0-a0e3-7b406824e946` |
| Đọc lại bản gốc | 01:54:06 | HTTP 200, SHA-256 của PNG khớp lượt upload |
| Kiểm quyền đọc | 01:54:10 | Chưa đăng nhập qua API **401**; admin ngoài tranh chấp **404**; đọc Blob trực tiếp không xác thực **403** |

### Tệp lỗi và ca lặp trên Blob

Booking API chặn PDF bằng **415**, PNG giả bằng **400** và tệp trên 5 MiB bằng **413**. Để kiểm lớp Function, ba fixture synthetic được tải trực tiếp vào một prefix riêng. Function ghi ba lần `thumbnail_rejected`, mã `INVALID_IMAGE`, trong cùng đợt xử lý 01:53:53–01:53:54. Log handler lưu invocation và mã lỗi, còn tên tệp đối chiếu qua chứng cứ upload và kết quả Blob.

| Fixture Azure | Byte | PUT Blob | HEAD thumbnail |
| --- | ---: | --- | --- |
| PDF | 45 | 201 | 404 `BlobNotFound` |
| Trên 5 MiB | 5.242.881 | 201 | 404 `BlobNotFound` |
| Nội dung giả PNG | 58 | 201 | 404 `BlobNotFound` |

Invocation bị từ chối gồm `4289de5e-a99d-4ef4-ae35-8805e48a6c99`, `03708fe0-fcf8-4408-9542-92101bada8ff` và `d75161e0-7de8-41f4-9b4f-b50cc471dfbf`. Invocation tạo thành công trong đợt này gồm `eb0c00c9-07be-4c61-849a-b7e7f22165e3`, `f6aa21e0-099d-485f-a97d-165caaaf0c51` và `dee4efa1-79c9-415e-bd15-fba9ce81e081`.

Lượt kích hoạt lại fixture Blob trên image ban đầu giữ nguyên JPEG nhưng báo `Thumbnail storage unavailable`. PUT có điều kiện được thử riêng trên cùng JPEG synthetic lúc 02:02:13. Azure trả **409 `BlobAlreadyExists`**, request `cf066ab1-c01e-0004-7cb3-7a9b3b000000`. [Mã lỗi Blob](https://learn.microsoft.com/en-us/rest/api/storageservices/blob-service-error-codes)

Bản sửa chỉ coi mã Azure `BlobAlreadyExists` là trường hợp ảnh đã có, tiếp tục dùng `If-None-Match: *`. Function được ghim digest mới `sha256:12b2fd2697d4a68cde5b7f689ad8cd199ad2d8e1c0ec1e0eb1437149b48e8a32` của commit `62e445594bda68c87affef919cc5dc93ca053a05` lúc 02:05:03. Azure đã xác nhận digest, `BUILD_SHA`, Always On và quyền kéo image qua Managed Identity.

Lượt kiểm trên image mới cập nhật metadata của Blob nguồn synthetic lúc 10:05:32 để kích hoạt lại cùng nội dung. Azure Monitor ghi `thumbnail_stored`, `created=false` lúc 10:05:36, invocation `00f8640b-9827-4c4e-b5c8-05d8c56d30f1`. ETag của JPEG trước lượt chạy là `0x8DF48C9F42AF0A4`. Phiên kiểm riêng bị timeout trước bước đọc lại ETag. Hai quyền tạm giới hạn ở prefix synthetic đã được thu hồi lúc 10:08:00 và 10:08:04.

### Chạy lại runbook trên staging

Codex chạy theo yêu cầu của Hơn ngày 23/11/2026. Dùng tài khoản bên tham gia và tranh chấp synthetic có sẵn. Chạy trên digest Function `sha256:12b2fd2697d4a68cde5b7f689ad8cd199ad2d8e1c0ec1e0eb1437149b48e8a32` đã kiểm lại từ Azure. Các mốc dùng UTC+7.

| Giờ | Ca kiểm | Kết quả |
| --- | --- | --- |
| 10:13:59 | Tải PNG synthetic mới 640 × 480, 810.049 byte | HTTP 201, evidence `aa23a6c0-d0b8-4f63-a141-afde18a0f2a4`, request `cl10-7e756843-57c6-46d6-ac88-a169bac7e47a` |
| 10:14:04 | Đọc bản gốc riêng tư | HTTP 200, SHA-256 khớp `730601ee4e2d53e01c43d6388c07a7e5216ca9a0f0fd054d4608b32e2a2ec0cb` |
| 10:14:05–10:14:21 | Đọc thumbnail bằng tài khoản tham gia | Ban đầu 404 `THUMBNAIL_PENDING`, sau đó HTTP 200, JPEG 320 × 240, 14.826 byte, request `cl10-5c183550-8573-4138-8883-9d18cc89c448` |
| 10:14:23 | Gửi lại cùng PNG và đọc lại JPEG | Upload HTTP 200, cùng evidence ID. JPEG HTTP 200, cùng ETag ở API và SHA-256 `4221fd60e2e686dad345ec20332bb538774f4ff3f4d651d505d1632d91c77f59` |
| 10:14:23 | Đọc thumbnail khi chưa đăng nhập | HTTP 401, request `cl10-f4a0d0fc-18e4-42cd-bef8-e9133af7bf88` |

Azure Monitor ghi một lượt tạo mới trong khung kiểm lúc 10:14:07, `thumbnail_stored`, `created=true`, invocation `588de769-2fc3-4d72-93ba-e03aff8fc57f`. Truy vấn trả HTTP 200 lúc 10:17:57.

Lúc 10:18:02, `HEAD` có `If-Match` vào JPEG của ca replay lúc 10:05 trả HTTP 200 với cùng Azure Blob ETag `0x8DF48C9F42AF0A4`. Azure request ID `a6ea0d27-301e-00a9-78f9-7ad74e000000`. Quyền Reader tạm trên prefix synthetic đã được thu hồi lúc 10:18:05.

### Bàn giao CL-11

`diag-cl11-thumbnail` gửi `FunctionAppLogs` vào workspace `law-agri-bt05a1`. Truy vấn Function đúng như runbook trả HTTP 200 lúc 01:56:07 và trả sáu invocation ID của đợt kiểm đầu. [Minh chứng CL-11](cl-11-evidence.md) · [Runbook BT05](cl-11-runbook.md)
