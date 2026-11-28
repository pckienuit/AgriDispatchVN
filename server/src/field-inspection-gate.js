const messages = {
  FIELD_INSPECTION_REQUIRED: 'Cần kết quả kiểm tra thực địa còn hiệu lực từ HTX.',
  FIELD_INSPECTION_NOT_PASSED: 'Kiểm tra thực địa chưa đạt. Cần HTX kiểm tra lại.',
};

export class FieldInspectionError extends Error {
  constructor(status) {
    const code = status === 'NOT_PASSED' ? 'FIELD_INSPECTION_NOT_PASSED' : 'FIELD_INSPECTION_REQUIRED';
    super(messages[code]);
    this.status = 409;
    this.code = code;
  }
}

// Writers check under the package lock shared by inspections, readiness, postponement and shift opening.
export async function assertFieldInspectionPassedForBooking(db, bookingId) {
  const { rows: [{ status }] } = await db.query('SELECT dispatch.field_inspection_status($1) AS status', [bookingId]);
  if (status !== 'PASSED') throw new FieldInspectionError(status);
}
