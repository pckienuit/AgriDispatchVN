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
