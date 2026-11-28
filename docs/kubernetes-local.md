# Kiểm runtime Kubernetes local

Phép kiểm dành riêng cho context `kind-agridispatch-ready`, API server HTTPS loopback. Script từ chối context AKS/production. Không tạo tài nguyên Azure.

## Điều kiện

- Docker, Kind, kubectl, Node 26 đã cài; phiên bản thực ghi cùng log chạy.
- Cluster local tên `agridispatch-ready`; dùng kubeconfig riêng ngoài repo, không đổi context mặc định.
- Image app xây từ commit sạch, gắn `BUILD_SHA` đầy đủ; image này và `postgres:17-alpine` đã nạp vào node Kind.
- Output JSON nằm ngoài repo, file chưa tồn tại. Không dùng kubeconfig hoặc mật khẩu cloud trong phép kiểm.

```bash
kind create cluster --name agridispatch-ready --kubeconfig "$TMPDIR/kind-ready.kubeconfig"
docker build -f infra/Dockerfile --build-arg BUILD_SHA="$(git rev-parse HEAD)" -t agridispatch-vn:kind-check .
kind load docker-image --name agridispatch-ready agridispatch-vn:kind-check postgres:17-alpine
node server/scripts/test-kubernetes.js \
  --kubeconfig "$TMPDIR/kind-ready.kubeconfig" \
  --image agridispatch-vn:kind-check \
  --sha "$(git rev-parse HEAD)" \
  --output "$TMPDIR/kubernetes-result.json"
```

Script tạo namespace ngẫu nhiên, DB và secret synthetic riêng, đợi PostgreSQL readiness, chạy migration Job riêng rồi mới khởi động account/booking. Kiểm container non-root/read-only, đăng ký/đăng nhập qua gateway, lưu thửa ruộng, rolling restart account và đọc lại dữ liệu bằng phiên cũ. Xóa đúng namespace thử trong `finally`; không xóa cluster hoặc tài nguyên khác. Không có PVC trong fixture: đây là kiểm restart process, không phải kiểm mất node/DB hoặc độ bền Azure Disk.

Nếu Kind import image lỗi thiếu content digest với Docker image store nhiều platform, nạp đúng image local bằng `docker save <image> | docker exec --privileged -i agridispatch-ready-control-plane ctr --namespace=k8s.io images import --snapshotter=overlayfs -`. Không dùng `--all-platforms` khi content store chỉ có platform máy hiện tại.

## Phạm vi minh chứng

Đã chạy image nguồn `ab4c47b986f37a65b4fb0720e19a1bd1b3143287` trên Kind/Kubernetes `v1.37.0`: migration Job, HTTP hai service, thửa ruộng/phiên sau rolling restart account đạt. Fixture Python đầu tiên thiếu DB readiness nên migration trả `ECONNREFUSED`; sau bổ sung readiness đã đạt. Script Node trong repo phải được chạy độc lập trước khi ghi kết quả của chính script đó.

Không chứng minh AKS, Azure workload identity, Key Vault CSI, RBAC, internal load balancer, NetworkPolicy, VNet, private DNS, PostgreSQL TLS cloud, slot swap hoặc rollback Azure. Manifest fixture local khác manifest cloud; không dùng kết quả này để đánh dấu các dịch vụ Azure đã triển khai.

Script Node đã chạy đạt độc lập. Sau rolling restart một replica account, từng gặp HTTP 503 trong thời gian endpoint/socket cập nhật. Script chỉ thử lại GET có giới hạn, không thử lại write, và ghi `restartReadRetries`; kết quả không chứng minh không gián đoạn. Hai service chỉ báo pod readiness chưa đủ chứng minh đường truyền giữa service, nên kiểm thêm HTTP account từ pod booking trước đăng ký.

Lần kiểm sau auth/Terraform dùng runtime nguồn `391b36fa246f75a74333d70fec265565b28b7b82`, image `agridispatch-vn:kind-391b36f`. Delta chưa commit chỉ ở runner kiểm thử: bật `REQUIRE_SIGNED_CLIENT_IDENTITY=true` cho account và kiểm HTTP trực tiếp không chữ ký trả đúng `400 INVALID_CLIENT_IDENTITY`. Đăng ký/đăng nhập qua gateway có chữ ký, lưu thửa ruộng và dùng lại phiên sau rolling restart đều đạt. Có một GET trả `503` rồi lần thử lại thành công (`restartReadRetries=1`), không có write retry. Namespace thử được xóa; không chứng minh Azure hoặc khả dụng liên tục. Image revision là khai báo, không thay cho provenance digest trên ACR.
