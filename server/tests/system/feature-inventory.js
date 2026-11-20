// Feature-to-test inventory for AgriDispatch VN. Every path below is checked against disk by
// server/tests/system-runner.test.js; every route is checked against server/src. Empty layer = explicit gap.
// browser[].mode must name a MODES key in server/scripts/test-system.js. Browser flows marked "--operations" or
// "--dispatch" are run inside those modes; no mode is named after a role-only scenario.
export const FEATURES = [
  {
    id: 'auth-session',
    area: 'Đăng ký, đăng nhập, phiên, gateway tài khoản',
    routes: ['POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/me', 'POST /internal/introspect'],
    unit: ['server/tests/account.test.js', 'server/tests/account-gateway.test.js', 'server/tests/client-identity.test.js', 'server/tests/service-auth.test.js', 'server/tests/web-accounts.test.js'],
    integration: ['server/tests/integration/account.test.js', 'server/tests/integration/auth-proxy.test.js'],
    browser: [
      { mode: 'default', flow: 'register, login, logout (farmer)' },
      { mode: 'operations', flow: 'login as each role via form' },
    ],
  },
  {
    id: 'role-requests',
    area: 'Yêu cầu vai trò và duyệt quản trị',
    routes: ['POST /api/role-requests', 'GET /api/role-requests', 'GET /api/admin/role-requests', 'POST /api/admin/role-requests/:id/approve', 'POST /api/admin/role-requests/:id/reject'],
    unit: ['server/tests/web-accounts.test.js', 'server/tests/account-gateway.test.js'],
    integration: ['server/tests/integration/role-requests.test.js'],
    browser: [
      { mode: 'operations', flow: 'farmer requests provider -> pending; admin approve; farmer requests coop -> admin reject with reason; rejected role hidden' },
    ],
  },
  {
    id: 'catalog-services',
    area: 'Danh mục dịch vụ, thửa ruộng, máy',
    routes: ['GET /api/services', 'GET /api/services/:id', 'GET /api/fields', 'POST /api/fields', 'POST /api/machines', 'GET /api/machines'],
    unit: ['server/tests/catalog.test.js', 'server/tests/web.test.js'],
    integration: ['server/tests/integration/catalog.test.js'],
    browser: [
      { mode: 'default', flow: 'catalog renders 3 cards; field create with empty-form validation focus; detail page' },
      { mode: 'dispatch', flow: 'provider creates machine from dispatch UI' },
    ],
  },
  {
    id: 'booking-request',
    area: 'Đặt dịch vụ, lịch sử đặt, idempotency',
    routes: ['POST /api/bookings', 'GET /api/bookings', 'GET /api/bookings/:id', 'POST /api/bookings/:id/coordinator', 'GET /api/bookings/:id/coordinator', 'GET /api/coordinators'],
    unit: ['server/tests/booking.test.js', 'server/tests/web.test.js'],
    integration: ['server/tests/integration/booking.test.js', 'server/tests/integration/benchmark-bookings.test.js'],
    browser: [
      { mode: 'default', flow: 'farmer creates booking, sees 1.440.000 VND, bookings history, mobile overflow check' },
      { mode: 'dispatch', flow: 'farmer delegates booking to coop coordinator via #booking form' },
    ],
  },
  {
    id: 'dispatch-package',
    area: 'Gom gói, phân công, hủy gói, đọc điều phối',
    routes: ['POST /api/packages', 'GET /api/packages', 'GET /api/packages/:id', 'POST /api/packages/:id/claim', 'POST /api/packages/:id/cancel', 'GET /api/dispatch/bookings', 'GET /api/dispatch/operators'],
    unit: ['server/tests/dispatch.test.js', 'server/tests/web-dispatch.test.js'],
    integration: ['server/tests/integration/dispatch.test.js', 'server/tests/integration/dispatch-reads.test.js', 'server/tests/integration/scheduling.test.js'],
    browser: [
      { mode: 'dispatch', flow: 'coop groups bookings into package; coop cancels unstarted package with reason; provider claims package with machine + operator; mobile dispatch layout' },
    ],
  },
  {
    id: 'postponement',
    area: 'Dời lịch: đề xuất, đồng ý theo phiên bản, áp dụng',
    routes: ['POST /api/packages/:id/postponement', 'POST /api/packages/:id/postponement/:version/consent', 'GET /api/packages/:id/postponement', 'GET /api/bookings/:id/postponement'],
    unit: ['server/tests/web-postponement.test.js'],
    integration: ['server/tests/integration/postponement.test.js'],
    browser: [
      { mode: 'dispatch', flow: 'provider proposes new window; non-party coop sees 0/2 without consent button; farmer consents v1 on mobile; provider consents -> applied' },
    ],
  },
  {
    id: 'recruitment',
    area: 'Tin tuyển, ứng tuyển, đề nghị, nhận việc',
    routes: ['POST /api/jobs', 'GET /api/jobs', 'GET /api/jobs/:id', 'GET /api/jobs/mine', 'POST /api/jobs/:id/applications', 'GET /api/jobs/:id/applications', 'POST /api/jobs/:id/close', 'POST /api/applications/:id/offers', 'GET /api/offers', 'POST /api/offers/:id/accept', 'POST /api/offers/:id/decline', 'GET /api/applications/mine'],
    unit: ['server/tests/recruitment.test.js', 'server/tests/web-recruitment.test.js'],
    integration: ['server/tests/integration/recruitment.test.js', 'server/tests/integration/recruitment-live.test.js'],
    browser: [
      { mode: 'recruitment', flow: 'provider creates job; operator applies; provider offers; operator accepts on mobile; provider closes job' },
    ],
  },
  {
    id: 'shifts-operations',
    area: 'Ca làm việc: bắt đầu, tạm dừng, tiếp tục, hoàn thành, diện tích',
    routes: ['POST /api/packages/:id/shifts/start', 'POST /api/shifts/:id/pause', 'POST /api/shifts/:id/resume', 'POST /api/shifts/:id/complete', 'GET /api/shifts', 'GET /api/shifts/:id', 'GET /api/shift-packages'],
    unit: ['server/tests/shifts.test.js', 'server/tests/web-operations.test.js'],
    integration: ['server/tests/integration/shifts.test.js'],
    browser: [
      { mode: 'operations', flow: 'operator starts/pauses/resumes/completes shift; area above 12000 rejected; provider read-only shift view; mobile layout' },
    ],
  },
  {
    id: 'readiness',
    area: 'Xác nhận sẵn sàng khi đặt dịch vụ',
    routes: ['POST /api/bookings/:id/readiness', 'GET /api/bookings/:id/readiness'],
    unit: ['server/tests/shifts.test.js'],
    integration: ['server/tests/integration/shifts.test.js', 'server/tests/integration/acceptance.test.js'],
    browser: [
      { mode: 'default', flow: 'farmer confirms readiness drained/mature/intake; frozen after completion' },
    ],

  },
  {
    id: 'field-inspection',
    area: 'HTX thẩm định thực địa trước ca',
    routes: ['GET /api/bookings/:id/inspections', 'POST /api/bookings/:id/inspections'],
    unit: ['server/tests/shifts.test.js'],
    integration: ['server/tests/integration/field-inspection.test.js', 'server/tests/integration/shifts.test.js'],
    browser: [
      { mode: 'operations', flow: 'after farmer readiness, fixture sends HTX inspection through the real API before operator starts work' },
    ],
    gaps: { browser: 'Legacy smoke performs the HTX action through the API, not by clicking H-04' },
  },
  {
    id: 'acceptance-settlement',
    area: 'Nghiệm thu, đồng ý theo phiên bản, báo thanh toán, xác nhận nhận',
    routes: ['POST /api/bookings/:id/acceptance', 'POST /api/bookings/:id/acceptance/:version/consent', 'GET /api/bookings/:id/acceptance', 'POST /api/bookings/:id/payments', 'GET /api/bookings/:id/payments', 'POST /api/payments/:id/confirm'],
    unit: ['server/tests/acceptance.test.js', 'server/tests/web-settlement.test.js'],
    integration: ['server/tests/integration/acceptance.test.js'],
    browser: [
      { mode: 'operations', flow: 'provider proposes settlement v1; farmer stale-version; reload v2 consent; farmer reports payment with dropped answer -> uncertain, retry keeps single payment; provider confirms receipt' },
    ],
  },
  {
    id: 'disputes-remedies',
    area: 'Khiếu nại, phản hồi, hòa giải, đề xuất, đóng chưa giải quyết',
    routes: ['POST /api/bookings/:id/disputes', 'GET /api/disputes', 'GET /api/disputes/:id', 'POST /api/disputes/:id/responses', 'GET /api/htx/disputes', 'POST /api/disputes/:id/htx-mediator', 'POST /api/disputes/:id/escalate', 'POST /api/disputes/:id/mediator', 'POST /api/disputes/:id/proposals', 'POST /api/disputes/:id/proposals/:version/consent', 'POST /api/disputes/:id/close-unresolved', 'GET /api/dispute-review', 'GET /api/dispute-review/:id/mediators', 'GET /api/disputes/:id/proposals'],
    unit: ['server/tests/disputes.test.js', 'server/tests/web-disputes.test.js'],
    integration: ['server/tests/integration/disputes.test.js', 'server/tests/integration/remedies.test.js', 'server/tests/integration/htx-mediation.test.js'],
    browser: [
      { mode: 'operations', flow: 'party files dispute; respondent replies; admin records escalation before assigning mediator; both parties independently consent to current proposal; second dispute closed unresolved and booking stays frozen' },
    ],
  },
  {
    id: 'evidence-private',
    area: 'Ảnh bằng chứng riêng tư, thu nhỏ, đối soát object',
    routes: ['POST /api/disputes/:id/evidence', 'GET /api/disputes/:id/evidence'],
    unit: ['server/tests/web-evidence.test.js', 'server/tests/web-binary.test.js', 'server/tests/blob-store.test.js', 'server/tests/evidence-image.test.js'],
    integration: ['server/tests/integration/evidence-reconcile.test.js'],
    browser: [
      { mode: 'operations', flow: 'farmer uploads synthetic PNG evidence in dispute; thumbnail pending state; original download button' },
    ],
    gaps: { thumbnailFunction: 'Azure Function thumbnail trigger not run here; in-memory fixture store only (see functions/thumbnail tests in npm test)' },
  },
  {
    id: 'activity-feed',
    area: 'Lịch sử hoạt động theo quyền',
    routes: ['GET /api/activity'],
    unit: ['server/tests/web-activity.test.js'],
    integration: ['server/tests/integration/activity.test.js'],
    browser: [
      { mode: 'operations', flow: 'provider activity shows closed unresolved dispute link; pagination controls; mobile overflow' },
    ],
  },
  {
    id: 'observability-health',
    area: 'Health/ready, request tracing, observability',
    routes: ['GET /health', 'GET /ready'],
    unit: ['server/tests/app.test.js', 'server/tests/observability.test.js', 'server/tests/lifecycle.test.js'],
    integration: ['server/tests/integration/db.test.js', 'server/tests/integration/request-tracing.test.js'],
    browser: [],
    gaps: { browser: 'health/tracing is an HTTP contract; no UI flow exists for it' },
  },
  {
    id: 'database-migration',
    area: 'Migration thật, seed, khóa DB',
    routes: [],
    unit: ['server/tests/migration.test.js', 'server/tests/config.test.js'],
    integration: ['server/tests/integration/db.test.js'],
    browser: [],
    gaps: { browser: 'schema/migration has no UI surface' },
  },
  {
    id: 'synthetic-data',
    area: 'Sinh dữ liệu tổng hợp, benchmark nạp',
    routes: [],
    unit: ['server/tests/generate-data.test.js'],
    integration: ['server/tests/integration/generate-data.test.js'],
    browser: [],
    gaps: { browser: 'generator is a CLI; not part of user role flows' },
  },
  {
    id: 'release-export',
    area: 'Xuất gói nguồn release có manifest',
    routes: [],
    unit: ['server/tests/export-release.test.js'],
    integration: [],
    browser: [],
    gaps: { integration: 'exporter runs as CLI against git tree; covered by unit tests with real git/tar', browser: 'CLI only, no UI' },
  },
  {
    id: 'function-thumbnail',
    area: 'Azure Function xử lý thumbnail (không chạy trong system test này)',
    routes: [],
    unit: ['server/tests/function-config.test.js'],
    integration: [],
    browser: [],
    gaps: { integration: 'Blob trigger host acceptance not run locally in system tests', browser: 'not in browser flows', thumbnail: 'functions/thumbnail/*.test.cjs runs under npm test only' },
  },
  {
    id: 'benchmark-http',
    area: 'Đo HTTP và benchmark đặt lịch',
    routes: [],
    unit: ['server/tests/benchmark-http.test.js'],
    integration: ['server/tests/integration/benchmark-bookings.test.js'],
    browser: [],
    gaps: { browser: 'performance measurement, not functional browser flow; no capacity claim' },
  },
];
