# Kiểm thử hệ thống

Tài liệu này mô tả ma trận kiểm thử, cách chạy trình điều phối system test local (`server/scripts/test-system.js`), bảng ánh xạ tính năng sang file kiểm thử (`server/tests/system/feature-inventory.js`), kết quả kiểm tra cụm Kind và giới hạn phạm vi hiện tại.

## Ma trận kiểm thử

| Tầng kiểm thử | Điểm vào / Nguồn | Môi trường thực thi | Những gì được kiểm tra | Ngoại trừ / Giới hạn |
| --- | --- | --- | --- | --- |
| Unit & hợp đồng HTTP | `npm test` (`server/tests/*.test.js`, `functions/thumbnail/*.test.cjs`, gồm `server/tests/system-runner.test.js`) | Node 26 `node:test`, không cần DB/trình duyệt sống | Logic nghiệp vụ, route/view helper, cấu hình, bộ điều phối `test-system.js` qua test double | `export-release.test.js` cần `git` và `tar`; không kiểm chứng hành vi PostgreSQL/Chromium thật |
| Integration DB & API | `npm run test:integration` (`server/tests/integration/*.test.js`) | PostgreSQL 17 thật qua `TEST_DATABASE_URL` (DB `*_test` trên loopback, quyền `CREATEDB`) | Migration thật, ràng buộc SQL, giao dịch, dữ liệu lỗi biên, phân quyền và xung đột đồng thời | Chạy theo file test độc lập; không chạy Chromium |
| System Browser (local) | `node server/scripts/test-system.js` (`server/tests/helpers/operations-browser-server.mjs` + `server/tests/browser-smoke.mjs`) | PostgreSQL 17 thật (tạo/xóa DB `agridispatch_acct_*_test`), 2 service loopback (`127.0.0.1:33100`, `33101`), Chromium/Thorium thật | Luồng đầy đủ theo vai trò qua 4 mode: `default`, `operations`, `dispatch`, `recruitment` (gồm admin duyệt vai trò và dời lịch), desktop/mobile, console/pageerror, cleanup DB/cổng/tiến trình | `localOnly: true`, `cloudCalls: false`; kho ảnh bằng chứng là bản giả lập trong bộ nhớ của fixture; dữ liệu mẫu gắn nhãn `mô phỏng`; không đại diện tải lớn |
| Cụm Kubernetes local (Kind) | Đã chạy probe: `scratch/cloud-start/kind-runtime-probe.py` (kết quả `kind-runtime-result.json`, SHA `ab4c47b`); runner Node bền vững kế hoạch: `server/scripts/test-kubernetes.js` (do parent sở hữu) | Cụm Kind local với 2 pod (`booking`, `account`), PostgreSQL, `Job` migration tách riêng | Non-root read-only runtime, HTTP register/login/tạo thửa ruộng liên service, rolling restart `account-service` vẫn giữ phiên và dữ liệu | Không kiểm cloud CSI, RBAC, VNet (`cloudIdentityRbacVnetVerified: false`), không chạy trình duyệt |
| Hạ tầng cloud thật | Chưa chạy trong bộ local | Azure Blob Storage, Azure Function host runtime, Managed Identity, RBAC, CSI, VNet | Chưa có bài kiểm chứng tự động local | Cần chạy trên môi trường đích có kiểm soát riêng |

Không có tầng kiểm thử nào ở trên chứng minh 100% hệ thống production hay năng lực chịu tải.

## Chạy trình điều phối System Test (`server/scripts/test-system.js`)

### Điều kiện tiên quyết

- Node.js 26 LTS (`node -v`).
- PostgreSQL 17 đang chạy trên loopback (`127.0.0.1`) với user test có quyền `CREATEDB`.
- Biến môi trường `TEST_DATABASE_URL` trỏ tới DB loopback có tên kết thúc bằng `_test` và không chứa query parameter (bị `parseDisposableRoot` từ chối nếu sai). Không in hoặc ghi chuỗi kết nối ra log/JSON.
- Trình duyệt Chromium/Thorium hoạt động (`CHROMIUM_BIN`, mặc định `chromium`).
- Hai cổng `127.0.0.1:33100` và `127.0.0.1:33101` đang trống. Nếu cổng đang bận, preflight dừng ngay và không tắt tiến trình của ứng dụng khác.
- `TMPDIR` nằm ngoài thư mục repo và dài tối đa 60 ký tự (`CHROMIUM_TMPDIR_MAX=60`). Đường dẫn dài hơn làm Chromium không mở được `DevToolsActivePort`; preflight từ chối trước khi spawn tiến trình con.

### Lệnh chạy và tùy chọn

Đặt `BROWSER_TMPDIR` thành đường dẫn ngắn trỏ vào scratch của profile, `SYSTEM_RESULTS_DIR` thành thư mục minh chứng riêng ngoài Git; không dùng `/tmp`. Trên máy hiện tại alias `/home/pckien/.ad-system` trỏ vào scratch, không chứa dữ liệu của profile khác. Mật khẩu ví dụ dưới đây chỉ là ký hiệu, không phải credential chạy thật.

```bash
TMPDIR="$BROWSER_TMPDIR" \
CHROMIUM_BIN=/home/pckien/.local/bin/chromium \
TEST_DATABASE_URL='postgresql://<test-user>:<test-password>@127.0.0.1:55432/agridispatch_test' \
node server/scripts/test-system.js --out "$SYSTEM_RESULTS_DIR"
```

Tùy chọn CLI:

- `--modes <danh-sach>`: tập con các mode cách nhau bằng dấu phẩy trong `default,operations,dispatch,recruitment` (mặc định chạy tuần tự cả 4 mode).
- `--out <thu-muc>`: thư mục ghi `system-results.json` và `shots/<runId>/<mode>/*.png`. Bắt buộc nằm ngoài cây repo; thư mục tạo với quyền `0700` và file kết quả/ảnh quyền `0600`.

### Hợp đồng vòng đời và cô lập

1. Preflight kiểm tra độ dài `TMPDIR`, gọi `<CHROMIUM_BIN> --version`, kiểm tra trống cổng `33100`/`33101`, đọc SHA đầy đủ và trạng thái Git gồm file untracked. Trường `trackedClean` được giữ tương thích nhưng kiểm cả file untracked; không gọi worktree có runner chưa commit là sạch.
2. Với từng mode tuần tự:
   - Ghi nhận tập DB `agridispatch_acct_*_test` hiện có trước case.
   - Tạo file `SYNTHETIC_LOGIN_FILE` riêng tư (`0600`) trong thư mục tạm của case.
   - Spawn `server/tests/helpers/operations-browser-server.mjs` (kèm `--dispatch` cho mode `dispatch`), chờ marker `OPERATIONS_SMOKE_READY` trên stdout.
   - Nếu `$TMPDIR/cloud-start/ui-evidence` đã tồn tại từ trước, tạm dời sang thư mục set-aside và khôi phục lại trong `finally`.
   - Spawn `server/tests/browser-smoke.mjs http://127.0.0.1:33100` với cờ mode tương ứng (`--operations`, `--dispatch`, `--recruitment`, hoặc mặc định), chờ exit và kiểm tra pass marker (`BROWSER_SMOKE_PASS`, `OPERATIONS_BROWSER_PASS`, `RECRUITMENT_BROWSER_PASS`).
   - Sao chép ảnh PNG chụp được vào `<out>/shots/<runId>/<mode>/` kèm SHA-256 và kích thước byte.
   - Dừng cả process group của trình duyệt và fixture bằng `SIGTERM` (fallback `SIGKILL` sau grace window nếu không thoát), kiểm tra fixture đã xóa DB dùng một lần, cổng `33100`/`33101` đã trống, `SYNTHETIC_LOGIN_FILE` đã xóa. Nếu xuất hiện DB chưa rõ chủ sở hữu, runner đánh dấu `fail` và không tự xóa: test khác có thể đang chạy song song.
3. Các giá trị mật khẩu trong `logTail` bị che thành `[REDACTED]`. Kết quả ghi vào `<out>/system-results.json` kèm metadata `scope` (`localOnly: true`, `cloudCalls: false`, `fullSystemClaim: false`).

## Bảng ánh xạ tính năng sang kiểm thử

Nguồn sự thật có kiểm tra tự động nằm tại [server/tests/system/feature-inventory.js](../server/tests/system/feature-inventory.js) (được `server/tests/system-runner.test.js` kiểm tra đường dẫn tồn tại trên đĩa, route khớp `server/src` và tầng rỗng phải có lý do rõ ràng).

| ID | Tính năng | Unit | Integration | Browser mode & luồng | Khoảng trống đã ghi nhận |
| --- | --- | --- | --- | --- | --- |
| `auth-session` | Đăng ký, đăng nhập, phiên, gateway tài khoản | `account.test.js`, `account-gateway.test.js`, `service-auth.test.js`, `web-accounts.test.js` | `integration/account.test.js` | `default`: đăng ký, đăng nhập, đăng xuất farmer; `operations`: đăng nhập từng vai trò qua form | Không |
| `role-requests` | Yêu cầu vai trò và duyệt quản trị | `web-accounts.test.js`, `account-gateway.test.js` | `integration/role-requests.test.js` | `operations`: farmer xin quyền chủ máy -> chờ duyệt -> admin duyệt; xin HTX -> admin từ chối kèm lý do -> vai trò bị ẩn | Không |
| `catalog-services` | Danh mục dịch vụ, thửa ruộng, máy | `catalog.test.js`, `web.test.js` | `integration/catalog.test.js` | `default`: catalog 3 thẻ, validate form tạo thửa ruộng rỗng, trang chi tiết; `dispatch`: chủ máy tạo máy | Không |
| `booking-request` | Đặt dịch vụ, lịch sử đặt, idempotency | `booking.test.js`, `web.test.js` | `integration/booking.test.js`, `integration/benchmark-bookings.test.js` | `default`: đặt dịch vụ 1.440.000 VND, lịch sử đặt, kiểm tra overflow mobile; `dispatch`: ủy quyền điều phối HTX | Không |
| `dispatch-package` | Gom gói, phân công, hủy gói, đọc điều phối | `dispatch.test.js`, `web-dispatch.test.js` | `integration/dispatch.test.js`, `integration/dispatch-reads.test.js`, `integration/scheduling.test.js` | `dispatch`: HTX gom đơn tạo gói, hủy gói chưa chạy kèm lý do, chủ máy nhận gói với máy + thợ, layout mobile | Không |
| `postponement` | Dời lịch: đề xuất, đồng ý theo phiên bản, áp dụng | `web-postponement.test.js` | `integration/postponement.test.js` | `dispatch`: chủ máy đề xuất khung giờ; HTX ngoài cuộc thấy `0/2` không có nút đồng ý; farmer đồng ý v1 trên mobile; chủ máy đồng ý -> áp dụng | Không |
| `recruitment` | Tin tuyển, ứng tuyển, đề nghị, nhận việc | `recruitment.test.js`, `web-recruitment.test.js` | `integration/recruitment.test.js`, `integration/recruitment-live.test.js` | `recruitment`: chủ máy đăng tin, thợ ứng tuyển, chủ máy gửi đề nghị, thợ nhận trên mobile, chủ máy đóng tin | Không |
| `shifts-operations` | Ca làm việc: bắt đầu, tạm dừng, tiếp tục, hoàn thành, diện tích | `shifts.test.js`, `web-operations.test.js` | `integration/shifts.test.js` | `operations`: thợ chạy/tạm dừng/tiếp tục/hoàn thành ca, chặn diện tích > 12.000 m², chủ máy chỉ xem, mobile layout | Không |
| `readiness` | Xác nhận sẵn sàng khi đặt dịch vụ | Trống (ghi nhận gap) | `integration/shifts.test.js`, `integration/acceptance.test.js` | `default`: xác nhận sẵn sàng nước/cây/vận chuyển; khóa sau hoàn thành | Không có file unit riêng; phủ gián tiếp qua integration shifts/acceptance |
| `acceptance-settlement` | Nghiệm thu, đồng ý theo phiên bản, báo thanh toán, xác nhận nhận | `acceptance.test.js`, `web-settlement.test.js` | `integration/acceptance.test.js` | `operations`: đề xuất v1, lỗi stale-version, reload đồng ý v2, báo thanh toán bị rớt phản hồi -> uncertain -> retry không tạo trùng, xác nhận đã nhận | Không |
| `disputes-remedies` | Khiếu nại, phản hồi, hòa giải, đề xuất, đóng chưa giải quyết | `disputes.test.js`, `web-disputes.test.js` | `integration/disputes.test.js`, `integration/remedies.test.js` | `operations`: mở khiếu nại, phản hồi, admin chỉ định hòa giải viên đề xuất v1, hai bên đồng ý; vụ thứ hai đóng chưa giải quyết giữ nguyên đóng băng | Không |
| `evidence-private` | Ảnh bằng chứng riêng tư, thu nhỏ, đối soát object | `web-evidence.test.js`, `web-binary.test.js`, `blob-store.test.js`, `evidence-image.test.js` | `integration/evidence-reconcile.test.js` | `operations`: tải ảnh PNG tổng hợp trong tranh chấp, trạng thái chờ thumbnail, nút tải ảnh gốc | Không chạy Azure Function trigger tạo thumbnail; fixture dùng store giả lập trong bộ nhớ |
| `activity-feed` | Lịch sử hoạt động theo quyền | `web-activity.test.js` | `integration/activity.test.js` | `operations`: feed của chủ máy hiển thị liên kết tranh chấp đóng chưa giải quyết, phân trang, kiểm tra mobile | Không |
| `observability-health` | Health/ready, request tracing, observability | `app.test.js`, `observability.test.js`, `lifecycle.test.js` | `integration/db.test.js`, `integration/request-tracing.test.js` | Trống | Hợp đồng HTTP, không có giao diện trình duyệt |
| `database-migration` | Migration thật, seed, khóa DB | `migration.test.js`, `config.test.js` | `integration/db.test.js` | Trống | Lớp schema/migration, không có UI |
| `synthetic-data` | Sinh dữ liệu tổng hợp, benchmark nạp | `generate-data.test.js` | `integration/generate-data.test.js` | Trống | Công cụ CLI, không thuộc luồng vai trò trình duyệt |
| `release-export` | Xuất gói nguồn release có manifest | `export-release.test.js` | Trống | Trống | CLI chạy trên git tree; đã kiểm unit với `git`/`tar` thật |
| `function-thumbnail` | Azure Function xử lý thumbnail | `function-config.test.js` (+ `functions/thumbnail/*.test.cjs` trong `npm test`) | Trống | Trống | Chưa chạy Blob trigger host runtime |
| `benchmark-http` | Đo HTTP và benchmark đặt lịch | `benchmark-http.test.js` | `integration/benchmark-bookings.test.js` | Trống | Đo lường benchmark, không có khẳng định capacity |

## Ghi nhận kiểm tra trực quan (lần chạy `65cb9897dc5a`)

Parent chạy độc lập lần `1fcd38ffd0c5`: cả bốn mode đạt, 86 ảnh, không DB rò rỉ, cổng rảnh và tiến trình con đã thoát. Nguồn ứng dụng là `e02762c`, runner khi đó chưa commit nên không coi metadata `trackedClean: true` cũ là xác nhận toàn worktree sạch; bản runner hiện đã sửa cách ghi provenance. Kết quả thuộc môi trường local và kho bằng chứng mô phỏng, không phải Azure.

Lần chạy đầy đủ 4 mode (`default`, `operations`, `dispatch`, `recruitment`) thu được tổng cộng 86 ảnh PNG (`10` default, `30` operations, `40` dispatch, `6` recruitment), mọi mode đạt pass marker và dọn sạch 0 DB rò rỉ.

- Phạm vi kiểm tra mắt thường / thị giác: 8 khung hình trọng yếu được kiểm tra trực tiếp (`default/desktop-booking.png`, `default/mobile-login.png`, `dispatch/dispatch-desktop-coop-grouped.png`, `dispatch/postpone-mobile-owner-consented.png`, `operations/admin-desktop-approved.png`, `recruitment/recruitment-mobile-offer.png`, `dispatch/settlement-desktop-proposal.png`, `dispatch/dispute-desktop-resolved.png`). 78 khung hình còn lại được kiểm chứng tồn tại, kích thước byte và SHA-256 trong `system-results.json`, chưa duyệt từng ảnh bằng thị giác.
- Các lỗi giao diện thực tế ghi nhận được trong 8 ảnh đã soi (nằm ngoài phạm vi sửa UI của bộ điều phối):
  1. **Nghi vấn mép phải ảnh mobile** (`mobile-login.png`, `postpone-mobile-owner-consented.png`, `recruitment-mobile-offer.png`): cần đo bounding box và `clientWidth` trên DOM trước khi kết luận overflow. Nhận xét hình ảnh không tự chứng minh lỗi CSS.
  2. **Lặp dòng trạng thái / đăng nhập** (`admin-desktop-approved.png`, `postpone-mobile-owner-consented.png`, `recruitment-mobile-offer.png`, `settlement-desktop-proposal.png`): cùng thông báo xuất hiện cả dạng chữ thường phía trên tiêu đề lẫn trong hộp cảnh báo/header.
  3. **Nút liền kề không có khoảng cách** (`desktop-booking.png`, `admin-desktop-approved.png`, `dispute-desktop-resolved.png`): cặp nút hành động hoặc `Trang trước`/`Trang sau` chạm viền vào nhau.
  4. **Lọt chuỗi tiếng Anh trong chi tiết tranh chấp đã giải quyết** (`dispute-desktop-resolved.png`): lý do đóng ghi `Both parties consented to remedy version 1` giữa giao diện tiếng Việt.
  5. **Vòng focus thô quanh `<h1>` và tràn dòng nav desktop**: `Đăng nhập` / `Chi tiết tranh chấp` có khung focus bám sát chữ không padding; thanh điều hướng desktop 9-10 mục rớt dòng mục cuối (`Vai trò tài khoản`, `Quản trị`).
