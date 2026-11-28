# Runbook dựng region 2 cho đo CL-12

Trạng thái: bản nháp, chưa chạy trên Azure. Chỉ chạy khi Hơn đã chốt region và Kiên đã duyệt chi phí bằng văn bản.

Mục tiêu là dựng một bộ nhỏ, độc lập ở region 2 để đo ca `read`: một App Service plan, hai Web App (`booking`, `account`) và một PostgreSQL 17. Region 1 (`app-booking-bt05a1`, Japan East) giữ nguyên.

## Khác biệt với region 1

Phải ghi các điểm này vào `docs/benchmark-cl12.md` khi báo kết quả.

| | Region 1 (Japan East) | Region 2 |
| --- | --- | --- |
| Account service | AKS, internal LB | Web App, public HTTPS, bảo vệ bằng `INTERNAL_SERVICE_TOKEN` |
| PostgreSQL | Private VNet | Public endpoint có firewall |
| Image | Digest đang chạy | Cùng digest |
| App Service plan | SKU hiện tại | Cùng SKU |

## 0. Biến và kiểm tra

Chạy toàn bộ trong cùng một cửa sổ PowerShell, tại thư mục gốc repo, đã `az login`.

```powershell
$loc = 'koreacentral'            # region đã chốt
$rg = 'rg-is402-agri-r2'         # tên RG đã chốt
$sfx = 'r2' + (Get-Random -Minimum 1000 -Maximum 9999)
$pg = "pg-agri-$sfx"; $plan = "plan-agri-$sfx"; $bookingApp = "app-booking-$sfx"; $accountApp = "app-account-$sfx"
$acr = 'acris402agri'
$image = (az webapp show -g rg-is402-agri -n app-booking-bt05a1 --query siteConfig.linuxFxVersion -o tsv) -replace '^DOCKER\|', ''
$sku = az appservice plan show --ids (az webapp show -g rg-is402-agri -n app-booking-bt05a1 --query serverFarmId -o tsv) --query sku.name -o tsv
"image=$image"; "sku=$sku"
```

`image` phải có dạng `acris402agri.azurecr.io/...@sha256:...`. Dừng lại nếu trống.

## 1. Resource group và PostgreSQL

```powershell
az group create -n $rg -l $loc
$pgPass = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$myIp = Read-Host 'IP public của máy chạy migration'
az postgres flexible-server create -g $rg -n $pg -l $loc --tier Burstable --sku-name Standard_B1ms --storage-size 32 --version 17 --admin-user agrimigrator --admin-password $pgPass --public-access $myIp --yes
az postgres flexible-server firewall-rule create -g $rg -n $pg --rule-name allow-azure-services --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0
az postgres flexible-server db create -g $rg -s $pg -d agridispatch
```

Quy tắc `allow-azure-services` cho mọi dịch vụ Azure kết nối tới DB. Chỉ dùng cho lượt đo này rồi xóa cùng RG.

## 2. Migrate, tạo role DB và nạp dữ liệu

Theo [database-deploy.md](database-deploy.md).

```powershell
$pgHost = "$pg.postgres.database.azure.com"
$env:DATABASE_URL = "postgresql://agrimigrator:$pgPass@$pgHost/agridispatch?sslmode=verify-full"
npm run db:migrate
$accountDbPass = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$bookingDbPass = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
$env:NEW_ACCOUNT_DB_PASSWORD = $accountDbPass; $env:NEW_BOOKING_DB_PASSWORD = $bookingDbPass
node server/scripts/bootstrap-db.js --apply --confirm-host $pgHost --confirm-database agridispatch
Remove-Item Env:DATABASE_URL, Env:NEW_ACCOUNT_DB_PASSWORD, Env:NEW_BOOKING_DB_PASSWORD
```

Danh mục dịch vụ và tin tuyển phải nạp giống region 1. `seed-catalog.js` chỉ chạy trên DB loopback, nên dùng đúng cách Hơn đã nạp cho region 1. Nếu dữ liệu khác nhau, ghi rõ trong báo cáo.

## 3. App Service plan và hai Web App

```powershell
az appservice plan create -g $rg -n $plan -l $loc --is-linux --sku $sku
az webapp create -g $rg -p $plan -n $accountApp --container-image-name $image
az webapp create -g $rg -p $plan -n $bookingApp --container-image-name $image
$acrId = az acr show -n $acr --query id -o tsv
foreach ($app in @($accountApp, $bookingApp)) {
  $principal = az webapp identity assign -g $rg -n $app --query principalId -o tsv
  az role assignment create --assignee-object-id $principal --assignee-principal-type ServicePrincipal --role AcrPull --scope $acrId
  az webapp update -g $rg -n $app --set siteConfig.acrUseManagedIdentityCreds=true
}
```

Tạo role assignment cần quyền Owner hoặc User Access Administrator trên ACR.

## 4. Cấu hình app

```powershell
$token = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
$sha = (curl.exe -fsS -i --max-time 10 https://app-booking-bt05a1-dhedg0a2c0aecnfh.japaneast-01.azurewebsites.net/health | Select-String -Pattern '^x-build-sha:\s*(\S+)').Matches.Groups[1].Value
$accountHost = az webapp show -g $rg -n $accountApp --query defaultHostName -o tsv
az webapp config appsettings set -g $rg -n $accountApp --settings "DATABASE_URL=postgresql://account_runtime:$accountDbPass@$pgHost/agridispatch?sslmode=verify-full" "INTERNAL_SERVICE_TOKEN=$token" PORT=3001 WEBSITES_PORT=3001 TRUST_PROXY_HOPS=1 "BUILD_SHA=$sha" -o none
az webapp config set -g $rg -n $accountApp --startup-file "node server/src/account-server.js" -o none
az webapp config appsettings set -g $rg -n $bookingApp --settings "DATABASE_URL=postgresql://booking_runtime:$bookingDbPass@$pgHost/agridispatch?sslmode=verify-full" "ACCOUNT_SERVICE_URL=https://$accountHost" "INTERNAL_SERVICE_TOKEN=$token" PORT=3000 WEBSITES_PORT=3000 TRUST_PROXY_HOPS=1 "BUILD_SHA=$sha" -o none
az webapp restart -g $rg -n $accountApp; az webapp restart -g $rg -n $bookingApp
```

`-o none` để mật khẩu không in ra màn hình. Không chép mật khẩu, token vào chat, issue hay file trong repo.

## 5. Kiểm tra

```powershell
$bookingHost = az webapp show -g $rg -n $bookingApp --query defaultHostName -o tsv
curl.exe -fsS --max-time 30 -i "https://$bookingHost/health"
curl.exe -fsS --max-time 30 -i "https://$bookingHost/ready"
```

Cả hai trả 200 và `X-Build-SHA` giống region 1. Lần gọi đầu có thể chậm vì container đang khởi động.

## 6. Đo

Dùng lệnh cloud trong [benchmark-cl12-run.md](benchmark-cl12-run.md), thay `$booking = "https://$bookingHost"`, `--allowed-host $bookingHost` và `--label cloud-<region>`.

## 7. Dọn (cần duyệt riêng)

Lưu `summary.md`, ảnh Metrics và log trước. Sau khi Kiên duyệt:

```powershell
foreach ($app in @($accountApp, $bookingApp)) {
  $principal = az webapp identity show -g $rg -n $app --query principalId -o tsv
  az role assignment delete --assignee $principal --role AcrPull --scope $acrId
}
az group delete -n $rg --yes
```

Kiểm tra lại Cost Management sau 24 đến 48 giờ để chắc không còn phí phát sinh.
