# DEV-54: Ranh ruộng, gợi ý gom đơn và danh mục dịch vụ

Bàn giao cho Thiện (DEV-23, DEV-41). Gửi JSON với `Content-Type: application/json`. Các tuyến không công khai cần `Authorization: Bearer <token>`.

## 1. Ranh ruộng

| Tuyến | Quyền | Thành công |
| --- | --- | --- |
| `POST /api/fields` | `farmer`, `coop`, tạo ruộng của mình | `201 { field }` |
| `PATCH /api/fields/:id` | `farmer`, `coop`, chỉ chủ ruộng | `200 { field }` |
| `GET /api/fields` | `farmer`, `coop`, chỉ ruộng của mình | `200 { items, limit, offset }` |
| `GET /api/fields/:id` | `farmer`, `coop`, chỉ chủ ruộng | `200 { field }` |

Ví dụ body tạo ruộng (tọa độ minh họa, không phải ranh ruộng thực địa):

```json
{
  "name": "Ruộng số 1",
  "locality": "Xã kiểm thử, Cần Thơ",
  "provinceCode": "CT",
  "communeCode": "TEST-XA",
  "boundaryGeojson": {
    "type": "Polygon",
    "coordinates": [[[105.8, 10], [105.801, 10], [105.801, 10.001], [105.8, 10.001], [105.8, 10]]]
  }
}
```

- `name` và `locality` bắt buộc khi tạo, tối đa 120 và 200 ký tự sau khi bỏ khoảng trắng đầu cuối.
- `boundaryGeojson` là `Polygon` GeoJSON với đúng một vòng ngoài, không có lỗ. `coordinates: [ring]`; `ring` có 4 đến 101 điểm, tính cả điểm đóng. Mỗi điểm là đúng hai số hữu hạn theo thứ tự `[longitude, latitude]`, trong khoảng `[-180, 180]` và `[-90, 90]`. Điểm cuối trùng điểm đầu; không lặp điểm khác, không tự cắt, không chồng đoạn, không cắt kinh tuyến đổi ngày. Chấp nhận cả hai chiều vẽ.
- Trước khi gửi `Polygon`, chính chủ gọi `POST /api/location-consent` với `{ "consent": true, "version": "field-boundary-v1" }`. Rút đồng ý qua `DELETE /api/location-consent` xóa cả ranh và tâm; diện tích `areaM2` đã lưu vẫn giữ nguyên. Các phản hồi ruộng có `Cache-Control: no-store`.
- Có polygon: server tính diện tích theo độ dư cầu, dùng bán kính 6.378.137 m, làm tròn đến m² và dùng làm `areaM2`. Có thể bỏ `areaM2`; nếu gửi kèm, giá trị hợp lệ vẫn không ghi đè diện tích tính từ ranh. `centroid` là trọng tâm theo diện tích trong hệ tọa độ kinh vĩ độ cục bộ, không phải kết quả đo địa chính.
- Không có polygon: khi tạo phải gửi `areaM2` nguyên từ 1 đến 10.000.000. `boundaryGeojson`, `centroid`, `calculatedAreaM2` trả `null`; `areaHa` và `areaCong` vẫn quy đổi từ `areaM2`.
- `PATCH` cần ít nhất một trường. Không gửi `boundaryGeojson` để giữ ranh; gửi `null` để xóa ranh và giữ diện tích cũ, trừ khi gửi `areaM2` mới. Khi còn polygon mà chỉ sửa `areaM2`, diện tích tính từ ranh vẫn được ưu tiên. Sửa ranh không đổi diện tích đã chốt trong đơn cũ.
- `provinceCode` và `communeCode` là cặp tùy chọn, lấy đúng mã trong địa bàn đã cấu hình. Mỗi mã khớp `^[A-Z0-9-]{2,32}$`; gửi cả hai hoặc cả hai `null` để xóa. `locality` chỉ là tên hiển thị, không xác định quyền truy cập. Ruộng thiếu cặp mã không xuất hiện trong gợi ý gom đơn.
- Tuyến `PUT /api/fields/:id/details` tiếp tục nhận vòng `coordinates` cũ; lần lưu ranh tiếp theo cập nhật cả GeoJSON. Migration không tự chuyển ranh cũ sang GeoJSON.
- Phản hồi `field` gồm `id`, `name`, `locality`, `createdAt`, `areaM2`, `provinceCode`, `communeCode`, `boundaryGeojson`, `centroid: { lat, lng } | null`, `calculatedAreaM2`, `areaHa`, `areaCong`, `congUnit` và `congConversionM2`. Với tọa độ trên, `calculatedAreaM2 = 12204`, `areaHa = 1.2204`.

**Quy đổi:** 1 ha = 10.000 m²; 1 công tầm cắt = 1.296 m². `congUnit: "cong_tam_cat_1296m2"`, `congConversionM2: 1296`. Giao diện có thể làm tròn khi hiển thị, không dùng số đã làm tròn để tính ngưỡng.

## 2. Gợi ý gom đơn cho HTX (H-02, H-03)

`GET /api/coop/cluster-suggestions?maxDistanceKm=1.5&minAreaHa=2` trả `200` và `Cache-Control: no-store`. Chỉ vai trò `coop` gọi được.

- `maxDistanceKm`: số thập phân lớn hơn 0, tối đa 100. Nếu bỏ qua, dùng `radiusM / 1000` từ cấu hình nền tảng mới nhất, mặc định 1,5 km.
- `minAreaHa`: số thập phân lớn hơn 0, tối đa 10.000. Nếu bỏ qua, dùng `clusterMinHa`, mặc định 15 ha.
- Chỉ xét đơn `REQUESTED` chưa hết khung giờ, chưa thuộc gói, đã giao cho HTX đang đăng nhập. Ruộng phải có tâm và chủ ruộng còn đồng ý chia sẻ vị trí; cặp mã tỉnh/xã phải thuộc địa bàn đang được cấp cho HTX. API không trả ranh ruộng, tên chủ ruộng hay thông tin liên hệ.
- Mỗi cụm có ít nhất 2 ruộng khác nhau, cùng dịch vụ, cùng `locality` và có khung giờ giao nhau. Mọi cặp tâm trong cụm đều phải nằm trong `maxDistanceKm`. Khoảng cách Haversine dùng cùng bán kính cầu 6.378.137 m, không làm tròn và không phải quãng đường di chuyển.
- Cụm xếp theo `maxPairwiseDistanceKm` tăng dần, rồi `areaM2` giảm dần, rồi ID đơn đầu tiên. `pairwiseDistances` xếp theo `distanceKm` tăng dần. Tổng diện tích dùng diện tích polygon hiện tại, không dùng giá hay diện tích báo giá lịch sử.
- Server xét tối đa 500 đơn đủ điều kiện theo giờ bắt đầu, giờ tạo, ID. `truncated: true` báo còn đơn ngoài giới hạn. Mỗi cụm có tối đa 100 đơn. Gợi ý xếp tuần tự, không tìm mọi cách gom tối ưu. Khi không có cụm đạt ngưỡng, trả `items: []`.

Ví dụ phản hồi (ID và tọa độ minh họa):

```json
{
  "items": [{
    "serviceId": "00000000-0000-4000-8000-000000000103",
    "locality": "Xã kiểm thử, Cần Thơ",
    "window": { "startAt": "2099-01-15T08:00:00.000Z", "endAt": "2099-01-15T12:00:00.000Z" },
    "members": [
      { "bookingId": "10000000-0000-4000-8000-000000000001", "fieldId": "20000000-0000-4000-8000-000000000001", "centroid": { "lat": 10.0005, "lng": 105.8005 } },
      { "bookingId": "10000000-0000-4000-8000-000000000002", "fieldId": "20000000-0000-4000-8000-000000000002", "centroid": { "lat": 10.0025, "lng": 105.8005 } }
    ],
    "pairwiseDistances": [{
      "fromBookingId": "10000000-0000-4000-8000-000000000001",
      "toBookingId": "10000000-0000-4000-8000-000000000002",
      "distanceKm": 0.2226389815866217
    }],
    "maxPairwiseDistanceKm": 0.2226389815866217,
    "areaM2": 24408,
    "areaHa": 2.4408,
    "areaCong": 18.833333333333332,
    "congUnit": "cong_tam_cat_1296m2",
    "congConversionM2": 1296
  }],
  "maxDistanceKm": 1.5,
  "minAreaHa": 2,
  "truncated": false,
  "haConversionM2": 10000,
  "congUnit": "cong_tam_cat_1296m2",
  "congConversionM2": 1296
}
```

**Chỉ đọc.** Tuyến này không chuyển trạng thái đơn và không tạo gói. HTX xác nhận riêng qua `POST /api/packages` với `bookingIds`; tuyến tạo gói kiểm lại quyền, trạng thái và khung giờ tại thời điểm ghi.

## 3. Danh mục dịch vụ

| Tuyến | Quyền | Thành công |
| --- | --- | --- |
| `GET /api/services` | Công khai, chỉ dịch vụ đang hoạt động | `200 { items, limit, offset }` |
| `GET /api/services/:id` | Công khai, chỉ dịch vụ đang hoạt động | `200 { service }` |
| `POST /api/services` | `admin`, `provider` | `201 { service }` |
| `PATCH /api/services/:id` | `admin` hoặc `provider` đã tạo dịch vụ | `200 { service }` |
| `DELETE /api/services/:id` | `admin` hoặc `provider` đã tạo dịch vụ | `200 { service }` với `active: false` |

```json
{
  "name": "Gặt lúa liên hợp",
  "unit": "ha",
  "pricePerHaVnd": "2345678",
  "machineType": "harvester",
  "active": true,
  "description": "Gặt lúa theo diện tích"
}
```

- Khi tạo, bắt buộc có `name`, `unit`, `pricePerHaVnd`, `machineType`. `name` không rỗng, tối đa 160 ký tự. `unit` chỉ nhận `ha`. `machineType` nhận `harvester`, `tractor` hoặc `drone`.
- `pricePerHaVnd` là số nguyên dương theo VND/ha, tối đa 9223372036854775. Gửi chuỗi chữ số không có dấu, dấu phân cách hay số 0 đầu chuỗi, hoặc số nguyên an toàn trong JavaScript. Server luôn trả giá dưới dạng chuỗi.
- `active` là boolean, mặc định `true`. `description` tùy chọn, `null` hoặc chuỗi không rỗng tối đa 1.000 ký tự sau khi bỏ khoảng trắng đầu cuối.
- `PATCH` nhận ít nhất một trong `name`, `unit`, `pricePerHaVnd`, `active`, `description`; gửi `description: null` để xóa mô tả. Không sửa `machineType` sau khi tạo. Có thể dùng `active: true` để bật lại dịch vụ.
- `service` trả `id`, `code`, `name`, `unit`, `pricePerHaVnd`, `machineType`, `active`, `description`, `dataLabel`. `id`, `code`, chủ sở hữu và `dataLabel` do server đặt. Dịch vụ tạo qua API luôn có nhãn `real-labelled`; dữ liệu seed vẫn là `synthetic` và có thể không có `machineType`. Nhãn cho biết nguồn nhập, không phải xác nhận đã kiểm chứng giá thị trường.
- Tạo, sửa và ngừng dịch vụ làm mới ngay mọi trang cache trong tiến trình xử lý yêu cầu. Với nhiều tiến trình, tắt TTL (`SERVICES_CACHE_MS=0`, mặc định) nếu mọi bản sao phải đọc ngay giá mới; bản sao bật TTL khác có thể đọc cache cũ đến khi hết hạn.
- `DELETE` chỉ đặt `active: false`, không xóa dòng. Đơn mới không dùng được dịch vụ đã tắt. Giá VND/ha và tổng tiền đã chốt của đơn cũ không đổi.

## 4. Mã lỗi

Lỗi có dạng `{ "error": { "code": "VALIDATION_FAILED", "field": "boundaryGeojson" } }`; `field` chỉ có khi xác định được trường lỗi.

| HTTP | Mã | Khi gặp |
| --- | --- | --- |
| 400 | `INVALID_BODY`, `UNKNOWN_FIELD` | Body không phải object, `PATCH` rỗng hoặc có trường API không nhận |
| 400 | `VALIDATION_FAILED` | Polygon, mã địa bàn, tên, diện tích, giá, đơn vị hoặc ngưỡng không hợp lệ |
| 400 | `INVALID_ID`, `INVALID_PAGINATION` | ID sai UUID hoặc phân trang ngoài giới hạn `limit` 1 đến 100, `offset` 0 đến 10.000 |
| 400 | `INVALID_JSON`, `VALIDATION_FAILED` | JSON sai cú pháp hoặc chứa ký tự NUL |
| 401 | `UNAUTHENTICATED` | Thiếu token hoặc token không hợp lệ |
| 403 | `FORBIDDEN`, `LOCATION_CONSENT_REQUIRED` | Sai vai trò hoặc chưa có đồng ý vị trí còn hiệu lực |
| 404 | `NOT_FOUND` | Không tồn tại, không thuộc quyền chủ sở hữu hoặc dịch vụ đã ngừng khi đọc công khai |
| 413 | `PAYLOAD_TOO_LARGE` | Body vượt 64 KB |
| 503 | `IDENTITY_UNAVAILABLE`, `DB_UNAVAILABLE` | Dịch vụ xác thực hoặc PostgreSQL không sẵn sàng |

Triển khai local: chạy migration `028_gis_polygons_real_catalog.sql` qua `npm run db:migrate`, sau đó chạy lại `server/scripts/bootstrap-db.js` theo quy trình cấp quyền runtime. Không cần PostGIS.
