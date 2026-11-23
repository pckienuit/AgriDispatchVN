# CL-11 · Giám sát, chi phí và vận hành BT05

Môi trường `Azure for Students`, `rg-is402-agri`, Japan East. Kiên duyệt bật Log Analytics và một metric alert thử trên staging qua xác nhận của Hơn ngày 23/11/2026. Giờ trong hồ sơ dùng UTC+7 trừ khi ghi rõ UTC.

## Credit, chi phí và quota

| Mốc | Giá trị đọc được |
| --- | --- |
| Quota Japan East, 23/11 lúc 01:02 | DSv4 **4/4 vCPU** và toàn vùng **4/6 vCPU**. AKS Free có một node `Standard_D4s_v4`. |
| Cost Management ActualCost, 23/11 lúc 01:05:38 | Khoảng đo 20/11 00:00 đến 23/11 01:05:38. `rg-is402-agri` **1,383124 USD** trước thuế. Nhóm phụ AKS trả HTTP 200 và chưa có dòng chi phí trong khoảng đo. |
| Credit, xác nhận 23/11 khoảng 01:08 | **98,52 USD** theo số Hơn vừa đọc trên Azure Sponsorships. Trần 50% là **49,26 USD**. |
| Ngân sách RG kiểm trước khi bật | API trả danh sách rỗng ở `rg-is402-agri`. Rule kiểm cảnh báo HTTP nằm trong Azure Monitor. |

Chi phí Cost Management cho kỳ đang mở có thể thay đổi khi Azure nhận thêm dữ liệu. Ghi lại ngay sau demo và đọc bổ sung sau 48–72 giờ cho cả `rg-is402-agri` và `MC_rg-is402-agri_aks-agri-bt05a1`. [Cập nhật dữ liệu chi phí](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-cost-mgt-data)

### Dự toán cho 48 giờ vận hành

Đơn giá niêm yết USD đọc 23/11/2026 với Azure Retail Prices. Dùng 730 giờ/tháng để quy đổi giá lưu trữ. Tính trước thuế và ưu đãi, gồm phần dự phòng cho phí theo sử dụng. [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices)

| Hạng mục | Cách tính | USD |
| --- | --- | ---: |
| App Service plan Linux B1 | 0,019/giờ × 48 | 0,912 |
| AKS `Standard_D4s_v4` | 0,248/giờ × 48 | 11,904 |
| Đĩa Premium SSD 128 GiB của AKS | 22,67/tháng × 48/730 | 1,491 |
| PostgreSQL B1ms | 0,026/giờ × 48 | 1,248 |
| PostgreSQL storage 32 GiB | 0,138/GiB/tháng × 32 × 48/730 | 0,290 |
| ACR Basic Korea Central | 0,1666/ngày × 2 | 0,333 |
| Một IPv4 Standard AKS | 0,005/giờ × 48 | 0,240 |
| Log Analytics | 3,34/GB × 0,5 GB/ngày × 2 | 3,340 |
| Một metric alert | Dự trù mức niêm yết của một time series/tháng | 0,100 |
| Mạng, Blob/backup, Key Vault | Dự phòng cho Load Balancer, dung lượng, thao tác và lưu lượng staging | 3,000 |
| **Tổng gồm dự phòng 15%** | 22,858 × 1,15, làm tròn | **26,29** |

Dự toán áp dụng cho danh mục hiện có và phần Monitor duyệt trên. Sau duyệt CL-09, Function dùng lại plan B1 và thêm một kho host StorageV2 LRS. Dự trù thêm 1 USD trong 48 giờ, đưa tổng BT05 lên **27,29 USD**. Hơn vừa xác nhận credit **98,52 USD** trước deploy, khoảng 01:33 ngày 23/11. Giữ mốc kiểm lại đã ghi trong runbook để đối chiếu phí đến muộn. Daily cap workspace giúp kiểm soát lượng log, Azure có thể tiếp tục thu một phần trước khi cap có hiệu lực. [Azure Monitor daily cap](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/daily-cap)

## Smoke HTTP trước cấu hình

| API | Kết quả | Request ID |
| --- | --- | --- |
| `GET /health` | 200 `ok` | `cl11-preflight-90c844ec-fa0d-48cd-a2b2-ac2b9ab43d83` |
| `GET /ready` | 200 `ready` | `cl11-preflight-7c006e3f-fc51-4c0f-ad4e-d3bdd30d83f5` |
| `GET /api/me` chưa đăng nhập | 401 `UNAUTHORIZED` dự kiến | `cl11-preflight-0ead9503-487b-4043-8786-7d1142f22d2c` |

Ba response có build SHA `12154ad9000a77384c8dabecb024cf2809d02b67`. Số liệu trên là lượt gọi staging, log Azure Monitor được ghi sau khi xác minh ingest.

## Giám sát và bàn giao

### Log đã vào Log Analytics

Workspace `law-agri-bt05a1` ở Japan East báo `Succeeded`, giữ log 30 ngày và cap 0,5 GB/ngày. Booking đã bật `diag-cl11-booking` với `AppServiceConsoleLogs` và `AppServiceHTTPLogs`. AKS đã bật Container Insights qua managed identity với DCR `MSCI-japaneast-aks-agri-bt05a1`, stream `Microsoft-ContainerLogV2`.

| Service | Bảng | Thời điểm sự kiện (UTC+7) | HTTP | Build SHA |
| --- | --- | --- | --- | --- |
| Booking | `AppServiceConsoleLogs` | 23/11 01:14:12.205 | 200 | `12154ad9000a77384c8dabecb024cf2809d02b67` |
| Account | `ContainerLogV2` | 23/11 01:14:12.171 | 200 | `25dcb2cbcdfde78bd19803cab3eed15f57f27b5a` |
| Thumbnail Function | `FunctionAppLogs` | 23/11 01:53:52 | `thumbnail_stored`, `created=true` | `bcb982ec2ede30ca5f3d4cc610f29b4f565e0109` |

Hai dòng Booking và Account thuộc lượt đăng nhập synthetic có request ID `cl11-log-4139fbcc-9188-48c1-b130-f0513563fd10`. Lượt đọc danh sách đơn cùng khung giờ cũng trả 200. `AppServiceHTTPLogs` đã có dòng HTTP 200. Azure lưu log account sau vài phút và hai truy vấn đúng trong runbook đều trả một bản ghi với request ID này.

Function `func-thumbnail-bt05a1` đã gửi log qua `diag-cl11-thumbnail` về workspace `law-agri-bt05a1`. Ví dụ invocation `eb0c00c9-07be-4c61-849a-b7e7f22165e3` ghi `thumbnail_stored`, `created=true`. Truy vấn Function trong runbook chạy thật lúc 01:56:07, HTTP 200 và trả sáu invocation ID của đợt kiểm. [Minh chứng CL-09](cl-09-evidence.md)

### Cảnh báo Azure Monitor

Rule `cl11-booking-demo-401` giám sát riêng booking staging. Ngưỡng `Http401` tổng >2 trong 5 phút, đánh giá mỗi phút, severity 4 và tự resolve. Năm GET chưa đăng nhập trả 401 dự kiến, còn `/health` và `/ready` trả 200 sau lượt thử.

- **`Fired`** lúc **01:15:00 ngày 23/11/2026**, giá trị metric **5**, ID `688196f7-48d5-408a-858f-7c0b12a5f000`.
- **`Resolved`** lúc **01:21:56** theo cùng alert ID. Booking `/health` và `/ready` đều trả 200 với SHA ban đầu. Lúc 01:22:11, kiểm lại rule demo đã `enabled=false` sau lượt thử.

## Lượt chạy lại ngày 23/11/2026

Codex chạy lại theo yêu cầu của Hơn bằng tài khoản demo synthetic hiện có. Chưa có xác nhận chạy lại từ một thành viên khác của nhóm. [Runbook demo BT05](cl-11-runbook.md)

| Hạng mục | Kết quả |
| --- | --- |
| 10:11:22–10:11:23, Booking từ máy ngoài Azure | `/health` và `/ready` đều HTTP 200, cùng SHA `12154ad9000a77384c8dabecb024cf2809d02b67`. Request ID lần lượt `5482e2e5-34a2-4c90-936f-c64d9de27a36` và `e1994f56-0cbe-4113-bed3-8b9c0b2ba643`. |
| Khoảng 10:13, Kubernetes | Deployment `account` có `2/2` replica Ready, image digest `sha256:6f53656789b7b33f0730859fb0c594584737a8ad382cded51e75e2ed38c8ec2e`. |
| 10:13:59–10:14:23, Function thumbnail | Upload ảnh synthetic mới HTTP 201, đọc JPEG HTTP 200, gửi lại cùng ảnh không tạo thêm evidence, đọc khi chưa đăng nhập HTTP 401. [Kết quả chi tiết](cl-09-evidence.md) |
| 10:16:27, đăng nhập và mở đơn | Đăng nhập HTTP 200, danh sách HTTP 200 với 3 đơn. Mở đơn synthetic `8e01a0c6-0955-4f32-959a-cc0ddeae5baa` từ danh sách, HTTP 200. Request `cl11-rerun-owner-2008a078-6e89-4adc-9e59-7a693fe62c97-detail`. |
| Cảnh báo kiểm lại | Alert ID `688196f7-48d5-408a-858f-7c0b12a5f000` báo `Resolved`, giữ mốc phát 01:15:00 và hồi phục 01:21:56. Rule `cl11-booking-demo-401` vẫn tắt. |
| Cost Management, thời điểm kết thúc khoảng đo 10:12:14 | Khoảng đo từ 20/11 lúc 00:00. `rg-is402-agri` **1,706006 USD** trước thuế. Nhóm phụ AKS trả kết quả rỗng. Dự toán 48 giờ vẫn là **27,29 USD**. |
| Quota và lượng log | Japan East DSv4 **4/4 vCPU**, toàn vùng **4/6 vCPU**. Truy vấn `Usage` lúc 10:15:43 trả **10,763592 MB** billable trong 24 giờ gần nhất, workspace giữ 30 ngày với cap 0,5 GB/ngày. Số credit gần nhất do Hơn xác nhận là **98,52 USD**, chưa có số đọc Sponsorships mới trong lượt này. |

Ba truy vấn Azure Monitor đều trả HTTP 200. Booking `AppServiceConsoleLogs` và Account `ContainerLogV2` cùng ghi HTTP 200 với request ID `cl11-rerun-69ddbc8c-63d6-48cc-a52f-f0ced9464263-provider` lúc 10:13:54. SHA Account là `25dcb2cbcdfde78bd19803cab3eed15f57f27b5a`. `FunctionAppLogs` ghi `thumbnail_stored`, `created=true` lúc 10:14:07 với invocation `588de769-2fc3-4d72-93ba-e03aff8fc57f`. Cả ba kết quả đã đọc được lúc 10:17:57.

## Lượt đối chiếu do trợ lý chạy thay Kiên ngày 23/11/2026

Lượt kiểm chỉ đọc do trợ lý chạy thay Phan Chí Kiên, tách khỏi lượt của Hơn. Kiên chưa xác nhận tự chạy. Lượt này dùng endpoint công khai và đối chiếu các dòng log đã có. Giờ dưới đây là UTC+7.

| GET từ ngoài Azure | Giờ | HTTP | `X-Request-ID` |
| --- | --- | --- | --- |
| `/health` | 22:51:17 | 200 | `d084fc99-16b9-4004-90c5-a7826f1485d3` |
| `/ready` | 22:51:18 | 200 | `8d7da9d2-8f10-4868-8d99-40bd02de96d1` |
| `/api/services` | 22:51:18 | 200 | `16d1294c-93bc-4316-a80d-e0fef6764c7b` |
| `/api/me` chưa đăng nhập | 22:51:18 | 401 (dự kiến) | `c1db40ae-6fda-4903-9689-2ca0c887c0b8` |

Cả bốn phản hồi có `X-Build-SHA: 12154ad9000a77384c8dabecb024cf2809d02b67`.

`az monitor log-analytics query` trên `law-agri-bt05a1` lúc 22:52:20 đến 22:52:21: cả ba truy vấn runbook trả HTTP 200, 0 dòng trong cửa sổ 1 giờ theo bộ lọc đã dùng (Booking và Account lọc theo request ID `/ready`; Function không có upload mới). Đổi cửa sổ sang 10:10 đến 10:20 cùng ngày để kiểm minh chứng đã ghi; mỗi truy vấn trả HTTP 200 và 1 dòng:

| Bảng | Giờ sự kiện | Dữ liệu đối chiếu |
| --- | --- | --- |
| `AppServiceConsoleLogs` | 10:13:54.541 | HTTP 200, Booking `12154ad`, ID `cl11-rerun-69ddbc8c-63d6-48cc-a52f-f0ced9464263-provider` |
| `ContainerLogV2` | 10:13:54.537 | HTTP 200, Account `25dcb2c`, cùng request ID |
| `FunctionAppLogs` | 10:14:07 | Invocation `588de769-2fc3-4d72-93ba-e03aff8fc57f` |

- **Alert:** `cl11-booking-demo-401` là `enabled=false`. Azure Alerts Management history xác nhận `688196f7-48d5-408a-858f-7c0b12a5f000` phát lúc 01:15:00, chuyển `Resolved` lúc 01:21:56.
- **ActualCost:** truy vấn khoảng 20/11 00:00 đến 23/11 22:51:17. `rg-is402-agri` có **2,077631 USD** trước thuế; `MC_rg-is402-agri_aks-agri-bt05a1` không có dòng trong kết quả. Số liệu đến muộn có thể đổi; không suy ra nhóm phụ miễn phí hay số dư credit mới.
- **Quota và tài nguyên:** DSv4 **4/4 vCPU**, tổng Japan East **4/6 vCPU**. `az resource list` trả 24 mục trong `rg-is402-agri`, gồm hai Web App, Function, plan B1 theo hồ sơ staging, AKS, PostgreSQL, ACR, Key Vault, Log Analytics, lưu trữ và mạng, có cả VPN gateway/IP đã có. Workspace giữ 30 ngày, cap 0,5 GB/ngày.
- **Budget:** `az rest` PUT thành công và GET độc lập lúc 22:46:26 xác nhận `budget-rg-is402-agri` ở scope `rg-is402-agri`, API `2023-11-01`, `49 USD`, `Monthly`, `Cost`, 01/11/2026 đến 31/01/2027 (UTC). Cả ba thông báo Actual 50%, 80%, 100% bật, email nhận đã đối chiếu. Đây là cảnh báo, không phải cơ chế ngắt chi tiêu. Budget mới báo `currentSpend=0 USD`, không thay số ActualCost trên.

## Kiểm lại budget và trích log cho slide CL-15

Lúc **23:14:16 ngày 23/11/2026 (UTC+7)**, GET Azure trả HTTP 200 cho budget `budget-rg-is402-agri` ở cấp resource group, **49 USD/tháng**. Cả ba ngưỡng **Actual 50%, 80%, 100%** đang bật và mỗi ngưỡng có một đầu mối nhận. `currentSpend` của budget đã cập nhật lên **2,077631 USD**, khớp lần đọc ActualCost cùng giờ cho `rg-is402-agri` từ 20/11 00:00. Cost Management trả danh sách rỗng cho nhóm tài nguyên phụ của AKS trong cùng khoảng đo. Quota Japan East vẫn **4/4 vCPU DSv4**, **4/6 vCPU toàn vùng**. [Azure Cost Management Budgets](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/tutorial-acm-create-budgets)

Dự toán 48 giờ ban đầu là **27,29 USD**. Cộng khoảng **5,57 USD** cho VPN và Public IP CL-05 đến hết 24/11 và **0,0062 USD** compute tăng thêm cho lượt S1 CL-07, dự toán cập nhật khoảng **32,87 USD** nếu tài nguyên VPN được dọn đúng mốc. Chi phí thực ở trên là số Azure đã ghi nhận tại thời điểm đọc. [VPN và mốc giữ CL-05](cl-05-evidence.md#5-kiểm-https-tls-và-dữ-liệu-từ-staging) · [Lượt S1 CL-07](cl-07-evidence.md#ca-b-không-sẵn-sàng-ngày-23112026)

Truy vấn KQL lại lúc **23:14:48** cho khung sự kiện **10:10–10:20** cùng ngày trả HTTP 200 và ba bản ghi trong `law-agri-bt05a1`. Ảnh trích xuất giữ giờ sự kiện, request ID của Booking/Account và invocation ID của Function để dùng trên slide. [Tải ảnh kết quả KQL](cl-11-log-analytics.png)

**Trạng thái bàn giao.** Budget cấp resource group đã được xác nhận đang hoạt động. Còn chờ một thành viên nhóm tự chạy phần kiểm trước demo và xác nhận kết quả theo [runbook](cl-11-runbook.md#kiểm-trước-demo).
