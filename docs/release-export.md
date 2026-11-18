# Xuất gói nguồn sạch (release export)

Script `server/scripts/export-release.js` tạo gói nguồn từ commit Git đã cam kết, chỉ gồm đường dẫn nằm trong allowlist. Không đọc nội dung file bí mật, không tạo bản sao đã lọc bí mật, không publish.

## Cách chạy

Chạy trong worktree sạch, output phải là đường dẫn tuyệt đối, nằm ngoài worktree và chưa tồn tại:

```bash
node server/scripts/export-release.js --output /abs/dir/release.tar.gz --sha HEAD
```

- `--sha` mặc định `HEAD`. Nhận `HEAD` hoặc SHA đầy đủ 40 ký tự thường. Giá trị khác bị từ chối trước khi tra commit (không tự chuẩn hóa).
- Tạo hai file cạnh nhau: `release.tar.gz` (`git archive`, tiền tố `agridispatch-<12 ký tự SHA>/`) và `release.manifest.json`.
- Không ghi đè file đã có. Nếu lỗi giữa chừng, xóa file vừa tạo.

## Điều kiện từ chối

- Có thay đổi chưa commit hoặc file untracked (`git status --porcelain`). Dùng commit trước khi xuất để artifact không bị nhận nhầm là HEAD.
- `--output` không tuyệt đối, không kết thúc bằng `.tar.gz`, hoặc nằm trong worktree.
- `--sha` không hợp lệ hoặc không phải commit.
- Có file tracked bị coi là bí mật theo tên (`.env` không phải `.env.example`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `credentials*`, `id_rsa`, `auth.json`, `.npmrc`, `.netrc`, đường dẫn `private/`, `node_modules/`) nằm trong allowlist.
- Có file `.gitattributes` tracked. File này có thể đổi byte của archive.
- Byte thực trong archive khác Git blob, gồm trường hợp attributes ngoài commit thay nội dung. Mỗi file được đọc từ archive và đối chiếu số byte/SHA-256 trước khi ghi manifest.
- Allowlist không khớp file nào.

## Allowlist

Đưa vào: `package.json`, `package-lock.json`, `.nvmrc`, `README.md`, `eslint.config.js`, `.dockerignore`, `.editorconfig`, `.gitignore`, `.env.example`, và các thư mục `server/`, `db/`, `web/`, `infra/`, `functions/`, `.github/workflows/`. Trong `docs/`, chỉ `api.md`, `architecture.md`, `development.md`, `cloud.md`, `synthetic-data.md`, `benchmark.md`, `benchmark-bookings.md`, `evidence-recovery.md`, `release-export.md`.

Loại có lý do (ghi trong `excluded` của manifest): `AGENTS.md` và tài liệu nội bộ, `docs/cloud-stages.md` (kế hoạch và phê duyệt nội bộ), và mọi đường dẫn ngoài allowlist. Liên kết từ README đến hai tài liệu bị loại không có đích trong gói; dùng runbook được đưa vào để chạy nguồn. Không sửa byte nguồn khi xuất để giữ đúng provenance của commit.

## Manifest

`release.manifest.json` gồm:

- `source`: `commitSha` (40 ký tự), `workingTree: "clean"`, `commitDate` (ngày commit thật), `exportRunDate` (thời điểm chạy script).
- `archive`: tên file, định dạng, tiền tố, số byte và SHA-256 của `release.tar.gz`.
- `counts`, `files` (đường dẫn, mode, số byte, SHA-256 từng file trong gói), `excluded` (đường dẫn và lý do).
- `labels`: phạm vi, ghi chú nội dung chưa được quét, `aiAssistedContent`, và các cờ luôn là `false`: `testsVerified`, `deploymentVerified`, `publicReleaseApproved`, `privacyReviewed`.

Manifest không chứa giá trị biến môi trường và không tuyên bố đã kiểm thử, đã triển khai hay đã được phê duyệt công khai.

## Giới hạn

- Không quét nội dung. Một bí mật thật nằm trong file có tên được phép vẫn sẽ vào gói. Trước khi công khai cần rà soát riêng.
- Không đọc nội dung file bị từ chối theo tên.
- Toàn bộ archive được đọc vào bộ nhớ để băm. Phù hợp cho gói nguồn hiện tại, không phù hợp cho artifact lớn.
- Gói có nội dung do AI hỗ trợ tạo. Manifest ghi nhãn này.
- Gói không thay thế kiểm duyệt quyền riêng tư và phê duyệt công khai.

## Kiểm thử

```bash
node --test server/tests/export-release.test.js
```

Test dùng repo Git tạm trong `TMPDIR` và kiểm tra: từ chối khi dirty, từ chối output trong worktree, từ chối ghi đè, từ chối `--sha` sai định dạng, từ chối file bí mật được allowlist, loại file bí mật không được allowlist kèm lý do, từ chối đường dẫn output sai, xuất đúng commit cũ khi chỉ định `--sha`. Test chạy trong `npm test`.
