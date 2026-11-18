# Deployment helpers: AKS account và Web Apps booking

Mã điều phối triển khai, chưa phải dịch vụ Azure đã nghiệm thu. Tất cả CLI mặc định dry-run. Chỉ dùng `--execute` sau khi quota, dự toán đầy đủ, quyền target và danh tính đã được kiểm. Không dùng chuỗi `--budget-gate` như bằng chứng ngân sách tự động: đây là mã tham chiếu do người vận hành xác nhận, không tự đọc credit hoặc hạn mức.

## Hợp đồng

- Resource group cố định `rg-agridispatch-bt05`, không dùng nhóm Azure Bot.
- Account: namespace `agridispatch`, ServiceAccount `agridispatch-account`, internal LoadBalancer `10.42.2.10:3001`, subnet `snet-aks`.
- Migration: Job riêng, ServiceAccount `agridispatch-migrate`, **client ID khác runtime**. Runtime chỉ đọc `ACCOUNT-DATABASE-URL` và `INTERNAL-SERVICE-TOKEN`; Job đọc `MIGRATION-DATABASE-URL`.
- Booking: Web App và slot `staging`, cùng private account endpoint. DB runtime khác migrator, URL phải có `sslmode=verify-full`.
- Image phải là ACR reference có `@sha256:<64 hex>`. `--sha` nhận đúng SHA Git đầy đủ 40 ký tự, không tag hoặc SHA rút gọn.

## Thứ tự

1. Chuẩn bị Terraform, registry và identity theo runbook tương ứng. Chưa apply khi quota/ngân sách chưa xác minh.
2. Build/test/publish image; giữ digest, SHA và kết quả test thật trong manifest release.
3. Chạy bootstrap DB có xác nhận hostname/database để tạo runtime roles; cấp secret tương ứng bằng kênh riêng tư. Không truyền mật khẩu trực tiếp trên dòng lệnh.
4. Render bằng `node server/scripts/cloud/render-k8s.js` với `--image`, `--sha`, `--client-id`, `--tenant-id`, `--keyvault`; mode `migration` cần thêm `--migration-client-id` khác runtime.
5. `deploy-aks.js` nhận thêm `--subscription`, `--cluster-resource-id`, `--context`, kubeconfig scratch riêng. Chạy migration Job đến Complete rồi mới apply account Deployment và đợi rollout. Job Failed dừng triển khai; không in Secret hoặc log migration chứa credential.
6. `bluegreen-webapp.js` nhận app, image, SHA, staging/production probe URL. Chụp digest/SHA production trước; từ chối thay đổi khi thiếu snapshot rollback. Staging lỗi không động production. Sau thử swap, lỗi production phục hồi digest/SHA cũ và probe lại; không rollback DB.

## Kiểm đã chạy

Parent chạy renderer và helper tests: tách migration identity, từ chối tag/SHA sai, Job lỗi dừng deploy, readiness SHA/body/timeout/giới hạn 4096 byte, staging lỗi không restart production, snapshot thiếu chặn trước thay đổi.

Đã dùng Kind Kubernetes v1.37.0 kiểm `kubectl apply --dry-run=server --validate=strict` cho Namespace, ServiceAccount, Deployment, Service, PDB, NetworkPolicy và Job sau render. Không apply workload cloud, không kéo image synthetic. Loại SecretProviderClass khỏi lượt schema này vì Kind chưa cài CSI CRD; **CSI chưa được kiểm ở lượt đó**. Namespace thử đã xóa. System runtime riêng được mô tả trong `kubernetes-local.md`.

## Giới hạn chưa được gọi là PASS

- Azure CLI mới được đối chiếu syntax/help, chưa chạy slot swap, ACR pull digest, AKS Workload Identity/Key Vault CSI, private DNS/VNet hoặc identity storage thật.
- NetworkPolicy cho HTTPS egress rộng; cần đối chiếu đường đi internal LB/source IP và probe Azure trước khi nghiệm thu.
- Helper rollback phục hồi config production, có restart; không cam kết zero downtime.
- Bootstrap lần đầu chưa có production snapshot không dùng blue/green release helper; cần initial deployment được kiểm và ghi digest trước lần promote đầu tiên.
- Các test có CLI giả là test luồng điều phối, không phải bằng chứng Azure đã deploy.
