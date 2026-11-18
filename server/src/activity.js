import express from 'express';
import { parsePagination } from './catalog.js';

// G10: in-app activity feed derived from persisted event tables. Not notifications: no delivery, no read state.
// Visibility is set per source by entity scope. actor_id alone never grants visibility.
// Items carry fixed labels and a hash to a known ID. Event data, reasons, texts and details are never selected.
// ponytail: offset paging inherits the 10000 ceiling. Ceiling: deep pages scan and skip rows. Upgrade: keyset cursor on (created_at, id).

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DB_UNAVAILABLE_CODE = /^(08|57P01|53300|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)/;

const LABELS = {
  'booking.BOOKING_REQUESTED': 'Yêu cầu đặt dịch vụ đã được gửi',
  'booking.COORDINATOR_ASSIGNED': 'Đã gán điều phối viên cho yêu cầu',
  'booking.BOOKING_GROUPED': 'Yêu cầu đã được gom vào gói dịch vụ',
  'booking.BOOKING_ASSIGNED': 'Yêu cầu đã được phân công',
  'booking.BOOKING_CANCELLED': 'Yêu cầu đã bị hủy',
  'recruitment.job.created': 'Tin tuyển việc đã được đăng',
  'recruitment.job.closed': 'Tin tuyển việc đã đóng',
  'recruitment.application.created': 'Đơn ứng tuyển đã được nộp',
  'recruitment.application.offered': 'Đơn ứng tuyển đã nhận đề nghị công việc',
  'recruitment.application.withdrawn': 'Đơn ứng tuyển đã được rút',
  'recruitment.application.offer_declined': 'Đề nghị công việc đã bị từ chối, đơn quay lại chờ xử lý',
  'recruitment.offer.created': 'Đề nghị công việc đã được gửi',
  'recruitment.offer.accepted': 'Đề nghị công việc đã được chấp nhận',
  'recruitment.offer.declined': 'Đề nghị công việc đã bị từ chối',
  'recruitment.offer.withdrawn': 'Đề nghị công việc đã được thu hồi',
  'shift.SHIFT_STARTED': 'Ca làm việc đã bắt đầu',
  'shift.SHIFT_PAUSED': 'Ca làm việc đã tạm dừng',
  'shift.SHIFT_RESUMED': 'Ca làm việc đã tiếp tục',
  'shift.SHIFT_COMPLETED': 'Ca làm việc đã hoàn tất',
  'dispute.DISPUTE_OPENED': 'Tranh chấp đã được mở',
  'dispute.RESPONSE_ADDED': 'Đã có phản hồi trong tranh chấp',
  'dispute.MEDIATOR_ASSIGNED': 'Người hòa giải đã được phân công',
  'remedy.PROPOSED': 'Phương án xử lý đã được đề xuất',
  'remedy.CONSENTED': 'Một bên đã đồng ý phương án xử lý',
  'remedy.RESOLVED': 'Tranh chấp đã đóng sau khi hai bên đồng ý',
  'remedy.CLOSED_UNRESOLVED': 'Tranh chấp đã đóng, chưa đạt thỏa thuận',
};

// Each branch yields (prefix, seq, created_at, type, href). The branch WHERE is its scope.
// Booking events: owner only. Shift events: operator, provider or coop of the package.
// Recruitment: job provider; application operator; offer operator or job provider.
// Dispute and remedy events: claimant, respondent or assigned mediator only.
const FEED_SQL = `
SELECT prefix, seq, created_at, type, href FROM (
  SELECT 'booking' AS prefix, e.sequence AS seq, e.created_at, 'booking.' || e.event_type AS type, '#booking/' || e.booking_id::text AS href
    FROM dispatch.booking_events e JOIN dispatch.bookings b ON b.id = e.booking_id
   WHERE b.owner_id = $1::uuid
  UNION ALL
  SELECT 'recruitment', e.id, e.created_at, 'recruitment.' || e.action, '#job/' || j.id::text
    FROM dispatch.recruitment_events e
    LEFT JOIN dispatch.applications a ON e.entity_type = 'application' AND a.id = e.entity_id
    LEFT JOIN dispatch.offers o ON e.entity_type = 'offer' AND o.id = e.entity_id
    JOIN dispatch.jobs j ON j.id = CASE e.entity_type WHEN 'job' THEN e.entity_id WHEN 'application' THEN a.job_id ELSE o.job_id END
   WHERE (e.entity_type = 'job' AND j.provider_id = $1::uuid)
      OR (e.entity_type = 'application' AND (a.operator_id = $1::uuid OR j.provider_id = $1::uuid))
      OR (e.entity_type = 'offer' AND (o.operator_id = $1::uuid OR j.provider_id = $1::uuid))
  UNION ALL
  SELECT 'shift', e.sequence, e.created_at, 'shift.' || e.event_type, '#shift/' || e.shift_id::text
    FROM dispatch.shift_events e
    JOIN dispatch.shifts s ON s.id = e.shift_id
    JOIN dispatch.packages p ON p.id = s.package_id
   WHERE $1::uuid IN (p.operator_id, p.provider_id, p.coop_id)
  UNION ALL
  SELECT 'dispute', e.sequence, e.created_at, 'dispute.' || e.event_type, '#dispute/' || e.dispute_id::text
    FROM dispatch.dispute_events e JOIN dispatch.disputes d ON d.id = e.dispute_id
   WHERE $1::uuid IN (d.claimant_id, d.respondent_id, d.mediator_id)
  UNION ALL
  SELECT 'remedy', e.sequence, e.created_at, 'remedy.' || e.event_type, '#dispute/' || e.dispute_id::text
    FROM dispatch.remedy_events e JOIN dispatch.disputes d ON d.id = e.dispute_id
   WHERE $1::uuid IN (d.claimant_id, d.respondent_id, d.mediator_id)
) feed
ORDER BY created_at DESC, prefix ASC, seq DESC
LIMIT $2 OFFSET $3`;

const itemDto = (row) => ({
  id: `${row.prefix}:${row.seq}`,
  type: row.type,
  createdAt: row.created_at.toISOString(),
  href: row.href,
  text: Object.hasOwn(LABELS, row.type) ? LABELS[row.type] : 'Có cập nhật. Mở chi tiết để xem.',
});

export function createActivityRouter({ pool, authenticate }) {
  if (typeof pool?.query !== 'function') throw new TypeError('createActivityRouter requires a pool with query()');
  if (typeof authenticate !== 'function') throw new TypeError('createActivityRouter requires an authenticate middleware');

  const router = express.Router();

  router.get('/api/activity', authenticate, async (req, res, next) => {
    try {
      const actor = req.actor;
      if (!actor || typeof actor.id !== 'string' || !UUID_PATTERN.test(actor.id) || !Array.isArray(actor.roles)) return res.status(401).json({ error: { code: 'UNAUTHENTICATED' } });
      res.set('Cache-Control', 'no-store');
      let page;
      try {
        page = parsePagination(req.query);
      } catch (error) {
        return res.status(error.status).json({ error: { code: error.code } });
      }
      const { rows } = await pool.query(FEED_SQL, [actor.id, page.limit, page.offset]);
      return res.json({ items: rows.map(itemDto), limit: page.limit, offset: page.offset });
    } catch (error) {
      if (DB_UNAVAILABLE_CODE.test(typeof error.code === 'string' ? error.code : '')) {
        return res.status(503).json({ error: { code: 'DB_UNAVAILABLE' } });
      }
      return next(error);
    }
  });

  return router;
}
