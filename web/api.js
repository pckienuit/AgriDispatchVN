// Shared API layer for both web UIs. Plain ES module with no DOM access, so importing it never starts a shell.
/* global AbortController */

const API_TIMEOUT_MS = 10000;
const IDEMPOTENCY_KEY_BYTES = 16;

export class ApiError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.uncertain = false;
    Object.assign(this, extra);
  }
}

// ---- routing ----------------------------------------------------------------
const ERROR_MESSAGES = {
  UNAUTHENTICATED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  INVALID_CREDENTIALS: 'Email hoặc mật khẩu không đúng.',
  RATE_LIMITED: 'Bạn thử quá nhiều lần. Vui lòng đợi rồi thử lại.',
  CONFLICT: 'Email này đã được đăng ký.',
  NOT_FOUND: 'Không tìm thấy dữ liệu này.',
  VALIDATION_FAILED: 'Thông tin chưa hợp lệ. Vui lòng kiểm tra lại.',
  IDEMPOTENCY_CONFLICT: 'Yêu cầu này đã gửi với nội dung khác. Hãy tải lại đơn của tôi trước khi gửi lại.',
  DB_UNAVAILABLE: 'Hệ thống dữ liệu chưa sẵn sàng. Yêu cầu có thể chưa được ghi nhận, hãy kiểm tra trong đơn của tôi trước khi gửi lại.',
  SERVICE_UNAVAILABLE: 'Máy chủ chưa sẵn sàng. Vui lòng thử lại sau.',
  IDENTITY_UNAVAILABLE: 'Dịch vụ đăng nhập chưa sẵn sàng. Vui lòng thử lại sau.',
  NETWORK: 'Không kết nối được máy chủ. Yêu cầu có thể chưa được ghi nhận, hãy kiểm tra trong đơn của tôi trước khi gửi lại.',
  TIMEOUT: 'Máy chủ phản hồi quá chậm. Yêu cầu có thể chưa được ghi nhận, hãy kiểm tra trong đơn của tôi trước khi gửi lại.',
  BAD_RESPONSE: 'Máy chủ trả về dữ liệu không hợp lệ.',
};

export function messageForError(error) {
  if (error instanceof ApiError && ERROR_MESSAGES[error.code]) return ERROR_MESSAGES[error.code];
  if (error instanceof ApiError && error.status >= 500) return ERROR_MESSAGES.SERVICE_UNAVAILABLE;
  return 'Có lỗi xảy ra. Vui lòng thử lại.';
}
export function newIdempotencyKey() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(IDEMPOTENCY_KEY_BYTES));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('') + Date.now().toString(36);
}
// ---- API client -------------------------------------------------------------

export function createApiClient({ fetchImpl = globalThis.fetch, getToken = () => null, onUnauthorized = () => {}, timeoutMs = API_TIMEOUT_MS, useSessionCookie = false }) {
  async function request(method, path, { auth = false, body, headers = {} } = {}) {
    const requestHeaders = { Accept: 'application/json', ...headers };
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (auth) {
      const token = getToken();
      if (token) requestHeaders.Authorization = `Bearer ${token}`;
      else if (!useSessionCookie) {
        onUnauthorized();
        throw new ApiError(401, 'UNAUTHENTICATED');
      }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let text;
    try {
      response = await fetchImpl(path, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: useSessionCookie ? 'same-origin' : 'omit',
        cache: 'no-store',
      });
      if (response.status !== 204) text = await response.text();
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      throw new ApiError(0, timedOut ? 'TIMEOUT' : 'NETWORK', { uncertain: true });
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 204) return { status: 204, data: null };
    let parsed = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ApiError(response.status, 'BAD_RESPONSE', { uncertain: response.status >= 500 });
      }
    }
    if (!response.ok) {
      const code = parsed?.error?.code ?? 'UNKNOWN';
      const field = typeof parsed?.error?.field === 'string' ? parsed.error.field : undefined;
      const uncertain = response.status >= 500;
      if (response.status === 401 && auth) onUnauthorized();
      throw new ApiError(response.status, code, { uncertain, ...(field ? { field } : {}) });
    }
    if (parsed === null) throw new ApiError(response.status, 'BAD_RESPONSE');
    return { status: response.status, data: parsed };
  }
  async function transfer(path,file) {
    const upload=file!==undefined;
    const valid=upload ? /^\/api\/disputes\/[0-9a-f-]{36}\/evidence$/i : /^\/api\/evidence\/[0-9a-f-]{36}\/(content|thumbnail)$/i;
    if(!valid.test(path))throw new ApiError(0,'BAD_RESPONSE');
    const token=getToken();
    if(!token&&!useSessionCookie){onUnauthorized();throw new ApiError(401,'UNAUTHENTICATED');}
    if(upload&&(!['image/jpeg','image/png'].includes(file?.type)||!Number.isSafeInteger(file.size)||file.size<1||file.size>5242880))throw new ApiError(400,'INVALID_IMAGE');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(path,{method:upload?'POST':'GET',headers:{...(token ? {Authorization:'Bearer '+token} : {}),...(upload?{'Content-Type':file.type}: {})},body:file,
        signal:controller.signal,credentials:useSessionCookie?'same-origin':'omit',cache:'no-store',redirect:'error'});
      if(!response.ok){
        const data=await response.json();if(response.status===401)onUnauthorized();
        throw new ApiError(response.status,data?.error?.code??'UNKNOWN',{uncertain:upload&&response.status>=500});
      }
      if(upload)return {status:response.status,data:await response.json()};
      const type=response.headers.get('Content-Type');
      if(!['image/jpeg','image/png'].includes(type))throw new ApiError(502,'BAD_RESPONSE');
      const declared=response.headers.get('Content-Length');
      if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>5242880)){await response.body?.cancel();throw new ApiError(502,'BAD_RESPONSE');}
      const reader=response.body.getReader(),chunks=[];let size=0;
      for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>5242880){await reader.cancel();throw new ApiError(502,'BAD_RESPONSE');}chunks.push(value);}
      if(size===0)throw new ApiError(502,'BAD_RESPONSE');
      return new globalThis.Blob(chunks,{type});
    } catch(error) {
      if(error instanceof ApiError)throw error;
      throw new ApiError(0,error?.name==='AbortError'?'TIMEOUT':'NETWORK',{uncertain:upload});
    } finally {clearTimeout(timer);}
  }
  return { request, upload:(path,file)=>transfer(path,file), binary:path=>transfer(path) };
}
