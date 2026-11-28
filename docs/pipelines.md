# CI/CD: Jenkins và Azure DevOps

Định nghĩa pipeline cho `cloud/is402-2026-11-24`. Chưa chạy job trên Jenkins controller thật, chưa import/chạy Azure DevOps, chưa publish ACR hoặc deploy Azure. Kiểm local và HTTP stub không thay các minh chứng này.

## Công cụ và cổng an toàn

| Công cụ | Phần việc |
| --- | --- |
| Azure DevOps | Trigger nhánh, Validate, Terraform, gọi Jenkins, lưu artifact, protected environment trước Deploy |
| Jenkins | Checkout SHA đầu nhánh đã duyệt, lint/unit/integration, build app và Function, publish có opt-in |
| Terraform | `infra/terraform`, phiên bản 1.17.2, `fmt`, `validate`, 23 mock test; không tự `apply` |
| ACR | Image theo SHA, đối chiếu digest từ registry; không dùng `latest` |
| AKS | Account-service và migration Job riêng, identity tách quyền |
| Azure Web Apps | Booking-service, staging slot và blue/green |
| Azure Monitor | Diagnostic settings; ingestion thực vẫn cần kiểm trên Azure |
| Key Vault | Secret thật nằm ngoài source và artifact |
| GitHub Actions | CI bổ sung, không thay Jenkins/Azure DevOps |

`publish=false`, `cloudReady=false` mặc định. PR chỉ chạy Validate trên hosted agent, không secret group, không Jenkins, không self-hosted pool. Terraform/Build/Deploy còn kiểm `Build.SourceBranch` đúng nhánh được duyệt, kể cả run thủ công. Environment `agridispatch-is402-cloud` phải có approval check cấu hình ngoài YAML. YAML không tự tạo được sự bảo vệ này.

## Jenkins: `agridispatch/cloud`

Tạo Pipeline job từ Jenkinsfile tin cậy của nhánh đã duyệt. Không cho người gọi thay Jenkinsfile hoặc global environment. `skipDefaultCheckout(true)` ngăn checkout ngầm; stage riêng fetch nhánh cố định, từ chối `BUILD_SHA` không đúng đầu nhánh, checkout detached SHA đủ 40 ký tự.

Agent label `agridispatch-azure-build` cần Node 26, npm 11, Git, Docker/Compose v2.24+, OpenSSL, Python 3 + PyYAML. Module REST chỉ dùng Node stdlib; contract tests gọi `yaml.safe_load` bằng PyYAML thật, không dùng parser tự viết. Test stage của `infra/Dockerfile` có Python/PyYAML và copy root pipeline files; runtime stage không thêm Python.

Global environment do quản trị cấu hình:

- `AGRI_REPO_URL`: HTTPS repo private đã cấp quyền Git riêng cho agent; không nhúng token vào URL.
- `ACR_REGISTRY`: login server ACR.
- `AZURE_SUBSCRIPTION_ID`: UUID bắt buộc khi publish. Agent đăng nhập Azure riêng, không in secret.

Tham số job chỉ gồm `BUILD_SHA` và `PUBLISH`. Khi publish, kiểm subscription, `rg-agridispatch-bt05`, ACR resource ID và loginServer trước push; `az acr login` dùng `DOCKER_CONFIG` riêng. Digest từ push phải khớp `az acr repository show`.

Mỗi build dùng Compose project ngẫu nhiên, thư mục `CI_EPH` ngoài workspace (`mktemp -d`, quyền riêng tư), PostgreSQL synthetic không mở host port. Test container dùng `network_mode: service:test-db`. Dọn đúng project, image và thư mục tạm trong `post { always }`. Chỉ volume test dùng một lần mới được xóa; không chạm volume ứng dụng.

DB test bắt buộc `--auth-host=scram-sha-256 --auth-local=scram-sha-256`: cấu hình mặc định từng cho loopback dùng `trust`, làm test mật khẩu cũ sau rotation thất bại trên đường network namespace dùng chung. Không bỏ assertion; sửa xác thực của fixture. Shell Jenkins tắt tracing bằng `set +x` trước khi sinh credential local, tránh log giá trị ngẫu nhiên chưa được Jenkins masking.

## Azure DevOps và cấu hình bên ngoài

Validate cài PyYAML 6.0.3 trong venv tạm rồi chạy `node --test server/tests/jenkins-build.test.js`; không cần npm dependency cho client này. Terraform/Build/Deploy dùng pool `agridispatch-jenkins-bridge` có VPN tới Jenkins, Terraform 1.17.2 và Azure CLI/kubectl đúng phiên bản được kiểm trước triển khai. Hosted agent không tự truy cập được `localhost` của máy phát triển.

Variable group `agridispatch-cloud-ci` chỉ dùng ở Build/Deploy:

| Biến | Phạm vi |
| --- | --- |
| `JENKINS_URL` | HTTPS, không credentials/query/fragment |
| `JENKINS_USER`, `JENKINS_TOKEN` | Tài khoản chỉ được build/read job; token đánh dấu secret |
| `ACR_REGISTRY` | Registry đích phải khớp manifest |
| `BUDGET_APPROVAL_ID` | ID phê duyệt ngân sách thật, không tự tạo để vượt gate |
| `QUOTA_CHECKED_AT` | UTC timestamp đọc quota không quá 24 giờ |
| `TARGET_CONFIG_FILE` | JSON target ngoài checkout, không secret, có approval và kubeconfig riêng |

`JENKINS_JOB` mặc định `agridispatch/cloud`. Không dùng service connection ID giả. Agent triển khai phải có Azure login và quyền thực đã được kiểm.

Sau artifact Build, Deploy kiểm SHA, publish flag, hai repository cố định và digest; rồi gọi đúng contract:

```sh
node server/scripts/cloud/preflight.js --result "$RESULT_FILE" --sha "$BUILD_SHA" --budget-approval "$BUDGET_APPROVAL_ID" --quota-checked-at "$QUOTA_CHECKED_AT" --target "$TARGET_CONFIG_FILE"
node server/scripts/cloud/deploy.js --result "$RESULT_FILE" --sha "$BUILD_SHA" --target "$TARGET_CONFIG_FILE" --budget-approval "$BUDGET_APPROVAL_ID" --quota-checked-at "$QUOTA_CHECKED_AT" --execute
node server/scripts/cloud/verify.js --result "$RESULT_FILE" --sha "$BUILD_SHA" --target "$TARGET_CONFIG_FILE" --budget-approval "$BUDGET_APPROVAL_ID" --quota-checked-at "$QUOTA_CHECKED_AT"
```

Các helper đã có trong repo. Preflight kiểm input/attestation, không tự chứng minh credit/quota. Verify đọc revision triển khai nhưng vẫn trả `acceptanceComplete:false`; cần luồng nghiệp vụ, Blob invocation/output và rollback thật để nghiệm thu cloud.

## Client REST và kiểm local

Client giới hạn body stream 64 KiB, deadline xuyên cả body, không redirect, queue/build URL cùng origin và đúng job path, build number khớp. Crumb không được ghi đè Authorization/Host/Cookie hoặc chứa CRLF. Manifest phải khớp SHA/registry/repository/digest; lỗi CLI dùng mã cố định, không in token hay body thô. HTTP loopback chỉ dành fixture `JENKINS_ALLOW_LOOPBACK_HTTP=true`, không dùng cho pipeline thật. API token/crumb với controller thật còn cần kiểm.

```sh
python3 -c 'import yaml; yaml.safe_load(open("azure-pipelines.yml", encoding="utf-8"))'
node --test server/tests/jenkins-build.test.js
npm run lint
npm test
npm run test:integration
```

Integration chỉ dùng PostgreSQL local dùng một lần. Contract tests không phải Jenkins declarative linter hoặc Azure schema validator. Cần `/pipeline-model-converter/validate` trên controller có plugin tương ứng và run Azure DevOps thật trước khi tuyên bố pipeline hoạt động end-to-end.

Kiểm bản ghép local sau sửa: lint đạt; 482 unit và 237 integration đạt, không skip khi cấp Terraform CLI/cache. Docker test image trên Compose dùng network namespace của PostgreSQL: 481 unit đạt, 1 skip native Terraform, 237 integration đạt; cleanup exit 0 và không còn container thuộc project thử. YAML được parse bằng PyYAML; `sh -n` kiểm 9 block Jenkins và `bash -n` kiểm 4 block Azure. HTTP stub Jenkins tạo artifact đi qua chính `validateRelease` mà không đổi envelope. Đây chưa phải job Jenkins/controller hoặc run Azure DevOps thật. Lượt Compose đầu dùng nhầm `--no-build` không được hỗ trợ đã dừng và dọn sạch; lượt sau phát hiện lỗi `trust`, sửa SCRAM rồi chạy lại đạt.

## Chi phí và phần chưa nghiệm thu

Jenkins dự kiến chạy máy local/VPN, không tạo VM Azure cho Jenkins. Không suy ra Azure DevOps miễn phí hoặc có sẵn parallel-job capacity. ACR đã provision vẫn tính phí dù `publish=false`; DB/plan/node/storage tiếp tục tính phí ngoài thời gian request. Budget alert là thông báo, không phải hard cap.

Không publish/provision trước khi quota, toàn bộ dự toán và thời gian giữ tài nguyên phù hợp trần 50% Student credit được xác nhận. Chưa nghiệm thu Jenkins job thật, Azure DevOps import/agent/approval, ACR publication, AKS/Key Vault CSI/RBAC, Web Apps slot rollback, Monitor ingestion hoặc Function Azure invocation. Không tự xóa tài nguyên sau báo cáo.
