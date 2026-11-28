# CL-08 · Tạo đơn khi Account không phản hồi trên Azure

Ngày **24/11/2026, UTC+7**. Lượt kiểm chạy trong Kubernetes Job tạm `cl08-timeout-1621d4e0` trên AKS `aks-agri-bt05a1`, Japan East, namespace `agridispatch`. Job dùng dữ liệu synthetic, PostgreSQL 17.12 dùng một lần và kết nối loopback trong Pod. Booking và Account dùng mã trong image của staging B1, chạy với cấu hình riêng của Job. Proxy thử nghiệm giữ kết nối `/internal/introspect` và không trả phản hồi chỉ cho request ID của ca timeout. [Issue #54](https://github.com/pckienuit/AgriDispatchVN/issues/54) · [Lượt rà soát trước](https://github.com/pckienuit/AgriDispatchVN/issues/54#issuecomment-7106931838)

- Image thực tế đọc từ Pod `acris402agri.azurecr.io/agridispatch-vn@sha256:737651fd587c06c992e38409126bab661d858afd744cf4c47f79023d56f9fb37`.
- SHA `12154ad9000a77384c8dabecb024cf2809d02b67`. PostgreSQL thử áp dụng riêng 17 migration và seed 4 mục synthetic, trong đó 3 mục đang hoạt động.
- Job UID `2a9ad300-4a75-4ad8-85fd-d1a6d29ca038`. Pod `cl08-timeout-1621d4e0-zc62r` báo `Succeeded`, Job báo `Complete` lúc **00:11:31, UTC+7**.

| Giờ UTC+7 | Ca | Kết quả |
| --- | --- | --- |
| 00:11:23.894 | Tạo đơn đối chứng | `POST /api/bookings` trả **201**. Cùng request ID `cl08-timeout-1621d4e0-control`, Account ghi **200** và Booking ghi **201**. |
| 00:11:26.900 | Account không phản hồi | `POST /api/bookings` trả **503 `IDENTITY_UNAVAILABLE`** sau **3.005 ms**, request ID `cl08-timeout-1621d4e0-timeout`. |
| 00:11:26.900 | Đối chiếu DB trước và sau ca lỗi | `dispatch.bookings` giữ **1 → 1**. `dispatch.idempotency_keys` cho khóa của ca lỗi giữ **0 → 0**. |
| 00:11:26.916 | Chạy lại khi Account phản hồi | Cùng payload và khóa của ca timeout, request ID `cl08-timeout-1621d4e0-recovery`, trả **201**. DB tăng lên **2 đơn** và **1 dòng** cho khóa này. |

### Trích log từ Kubernetes Job

```json
{"utc":"2026-11-23T17:11:26.900Z","job":"cl08-timeout-1621d4e0","step":"timeout","route":"POST /api/bookings","requestId":"cl08-timeout-1621d4e0-timeout","status":503,"code":"IDENTITY_UNAVAILABLE","elapsedMs":3005,"stalledRequest":{"requestId":"cl08-timeout-1621d4e0-timeout","path":"/internal/introspect","responseWithheld":true},"before":{"bookings":1,"failed_key_rows":0},"after":{"bookings":1,"failed_key_rows":0}}
```

Ca kiểm đạt tiêu chí Booking từ chối tạo đơn khi Account không phản hồi. Phép thử dùng image thật trên AKS và được cô lập trong Job. Lượt đầu `cl08-timeout-87ef0785` bị chính sách Pod Security của namespace chặn tạo Pod. Lượt đạt đặt PostgreSQL thử chạy non-root và tuân thủ cấu hình `restricted`.

### Kiểm lại staging và dọn Job thử

- Lúc **00:12:13–00:12:14, UTC+7**, Booking staging trả HTTP **200** cho `/health` và `/ready`, vẫn chạy SHA `12154ad`. Hai request ID lần lượt là `9061cdb0-f1ba-41b3-b71f-5e1d0ccaaf5e` và `23e88d27-6c4b-4b8f-bfcf-4df08bf6fdc0`.
- Lúc **00:12:44, UTC+7**, AKS xác nhận đã xóa hai Job thử và không còn Job hay Pod mang nhãn `cl08-timeout-probe`. Deployment Account đang phục vụ staging có **2/2** replica `Ready`.
