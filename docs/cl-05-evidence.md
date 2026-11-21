# Minh chứng triển khai staging CL-05

Cập nhật ngày **21/11/2026 (UTC+7)**. `account-service` demo và booking chạy trên hai Web App dùng chung plan B1, ghim cùng digest đã chốt. Cả hai trả `/health` và `/ready` HTTP `200` với SHA đúng. PostgreSQL có đủ 17 migration và danh mục `synthetic`. Đã tạo và đọc đơn mẫu qua URL staging, rồi xác nhận một đơn kiểm khác vẫn tồn tại trong PostgreSQL sau khi restart booking. Còn kiểm PostgreSQL trực tiếp từ máy ngoài Azure qua đường private, một lần push tự deploy và bàn giao. [Issue #51](https://github.com/pckienuit/AgriDispatchVN/issues/51)

## Release trên ACR

Azure CLI đã đối chiếu hai digest với tag của commit trong registry. Image app dùng cho booking và account. Image Function dành cho thumbnail. [GitHub Actions run #63](https://github.com/pckienuit/AgriDispatchVN/actions/runs/44481270748)

```text
Commit SHA: 62354bc6b794e00767796319f607aa42a6441749
ACR Registry: acris402agri.azurecr.io
App Image Ref: acris402agri.azurecr.io/agridispatch-vn@sha256:52cbf149b5515f2f9ea23b7728a4cb5d6a00405f3719b5e06427cd139fd98145
Function Image Ref: acris402agri.azurecr.io/agridispatch-thumbnail@sha256:0e2dacf722d4893d9b664fb06614f45c7d4d8748a0c0ab5e14098203405ff937
```

## Tài nguyên Azure đã xác nhận

Resource group `rg-is402-agri` có sự kiện tạo thành công ngày **19/11/2026 lúc 15:54**. Bảng dùng `createdAt` khi Azure có trường này, hoặc mốc ghi thành công sớm nhất tìm thấy trong Activity Log của lần kiểm. Tất cả thời gian dùng UTC+7.

| Tài nguyên | Loại, cấu hình | Region | Mốc Azure |
| --- | --- | --- | --- |
| `acris402agri` | Container Registry Basic | Korea Central | 19/11/2026 16:53 |
| `vnet-agri-bt05` | Virtual network | Japan East | 20/11/2026 22:06 |
| `psql-agri-bt05a1.private.postgres.database.azure.com` | Private DNS zone có liên kết VNet | Global | 20/11/2026 22:23 |
| `id-booking-web-bt05` | User-assigned managed identity | Japan East | 20/11/2026 22:24 |
| `psql-agri-bt05a1` | Flexible Server 17, Burstable `Standard_B1ms`, 32 GiB | Japan East | 20/11/2026 22:24 |
| `sp-agri-bt05` | Linux App Service Plan Basic B1 | Japan East | 20/11/2026 22:49 |
| `app-booking-bt05a1` | Linux Web App, container Enhanced, Basic B1 | Japan East | 20/11/2026 22:50 |
| `kv-agri-bt05a1` | Key Vault Standard, Azure RBAC | Japan East | 21/11/2026 00:59 |
| `id-account-web-bt05` | User-assigned managed identity cho account demo | Japan East | 21/11/2026 01:45 |
| `app-account-bt05a1` | Linux Web App Enhanced, dùng chung plan `sp-agri-bt05` B1 | Japan East | 21/11/2026 01:46 |

## Kiểm tra Web App và PostgreSQL

| Hạng mục | Kết quả ngày 20/11/2026 |
| --- | --- |
| URL Web App | [app-booking-bt05a1](https://app-booking-bt05a1-dhedg0a2c0aecnfh.japaneast-01.azurewebsites.net). Đây là hostname của Web App chính trên B1. Portal yêu cầu nâng tier mới tạo được deployment slot. |
| Image trên Web App | Container `main` được cấu hình cổng `3000` và đang trỏ tới tag `62354bc6b794e00767796319f607aa42a6441749`. Cần ghim digest và lưu log kéo image thành công. |
| Managed Identity | Azure xác nhận `id-booking-web-bt05` có role `AcrPull` ở phạm vi `acris402agri`. Container `main` cấu hình xác thực `UserAssigned`. |
| HTTPS | Web App bật HTTPS Only, TLS inbound tối thiểu `1.2`, Always On bật và FTP tắt. |
| Mạng riêng | Web App có VNet integration. Hai subnet `snet-webapp-integration` và `snet-pg` lần lượt có delegation `Microsoft.Web/serverFarms` và `Microsoft.DBforPostgreSQL/flexibleServers`. PostgreSQL báo public network access `Disabled`. |
| PostgreSQL | Server `Ready`, hostname `psql-agri-bt05a1.postgres.database.azure.com`, `require_secure_transport=on`. Danh sách database chưa có `agridispatch`. Còn kiểm TLS từ client với `sslmode=verify-full` và lưu log kết nối. |
| Cấu hình khởi động | Azure có tên biến `PORT`, `NODE_ENV`, `BUILD_SHA`, `TRUST_PROXY_HOPS`. Chưa thấy `DATABASE_URL`, `INTERNAL_SERVICE_TOKEN` và `ACCOUNT_SERVICE_URL` trong App settings. |
| HTTP từ máy làm việc | `/health` hết thời gian chờ sau 15 giây. `/ready` trả `503 Service Unavailable`. Chưa thu được `X-Build-SHA` từ `/health`. |

## Kiểm private DNS, TCP và TLS ngày 21/11/2026

- Terminal SSH Kudu của `app-booking-bt05a1` phân giải `psql-agri-bt05a1.postgres.database.azure.com` qua Private DNS về `10.42.3.4` và báo `TCP 5432 OK`.
- Azure CLI xác nhận đã có database `agridispatch`. Server bật PostgreSQL password authentication và tắt Microsoft Entra authentication.
- Từ Kudu, `openssl s_client -starttls postgres` với tùy chọn kiểm hostname và dừng khi kiểm chứng chỉ lỗi trả exit code `0`. Kết quả ghi `Protocol version: TLSv1.3`, `Verification: OK` và `Verified peername: psql-agri-bt05a1.postgres.database.azure.com`.
- Ảnh terminal Kudu xác nhận `psql` 16.15 đã xác thực và chạy truy vấn `pg_stat_ssl` với `sslmode=verify-full` và CA hệ thống. Kết quả trả một dòng gồm `current_database = agridispatch`, `ssl = t`, `version = TLSv1.3`. Bước kiểm TLS từ Kudu đã hoàn tất. Còn kiểm kết nối riêng từ máy ngoài Azure.

## Các bước triển khai và nghiệm thu CL-05

### 1. Tạo database `agridispatch` trên server có sẵn

1. Trên Azure Portal, mở **`psql-agri-bt05a1` → Settings → Databases**. Nếu chưa có `agridispatch`, bấm **Add**, nhập tên **`agridispatch`** và lưu. Nếu Portal hiện các ô tương ứng, chọn charset `UTF8` và collation `en_US.utf8` theo repo. [Cấu hình database](../infra/terraform/database.tf) · [Thao tác trên Portal](https://learn.microsoft.com/en-us/azure/developer/python/tutorial-deploy-python-web-app-azure-container-apps-02#create-a-database)
2. Refresh danh sách để xác nhận `agridispatch` đã xuất hiện. Mở **Networking** và kiểm lại **Private access**, subnet `snet-pg` và Private DNS liên kết với `vnet-agri-bt05`.
3. Chọn máy hoặc runner có đường vào VNet đã duyệt. Từ máy đó, kiểm hostname `psql-agri-bt05a1.postgres.database.azure.com` phân giải về IP private và cổng `5432` truy cập được. Từ máy ngoài Azure, dùng đường kết nối private được duyệt cho bài kiểm DB. [Mạng private của PostgreSQL](https://learn.microsoft.com/en-us/azure/postgresql/network/concepts-networking-private)
4. Dùng `psql` trên máy có đường vào VNet. Đặt `PGSSLROOTCERT` trỏ đến CA bundle theo hướng dẫn Azure. Lệnh dưới đây dùng tài khoản quản trị đã ghi trong lúc tạo server và hỏi mật khẩu tại terminal. Nếu nhóm đã cấp migrator riêng, thay giá trị `user` bằng tài khoản đó. [TLS và CA của Azure PostgreSQL](https://learn.microsoft.com/en-us/azure/postgresql/security/security-tls)

   ```sh
   psql "host=psql-agri-bt05a1.postgres.database.azure.com port=5432 dbname=agridispatch user=agridbadmin sslmode=verify-full connect_timeout=10" -W -c "SELECT current_database(), ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();"
   ```

   **Lưu minh chứng** gồm danh sách database, ảnh **Networking**, giờ kiểm, hostname và kết quả `current_database = agridispatch`, `ssl = t`, phiên bản TLS. Bỏ thông tin đăng nhập khỏi log và ảnh.

### 2. Chạy migration, cấp quyền DB và seed (đã hoàn tất)

Ảnh terminal Kudu ngày **21/11/2026** xác nhận kết quả trên database `agridispatch` của server `psql-agri-bt05a1`. Migration và seed dùng runner riêng `/tmp/cl05db`, bên ngoài lệnh khởi động Web App.

| Lệnh trong SSH Kudu | Kết quả đã xác nhận |
| --- | --- |
| `/tmp/cl05db v` | Lịch sử có đủ **17/17** migration, `complete: true`. Migration cuối là `017_validate_mediator_history.sql`. |
| `/tmp/cl05db r` | Bootstrap trả `mode: apply`. Hai role `account_runtime` và `booking_runtime` đều có trạng thái `created`. |
| `/tmp/cl05db s` | Chạy seed thành công bằng `booking_runtime`. Log trả `{"dataLabel":"synthetic","services":4,"activeServices":3}`. |

Trình tự dùng khi thiết lập lại staging.

1. Trên runner có đường private ở bước 1, dùng đúng commit hoặc App Image Ref của release để chạy migration. Cấp `DATABASE_URL` của migrator từ kênh bí mật với `sslmode=verify-full`. Nếu dùng migration Job đọc Key Vault, tạo `MIGRATION-DATABASE-URL` và cấp quyền đọc cho identity của Job trước khi chạy.
2. Chạy `npm run db:migrate` riêng. Kiểm exit code và đọc lại `public.schema_migrations` bằng tài khoản bảo trì để xác nhận các migration đã áp dụng.
3. Chạy `node server/scripts/bootstrap-db.js --dry-run`. Khi kết quả khớp DB và schema, dùng hai mật khẩu runtime riêng qua biến môi trường `NEW_ACCOUNT_DB_PASSWORD` và `NEW_BOOKING_DB_PASSWORD`, rồi chạy lệnh bootstrap có xác nhận đích sau đây. [Hướng dẫn bootstrap và quyền runtime](database-deploy.md#deployment-order)

   ```sh
   node server/scripts/bootstrap-db.js --apply --confirm-host psql-agri-bt05a1.postgres.database.azure.com --confirm-database agridispatch
   ```

4. Lần triển khai này dùng runner tạm trên Kudu để seed staging bằng role `booking_runtime` qua `sslmode=verify-full`. Log ghi bốn dịch vụ mẫu có nhãn `synthetic`. Repo có lệnh seed riêng cho môi trường local. [Seed local](development.md)

### 3. Đưa cấu hình runtime vào Key Vault

Ngày **21/11/2026**, Azure CLI xác nhận vault `kv-agri-bt05a1` có đủ ba secret đang bật. Web App `app-booking-bt05a1` dùng `id-booking-web-bt05` làm `keyVaultReferenceIdentity`. Identity có role **Key Vault Secrets User** ở phạm vi từng secret `BOOKING-DATABASE-URL` và `INTERNAL-SERVICE-TOKEN`.

| App setting của booking | Secret | Trạng thái từ Azure |
| --- | --- | --- |
| `DATABASE_URL` | `BOOKING-DATABASE-URL` | `Resolved` |
| `INTERNAL_SERVICE_TOKEN` | `INTERNAL-SERVICE-TOKEN` | `Resolved` |

Web App account dùng `id-account-web-bt05` làm `keyVaultReferenceIdentity`. Identity có **Key Vault Secrets User** trên `ACCOUNT-DATABASE-URL` và `INTERNAL-SERVICE-TOKEN`. Azure xác nhận cả hai tham chiếu tương ứng là `Resolved`. [Tham chiếu Key Vault và Managed Identity](https://learn.microsoft.com/en-us/azure/app-service/app-service-key-vault-references)

### 4. Triển khai account-service và ghim image booking

**Đã ghim image booking ngày 21/11/2026.** Azure CLI đọc lại container `main` trên `app-booking-bt05a1` và xác nhận image đúng **App Image Ref** ở trên, cổng `3000`, xác thực ACR bằng `UserAssigned`. `BUILD_SHA` khớp commit `62354bc6b794e00767796319f607aa42a6441749` trong App settings.

Log Kudu lúc **01:31:22** ghi booking tạo container từ đúng digest và thoát mã `1` khi cấu hình còn thiếu `ACCOUNT_SERVICE_URL`. Lần kiểm `/ready` lúc **01:31:28** trả HTTP `503`. Sau khi thêm origin account, startup probe của booking thành công lúc **01:51:17**. [Cấu hình booking](../server/src/config.js)

**Kiểm trước khi tạo Web App demo cho `account-service` ngày 21/11/2026.** Subscription `Azure for Students` chưa có cụm AKS và Japan East có `0/6` vCPU tổng, `0/4` vCPU DSv3. Trước khi thêm account, App Service Plan Linux B1 `sp-agri-bt05` tại Japan East có **1 instance và 1 Web App**.

| Hạng mục | Kết quả xác nhận |
| --- | --- |
| Web App demo | Tên `app-account-bt05a1` còn trống. ARM Validate trả HTTP `200`, `Succeeded` cho cấu hình dùng plan B1 hiện có, bật HTTPS Only và tắt public access lúc tạo. |
| Mạng | Booking đã tích hợp `snet-webapp-integration` (`10.42.1.0/24`). Phương án demo dùng chung subnet và cần bật service endpoint `Microsoft.Web` để giới hạn ingress của account theo subnet. |
| Bí mật | `ACCOUNT-DATABASE-URL` và `INTERNAL-SERVICE-TOKEN` đang bật trong `kv-agri-bt05a1`. |
| Credit lúc 01:43:18 (UTC+7) | Azure Consumption API trả **99,93 USD hiện tại**, **99,73 USD ước tính** cho billing profile có một subscription là `Azure for Students`. Mốc CL-02 ghi trong tài liệu là **86,06 USD**. Người dùng xác nhận Kiên cho phép tiếp tục phương án demo trước khi tạo Web App và identity. [Mốc CL-02](cloud.md) · [API số dư](https://learn.microsoft.com/en-us/rest/api/consumption/credits/get?view=rest-consumption-2024-08-01) |

**Đã triển khai account-service demo.** Azure xác nhận plan B1 `sp-agri-bt05` có **2 Web App trên 1 instance**. `app-account-bt05a1` chạy `node server/src/account-server.js` ở cổng `3001` từ cùng **App Image Ref**. `id-account-web-bt05` có `AcrPull` trên `acris402agri`. Account bật `REQUIRE_SIGNED_CLIENT_IDENTITY=true` và dùng cùng token Key Vault với booking.

- Origin account là `https://app-account-bt05a1.azurewebsites.net`, đã ghi vào `ACCOUNT_SERVICE_URL` của booking. Azure chỉ cho subnet `snet-webapp-integration` vào account qua service endpoint `Microsoft.Web`. Rule `AllowStagingSubnet` ưu tiên `100`, mặc định `Deny`. SCM dùng cùng giới hạn. Từ máy ngoài subnet, `/health` của account trả HTTP `403`.
- Từ Kudu booking lúc **01:49:50–01:49:51**, `/health` và `/ready` của account đều trả HTTP `200` và `X-Build-SHA: 62354bc6b794e00767796319f607aa42a6441749`. Repo đặt timeout 2 giây cho lượt kiểm `/ready` tới account và 3 giây cho các lời gọi xác thực. [Readiness](../server/src/app.js) · [Timeout xác thực](../server/src/service-auth.js)

### 5. Kiểm HTTPS, TLS và dữ liệu từ staging

Từ máy ngoài Azure ngày **21/11/2026**, booking `/health` trả HTTP `200` lúc **01:52:16** và `/ready` trả HTTP `200` lúc **01:52:19**. Cả hai trả `X-Build-SHA: 62354bc6b794e00767796319f607aa42a6441749`. `/ready` kiểm được PostgreSQL và account. Release bắt buộc `sslmode=verify-full` cho kết nối PostgreSQL từ xa. [Cấu hình TLS của runtime](../server/src/db.js)

Lần kiểm lại lúc **01:57:46–01:57:47** từ máy làm việc xác nhận `/health`, `/ready` và `/api/services` đều trả HTTP `200`, đúng SHA. Danh mục trả 3 dịch vụ `synthetic` đang hoạt động. Bắt tay HTTPS với hostname booking dùng `TLSv1.3`, xác thực chứng chỉ thành công.

| Thao tác trên URL booking staging | Kết quả |
| --- | --- |
| `GET /api/services` | `200`, 3 dịch vụ `synthetic` đang hoạt động |
| Đăng ký, đăng nhập tài khoản `synthetic` | HTTP `201`, `200` |
| Tạo thửa ruộng demo | HTTP `201` |
| `POST /api/bookings` | HTTP `201`, ID `89e0beb8-90e9-4e9e-a9de-4d5a83349d28` |
| `GET /api/bookings/:id` | HTTP `200`, đọc lại đúng ID và nhãn `synthetic` |
| Đăng xuất | HTTP `204` |

- **PostgreSQL từ trong VNet.** Kudu booking phân giải hostname DB về `10.42.3.4`. OpenSSL kết nối cổng `5432` với `-starttls postgres`, `-verify_hostname` và `-verify_return_error`. Kết quả là `TLSv1.3`, `Verification: OK`, `Verified peername: psql-agri-bt05a1.postgres.database.azure.com`. Azure xác nhận `require_secure_transport=on` và `publicNetworkAccess=Disabled`. [TLS trên Azure PostgreSQL](https://learn.microsoft.com/en-us/azure/postgresql/security/security-tls)
- **PostgreSQL trực tiếp từ máy ngoài Azure còn chờ đường private.** Lúc **01:57:48**, máy làm việc không phân giải được hostname DB qua DNS và chỉ có route mặc định `0.0.0.0/0` tới `10.42.3.4`. Azure không liệt kê VPN gateway, Bastion, ExpressRoute hay peering cho đường vào VNet staging trong phạm vi đã kiểm. Khi có đường private và DNS được duyệt, chạy lại `psql` với `sslmode=verify-full` ở bước 1. [Mạng private của Azure PostgreSQL](https://learn.microsoft.com/en-us/azure/postgresql/network/concepts-networking-private)

### 6. Kiểm một lần push tự deploy và restart

Lượt kiểm trước khi mở deploy ngày 21/11/2026 dùng Jenkins chạy bằng Docker và Azure DevOps agent `cl05-docker-local`. Jenkins đọc đúng commit `efd4104b85e5af195e0eed82f7c52ad0a77a77da` từ GitHub bằng deploy key chỉ đọc. Jenkins build #1 kết thúc `SUCCESS` với `PUBLISH=false`. Lint đạt, unit có 484 bài đạt và 1 bài bỏ qua, integration PostgreSQL Docker đạt 237/237, Function test đạt 21/21. Build tạo manifest local và đã dọn DB test.

Người triển khai xác nhận Kiên đồng ý bằng lời cho lượt tự deploy lên hai Web App B1 hiện có. Tham chiếu trong pipeline là `CL02-KIEN-B1-20261121`. Lần kiểm trước deploy khoảng 10:29 (UTC+7) cho thấy credit hiện tại 99,93 USD, credit ước tính 99,52 USD. Japan East dùng 0/6 vCPU tổng và 0/4 vCPU DSv3. Hai Web App B1 đang chạy tại Japan East.

Pipeline Azure DevOps `AgriDispatchVN-Demo-B1` dùng pool `agridispatch-jenkins-bridge`, kết nối Jenkins qua HTTPS và triển khai qua Workload Identity Federation. Jenkins xác thực ACR bằng chứng chỉ ngắn hạn. Environment demo có Approval và Exclusive lock. Azure DevOps đã preview được các stage Build và DeployDemoB1 sau khi gán pool mặc định.

Push commit `c6baa74e7e0ed62ae32e5cf01e78f964c22e0cf5` chỉ thay đổi file minh chứng. Azure DevOps chưa ghi nhận CI run cho SHA này. API Source Providers trả 0 webhook. Khi yêu cầu khôi phục CI webhook cho repo, Azure DevOps trả HTTP 500 và nêu quyền quản lý hook của kết nối GitHub OAuth có thể chưa đủ. Chủ repo cần cấp quyền cho Azure Pipelines để nhận push. Bước push tự deploy vẫn đang chờ. [Pipeline Azure DevOps](https://dev.azure.com/agridispatch-is402-bt05/AgriDispatchVN/_build?definitionId=1) · [Cấu hình Azure Pipelines với GitHub](https://learn.microsoft.com/en-us/azure/devops/pipelines/repos/github?view=azure-devops)

Kiên đã cấp quyền Azure Pipelines GitHub App trên repo. Pipeline B1 #1 đã chuyển sang kết nối GitHub App `github.com_pckienuit`. Đã kiểm qua API rằng app đọc được YAML từ `demo/cl05-b1`, CI trigger dùng cấu hình YAML, preview có stage `DeployDemoB1` và agent `cl05-docker-local` đang Online.

Push `9a9f1bf81dbbaeea083021fa7fb9321cdcbac781` tự kích hoạt run Azure DevOps #1 lúc 11:44 (UTC+7), reason `batchedCI`. Lượt đầu thiếu `libatomic1` trên container agent khiến Node 26 không khởi động. Sau khi bổ sung thư viện và retry Build trong cùng run, Jenkins chạy test và publish hai image thành công, nhưng bước tạo manifest báo `INVALID_MANIFEST`. Kiểm trực tiếp xác nhận `az acr login` in `Login Succeeded` vào stdout. `Jenkinsfile` chuyển riêng log login sang stderr để stdout của bước lấy digest chỉ chứa digest. [Run #1](https://dev.azure.com/agridispatch-is402-bt05/AgriDispatchVN/_build/results?buildId=1)

**Restart booking một lần ngày 21/11/2026.** Mọi mốc dưới đây theo UTC+7. Lệnh chỉ nhắm Web App `app-booking-bt05a1`.

| Giờ | Kết quả |
| --- | --- |
| 02:03:57 | `/health` và `/ready` trả HTTP `200`, đúng SHA `62354bc6b794e00767796319f607aa42a6441749`. |
| Trước 02:04:01 | API tạo đơn `synthetic` trả `201`. API đọc lại đơn `db1d3279-a290-4813-801d-9138de98a664` trả `200`. |
| 02:04:01–02:04:03 | Gửi một lệnh `az webapp restart`. Azure Activity Log ghi `Microsoft.Web/sites/restart/action` là `Succeeded`; Azure CLI trả mã thoát `0`. |
| 02:05:04 | Log Kudu ghi `Site startup probe succeeded` sau khi Azure tạo container mới từ digest đã chốt. |
| 02:08:13–02:08:14 | Sau startup probe, kiểm từ máy ngoài Azure. `/health` và `/ready` trả HTTP `200`, đúng SHA. |
| 02:09:48 | Truy vấn `SELECT` từ Kudu tìm thấy đúng ID đơn `db1d3279-a290-4813-801d-9138de98a664`, nhãn `synthetic`, `ssl=true`, `TLSv1.3`. |

Lượt đọc API lúc 02:04:08 diễn ra trước khi Kudu ghi startup probe thành công. Lượt `SELECT` lúc 02:09:48 xác nhận đơn còn trong PostgreSQL sau restart. Còn lượt mở danh sách đơn bằng tài khoản demo bàn giao và xác nhận của Duyên.

**Push tự deploy còn chờ cấu hình CL-04 cho đích demo.** Kiểm nhánh `cloud/is402-2026-11-24` trên GitHub tại commit `50d652e043cade5d84b9b16e2c3bf56c4f80cfca`. Workflow GitHub Actions chạy CI và publish ACR, chưa có job deploy Web App. Commit hiện tại cố tình làm test thất bại để kiểm gate publish. ACR chưa có tag SHA này trong cả hai repository. [Commit kiểm gate](https://github.com/pckienuit/AgriDispatchVN/commit/50d652e043cade5d84b9b16e2c3bf56c4f80cfca) · [Workflow CI](../.github/workflows/ci.yml)

Pipeline Azure DevOps hiện tại dùng AKS, Function và slot `staging`. Nhánh `demo/cl05-b1` dùng phiên bản ứng dụng khớp 17 migration hiện có và có YAML riêng cho hai Web App B1. YAML chỉ nhận push CI từ nhánh demo. Jenkins test và publish SHA lên ACR. Deploy cập nhật account trước booking, kiểm digest và SHA của mỗi app, rồi phục hồi digest và SHA trước đó nếu lần kiểm không đạt. [YAML demo](../azure-pipelines.demo-b1.yml) · [Luồng deploy gốc](cloud-deploy.md)

Đăng ký luồng demo trong project CL-04 trước khi chạy push nghiệm thu.

1. Cấu hình job Jenkins `agridispatch/cloud-demo-b1` dùng `Jenkinsfile` từ nhánh `demo/cl05-b1`. Job cần quyền Git và phiên Azure được phép publish vào ACR `acris402agri`.
2. Trong Azure DevOps, tạo hoặc liên kết pipeline với repo GitHub và file `azure-pipelines.demo-b1.yml` trên nhánh demo. Dùng pool `agridispatch-jenkins-bridge`. Cho pipeline dùng variable group `agridispatch-cloud-ci` với cấu hình Jenkins hiện có, `DEMO_AZURE_SUBSCRIPTION_ID`, `BUDGET_APPROVAL_ID` và `QUOTA_CHECKED_AT` theo lần kiểm được duyệt. [Cấu hình CI của CL-04](pipelines.md)
3. Dùng Azure service connection `agridispatch-demo-b1`, cấp cho đúng pipeline. Danh tính deploy cần quyền đọc cấu hình, cập nhật container và app settings ở hai Web App, cùng quyền `Microsoft.Web/sites/publish/action` trên booking để kiểm account từ Kudu. Thiết lập Approvals và Exclusive lock trong environment `agridispatch-is402-demo-b1` theo CL-04. [Service connection](https://learn.microsoft.com/en-us/azure/devops/pipelines/library/service-endpoints) · [Approvals và checks](https://learn.microsoft.com/en-us/azure/devops/pipelines/process/approvals)
4. Push một commit vào nhánh demo. Lưu link run tự kích hoạt, SHA, digest đọc lại của hai app, kết quả HTTP sau deploy và xác nhận của Duyên.

Kiểm local trên Node `26.13.1` trong image test của repo. `npm run lint` đạt, `npm test` có 484 test đạt và 1 test bỏ qua. PyYAML nạp được cấu hình demo và các kiểm tra nhánh, trigger và đích deploy đều đạt. Lần chuẩn bị này chưa có run Azure DevOps được xác minh.

### 7. Tổng hợp phê duyệt và chốt issue

1. Gắn vào issue #51 phê duyệt CL-02 đã có và bản đọc lại credit, quota kèm ngày giờ. Phê duyệt cấu hình và ngân sách phải có trước thao tác tạo thêm tài nguyên. Nếu số liệu khác lần đọc đã duyệt, báo Kiên trước khi tiếp tục provision. [Mốc ngân sách CL-02](cloud.md)
2. Ghi phương án thực tế đã dùng cho booking và account, URL, schema, cách phục hồi dữ liệu demo và minh chứng ở từng bước. Chốt issue sau khi có log migration, seed, TLS, đọc ghi, push tự deploy và restart, cùng xác nhận của Duyên.
