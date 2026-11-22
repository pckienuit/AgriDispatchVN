# CL-07 · Blue/green booking trên Azure

Ngày 22/11/2026. Tất cả mốc giờ dưới đây theo giờ Việt Nam (UTC+7).

Đã xác nhận cùng URL staging phục vụ **A → B → A** qua hai lần App Service slot swap. Bản B tạo một đơn synthetic mới. Sau rollback và sau khi hạ gói B1, bản A đều đọc được đơn mới và đơn đã có từ trước.

## Môi trường và chi phí

- Resource group `rg-is402-agri`, Japan East, subscription `Azure for Students`.
- Web App `app-booking-bt05a1`, App Service plan `sp-agri-bt05`, một Linux instance. Kiên duyệt dùng S1 tối đa 10 phút cho lượt thử CL-07.
- [URL staging chính](https://app-booking-bt05a1-dhedg0a2c0aecnfh.japaneast-01.azurewebsites.net) giữ cùng hostname trong cả ba lần kiểm. Slot thử là `cl07-green`, đã xóa sau kiểm tra.
- Cả hai môi trường dùng Enhanced container qua `main` cổng `3000`, HTTPS, identity `id-booking-web-bt05`, VNet integration `snet-webapp-integration`, PostgreSQL staging private và account AKS tại `http://10.42.2.240:3001`. Cấu hình kiểm từ Azure xác nhận hai tham chiếu Key Vault `DATABASE_URL` và `INTERNAL_SERVICE_TOKEN` giống nhau. B đặt `WEBSITE_WARMUP_PATH=/ready` và `WEBSITE_WARMUP_STATUSES=200` trước khi thử.
- Tổng ba lượt từ yêu cầu S1 đến khi xác nhận B1 là **7 phút 45 giây** (`11 + 220 + 234` giây). Tổng từ lúc đọc thấy S1 đến lúc đọc thấy B1 là 7 phút 35 giây. Theo chênh lệch giá niêm yết `0,093 USD/giờ`, chi phí compute tăng khoảng **0,012 USD** trong khung trên. [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)

| Bản | Commit SHA | Image đã ghim trong ACR |
| --- | --- | --- |
| A | `12154ad9000a77384c8dabecb024cf2809d02b67` | `acris402agri.azurecr.io/agridispatch-vn@sha256:737651fd587c06c992e38409126bab661d858afd744cf4c47f79023d56f9fb37` |
| B | `15c7a1ae81e884b1de96d11c1065cf8a572eb9b2` | `acris402agri.azurecr.io/agridispatch-vn@sha256:d8280e182ff9682f6c962b57f330bc72928a56a26f3d021de88e846455773aae` |

## Kết quả trên Azure

| Giờ | Kiểm tra | HTTP | SHA nhận được |
| --- | --- | --- | --- |
| 21:20:51 | URL chính trước swap, `/health` và `/ready` | 200, 200 | A |
| 21:22:07 | URL riêng slot B trước khi nhận traffic, `/health` và `/ready` | 200, 200 | B |
| 21:22:09 | Đăng nhập và đọc đơn mẫu trên URL riêng của B | 200, 200 | B |
| 21:23:16 | URL chính sau swap, `/health` và `/ready` | 200, 200 | B |
| 21:23:17 | Tạo đơn synthetic từ URL chính | 201 | B |
| 21:24:25 | URL chính sau swap ngược, `/health` và `/ready` | 200, 200 | A |
| 21:24:26 | Đọc lại cả hai đơn từ URL chính | 200, 200 | A |
| 21:24:43 | Kiểm tra slot `cl07-green` đã xóa | | |
| 21:24:47 | Azure xác nhận plan B1, 1 instance | | |
| 21:24:48 | URL chính khi đã về B1, `/health` và `/ready` | 200, 200 | A |
| 21:24:49–21:24:50 | Đọc lại cả hai đơn khi đã về B1 | 200, 200 | A |

Đọc lại bằng `GET /api/bookings/{id}` dưới tài khoản demo đã xác thực. Đơn có từ trước là `8e0e3fb5-4bee-4415-87f6-7c5313908a4e`. Đơn tạo trên B là `8e01a0c6-0955-4f32-959a-cc0ddeae5baa`, nhãn `synthetic`. Rollback thực hiện ở App Service. Cả hai lượt kiểm sau rollback đọc cùng PostgreSQL staging.

## Azure Activity Log

| Thao tác | Correlation ID | Mốc Azure |
| --- | --- | --- |
| Nâng S1 ở lượt swap | `628b467b-d43c-4cec-9121-05f4ab0e7be8` | 21:20:54 `Succeeded` |
| Swap A → B | `b283d69c-72a6-4dde-91e2-8cca6523dd8d` | 21:22:09 `Started`, 21:22:10 `Accepted`, 21:23:03 `Succeeded` |
| Swap B → A | `67763d16-90f7-4d96-8448-c2b393060d65` | 21:23:17 `Started`, 21:23:19 `Accepted`, 21:24:15 `Succeeded` |
| Xóa slot thử | `fc4cb66a-6626-4af8-af8a-dd78c3ab769c` | 21:24:40 `Succeeded` |
| Hạ B1 | `02d4eaef-fd18-4553-99a9-a60b833d66c0` | 21:24:45 `Succeeded` |

Hai lượt chuẩn bị trước lần swap cuối lần lượt gặp HTTP 400 khi tạo slot qua ARM và URL chính vẫn trả SHA A khi dùng quy tắc Traffic Routing 100%. Mỗi lượt đều trả lại B1. Lượt cuối dùng lệnh tạo slot từ cấu hình A và swap native của App Service. Sau khi dọn, Azure trả danh sách slot `[]`, routing rules `[]` và xác nhận container `main` dùng digest A.
