# Runbook demo BT05 · CL-11

## Ai trực và kiểm khi nào

| Vai trò | Việc cần làm |
| --- | --- |
| Hơn, hạ tầng | Kiểm staging, Azure Monitor, quota và chi phí. Ghi giờ, trạng thái và request ID khi có lỗi. |
| Duyên, CI/demo | Người chạy thử được đề xuất. Chạy lại kiểm trước demo, đối chiếu log account/booking và minh chứng Function với CL-09. |
| Kiên, phụ trách nhóm | Duyệt chi phí, mốc giữ tài nguyên và quyết định dọn sau demo. |

Đích hiện tại là `Azure for Students`, nhóm `rg-is402-agri`, Japan East. Người chạy cần quyền đọc tài nguyên BT05, alert và Log Analytics workspace. Kiểm quota, credit và chi phí cần quyền đọc tương ứng trong subscription hoặc Azure Sponsorships. [Quyền Azure Monitor](https://learn.microsoft.com/azure/azure-monitor/fundamentals/roles-permissions-security)

## Kiểm trước demo

1. Dùng PowerShell chạy hai lượt GET dưới đây. Cả hai phải trả HTTP 200. Đối chiếu `X-Build-SHA` với bản bàn giao, ghi `X-Request-ID` nếu có lỗi.

   ```powershell
   $booking = 'https://app-booking-bt05a1-dhedg0a2c0aecnfh.japaneast-01.azurewebsites.net'
   curl.exe -fsS --max-time 10 -i "$booking/health"
   curl.exe -fsS --max-time 10 -i "$booking/ready"
   ```

2. Đăng nhập bằng tài khoản demo bàn giao và mở một đơn từ danh sách của chính tài khoản đó. API chỉ trả đơn do tài khoản sở hữu. Booking `/ready` kiểm DB của booking và gọi `/ready` của account. Từ máy có quyền `kubectl`, xem `kubectl --context aks-agri-bt05a1 -n agridispatch get deploy,pods,svc` khi cần kiểm riêng account. Nếu chưa có context, dùng `az aks get-credentials --subscription 'Azure for Students' -g rg-is402-agri -n aks-agri-bt05a1`, có thể thêm `--file` để dùng kubeconfig riêng. Đối chiếu số `READY` với số replica mong muốn của deployment `account`. Nếu máy không vào được Kubernetes API, Hơn có thể dùng **AKS → Run command** với câu lệnh đọc `kubectl -n agridispatch get deployment account`.
3. Function thumbnail là `func-thumbnail-bt05a1`. Diagnostic setting `diag-cl11-thumbnail` gửi `FunctionAppLogs` về `law-agri-bt05a1`. Dùng tài khoản thực sự là bên của tranh chấp synthetic còn mở, tải một ảnh mẫu mới và ghi giờ UTC cùng evidence ID. Lưu mã HTTP 201 của upload. Nếu lần đọc đầu trả `THUMBNAIL_PENDING`, chờ 15 giây rồi kiểm lại. Khi nhận JPEG, đối chiếu invocation ở cùng khung giờ và có `thumbnail_stored`, `created=true`. Log có thể vào workspace sau vài phút. [Minh chứng CL-09](cl-09-evidence.md)

## Tìm log trong Log Analytics

Mở **Log Analytics workspaces → `law-agri-bt05a1` → Logs**. Dùng cùng `X-Request-ID` thu từ một lượt đăng nhập demo hoặc request qua account gateway. Khoảng tìm mặc định 60 phút. Giữ thời gian UTC của log và ghi thêm giờ Việt Nam trong biên bản.

```kusto
let probe = "REQUEST_ID_TU_LUOT_KIEM";
AppServiceConsoleLogs
| where TimeGenerated > ago(1h)
| where _ResourceId endswith '/sites/app-booking-bt05a1'
| extend entry = parse_json(ResultDescription)
| where tostring(entry.requestId) == probe
| project TimeGenerated, RequestId = tostring(entry.requestId), Status = toint(entry.status), BuildSha = tostring(entry.buildSha)
```

```kusto
let probe = "REQUEST_ID_TU_LUOT_KIEM";
ContainerLogV2
| where TimeGenerated > ago(1h)
| where _ResourceId endswith '/managedClusters/aks-agri-bt05a1'
| where PodNamespace == 'agridispatch' and ContainerName == 'account'
| extend entry = parse_json(tostring(LogMessage))
| where tostring(entry.requestId) == probe
| project TimeGenerated, PodName, RequestId = tostring(entry.requestId), Status = toint(entry.status), BuildSha = tostring(entry.buildSha)
```

```kusto
FunctionAppLogs
| where TimeGenerated > ago(1h)
| where _ResourceId endswith '/sites/func-thumbnail-bt05a1'
| where FunctionName =~ 'thumbnail' or Category startswith 'Function.thumbnail'
| where Message startswith 'Executed' or Message has 'thumbnail_stored' or Message has 'thumbnail_rejected'
| project TimeGenerated, FunctionName, FunctionInvocationId, Level, Message
| order by TimeGenerated desc
```

Khi chưa thấy bảng hoặc lượt log, kiểm Diagnostic settings của resource, đích workspace và thời gian từ lúc bật thu log. Với AKS, kiểm add-on và pod `ama-logs`. Với Function, kiểm CL-09 đã kích hoạt invocation thực và mức log cho phép lưu kết quả. Chỉ trích dòng liên quan để nộp. [Log AKS](https://learn.microsoft.com/en-us/azure/azure-monitor/containers/container-insights-log-query) · [Log Functions](https://learn.microsoft.com/azure/azure-functions/monitor-functions)

## Xử lý cảnh báo

- Rule `cl11-booking-demo-401` dùng metric `Http401`, tổng trên 2 trong 5 phút, đánh giá mỗi phút, tự resolve. Lượt demo dùng vài GET chưa đăng nhập vào `/api/me`. Ghi trạng thái từ **Azure Monitor → Alerts**, giờ phát, giờ resolve nếu có, Alert ID và kết quả `/ready`.
- Khi thấy `Fired` ngoài khung demo, kiểm first/last seen, tài nguyên nguồn và biểu đồ `Http401`. Đối chiếu App Service logs và smoke `/health`, `/ready`. Nếu `/ready` lỗi, Hơn kiểm DB PostgreSQL và account AKS trước khi đổi cấu hình. Nếu chỉ Function lỗi, người trực CL-09 đối chiếu invocation, trạng thái host và quyền đối với Blob.
- Người trực xác nhận đã xem alert và ghi ai xử lý. Rule demo đang tắt sau lượt thử thành công. Bật lại trong khung demo tiếp theo đã duyệt, lưu trạng thái trước và sau lượt kiểm. [Theo dõi metric alerts](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/tutorial-metric-alert)

## Mốc chi phí và bàn giao sau demo

1. Hơn đọc lại **Cost Management → Cost analysis** cho cả `rg-is402-agri` và `MC_rg-is402-agri_aks-agri-bt05a1`. Ghi giờ đọc, khoảng dữ liệu, USD, credit từ **Azure Sponsorships** và quota DSv4/toàn vùng ở Japan East. Đối chiếu chi phí với số GB trong **Usage and estimated costs** của workspace.
2. Mốc đề xuất là trước demo, ngay sau demo và 01:08 ngày 25/11/2026 (UTC+7), tương ứng dự toán 48 giờ. Sau demo 48–72 giờ, đọc lại để bổ sung dữ liệu đến muộn. Nếu demo dời, ghi mốc mới và tính lại phí giữ tài nguyên trước khi gia hạn.
3. Trước khi dọn, kiểm nhu cầu CL-09, lưu minh chứng log/alert, xác định bản sao dữ liệu cần giữ và liệt kê từng resource. Tính cả App Service plan, đĩa và mạng AKS, PostgreSQL storage/backup, ACR, Blob và Monitor. Kiên duyệt riêng từng phạm vi dọn. Sau khi được duyệt, Hơn dùng chính công cụ đã quản lý tài nguyên, kiểm lại từng resource và chi phí còn phát sinh. [Độ trễ dữ liệu chi phí](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-cost-mgt-data)

Ghi lượt chạy lại vào [hồ sơ CL-11](cl-11-evidence.md) cùng ngày giờ, tên người chạy và điểm cần sửa. Trạng thái xác nhận của người chạy thứ hai được ghi trong hồ sơ.
