function containsNullByte(value) {
  // Use an explicit stack so deeply nested JSON within the body limit cannot exhaust the call stack.
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') {
      if (item.includes('\u0000')) return true;
    } else if (item !== null && typeof item === 'object') {
      for (const key of Object.keys(item)) {
        if (key.includes('\u0000')) return true;
        pending.push(item[key]);
      }
    }
  }
  return false;
}

export function rejectNullBytes(req, res, next) {
  if (!containsNullByte(req.body)) return next();
  return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Dữ liệu JSON không được chứa ký tự NUL.' } });
}
