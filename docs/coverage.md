# Coverage unit và integration

Chạy với Node 26, dependency từ lockfile và PostgreSQL 17 dùng một lần. Cấu hình `TEST_DATABASE_URL` qua môi trường riêng, chỉ DB local có tên `_test`; không dùng DB cloud/shared vì integration có thao tác reset schema.

```bash
npm run test:coverage
```

Lệnh gộp unit và integration, đo `server/src/**` cùng `functions/thumbnail/*.cjs`, loại file test. Không đo frontend, script vận hành, Terraform, Jenkins hoặc Azure Pipelines. Native Node coverage hiện là experimental; kết quả không chứng minh đúng nghiệp vụ hoặc đầy đủ mọi tình huống.

## Mốc đã đo

Nguồn ứng dụng tại `d43809cbb1dbb77c7fa1e5ce85d2864bcca61c8a`; thêm lệnh npm không đổi module ứng dụng. Lượt thực thi: 363 unit + 227 integration, tổng 590 test đạt, không fail. Coverage của phạm vi nêu trên: line 98,00%, branch 91,58%, function 97,27%. Log đầy đủ giữ ngoài Git trong bộ minh chứng local; phải chạy lại sau khi ghép auth/hạ tầng, không chuyển số này sang SHA mới tự động.

| Module | Line % | Branch % |
|---|---:|---:|
| Account API | 96,88 | 86,87 |
| Account gateway | 100,00 | 94,44 |
| Booking | 99,31 | 95,92 |
| Catalog | 100,00 | 98,96 |
| Dispatch | 98,87 | 94,92 |
| Scheduling | 100,00 | 85,07 |
| Recruitment | 97,81 | 94,05 |
| Shifts | 98,77 | 97,73 |
| Acceptance | 97,54 | 90,30 |
| Disputes | 97,69 | 92,86 |
| Remedies | 100,00 | 80,00 |
| Postponement | 97,81 | 86,24 |
| Evidence API | 96,43 | 81,18 |
| Blob REST | 98,39 | 95,03 |
| Activity | 95,58 | 54,55 |
| Thumbnail processor | 100,00 | 96,30 |
| Function adapter | 66,67 | 63,64 |

Các nhánh chưa chạy cần đọc theo log uncovered lines, không tăng tỷ lệ bằng bỏ file hoặc bỏ assertion. Coverage cao vẫn đã phát hiện lỗi cấu hình runtime, throttle và lịch sử hòa giải; kiểm âm, cạnh tranh, browser/system và runtime cloud phải giữ riêng.
