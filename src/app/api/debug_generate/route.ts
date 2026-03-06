import { NextResponse, NextRequest } from "next/server";
import { corsHeaders } from "@/lib/utils";
import axios from 'axios';
import * as cookie from 'cookie';

// Debug endpoint - isolate "Token validation failed." root cause
export const maxDuration = 60;
export const dynamic = "force-dynamic";

function decodeJwtPayload(jwt: string): any {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(padded, 'base64');
    return JSON.parse(buf.toString('utf8'));
  } catch { return null; }
}

export async function GET(req: NextRequest) {
  const SUNO_COOKIE = process.env.SUNO_COOKIE || '';
  const CAPSOLVER_KEY = process.env.CAPSOLVER_KEY || '';
  const CLERK_BASE_URL = 'https://clerk.suno.com';
  const CLERK_VERSION = '5.15.0';
  const BASE_URL = 'https://studio-api.prod.suno.com';

  const result: any = { steps: [] };

  try {
    // Step 1: Parse cookies
    const cookies = cookie.parse(SUNO_COOKIE.replace(/[\x00-\x1F\x7F]/g, ''));
    const clientToken = cookies['__client'];
    result.hasClientToken = !!clientToken;

    // Step 2: Get session ID - plain axios (no Android headers)
    const sessionResp = await axios.get(
      `${CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      { headers: { Authorization: clientToken } }
    );
    const sid = sessionResp.data?.response?.last_active_session_id;
    result.steps.push('plain session: ' + (sid ? sid.substring(0, 24) + '...' : 'NOT FOUND'));

    // Step 2b: Same call WITH Android headers (mimics SunoApi.this.client)
    try {
      const androidResp = await axios.get(
        `${CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
        { headers: {
            Authorization: clientToken,
            'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
            'X-Requested-With': 'com.suno.android',
            Cookie: `__client=${clientToken}`
          }}
      );
      const sid2 = androidResp.data?.response?.last_active_session_id;
      result.steps.push('android session: ' + (sid2 ? sid2.substring(0, 24) + '...' : 'NOT FOUND - keys: ' + Object.keys(androidResp.data?.response || {}).join(',')));
    } catch(e: any) {
      result.steps.push('android headers failed: ' + e.response?.status + ' ' + JSON.stringify(e.response?.data));
    }

    // Step 3a: JWT via _is_native=true (current method)
    const renewResp = await axios.post(
      `${CLERK_BASE_URL}/v1/client/sessions/${sid}/tokens?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      {}, { headers: { Authorization: clientToken } }
    );
    const jwtNative = renewResp.data?.jwt;
    const nativeClaims = decodeJwtPayload(jwtNative);
    result.jwtNativeClaims = nativeClaims;
    result.steps.push('native JWT claims: ' + JSON.stringify(nativeClaims));

    // Step 3b: JWT WITHOUT _is_native (web-style)
    let jwtWeb: string | null = null;
    try {
      const webRenewResp = await axios.post(
        `${CLERK_BASE_URL}/v1/client/sessions/${sid}/tokens?_clerk_js_version=${CLERK_VERSION}`,
        {}, { headers: { Authorization: clientToken } }
      );
      jwtWeb = webRenewResp.data?.jwt;
      const webClaims = decodeJwtPayload(jwtWeb!);
      result.jwtWebClaims = webClaims;
      result.steps.push('web JWT claims: ' + JSON.stringify(webClaims));
    } catch(e: any) {
      result.steps.push('web JWT failed: ' + e.message);
    }

    // Solve captcha once (reuse for all tests)
    let captchaToken: string | null = null;
    if (CAPSOLVER_KEY) {
      // Try both task type names in case one isn't supported
      for (const taskType of ['HCaptchaTaskProxyLess', 'HCaptchaTask']) {
        try {
          const csResp = await axios.post('https://api.capsolver.com/createTask', {
            clientKey: CAPSOLVER_KEY,
            task: { type: taskType, websiteURL: 'https://suno.com/create', websiteKey: 'd65453de-3f1a-4aac-9366-a0f06e52b2ce' }
          });
          result.steps.push('CapSolver ' + taskType + ' response: ' + JSON.stringify(csResp.data));
          const taskId = csResp.data?.taskId;
          if (!taskId) { result.steps.push(taskType + ' no taskId, skipping'); continue; }
          for (let i = 0; i < 15; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const poll = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: CAPSOLVER_KEY, taskId });
            const sol = poll.data?.solution;
            const token = sol?.gRecaptchaResponse || sol?.token || sol?.answer;
            if (poll.data?.status === 'ready' && token) {
              captchaToken = token;
              result.steps.push('hCaptcha solved (' + taskType + '): ' + captchaToken!.substring(0, 30) + '...');
              break;
            }
          }
          if (captchaToken) break;
        } catch(e: any) {
          result.steps.push(taskType + ' error: ' + e.message + ' | body: ' + JSON.stringify(e.response?.data));
        }
      }
    }

    // Helper: test one generate variation
    async function testGenerate(label: string, jwt: string, extra: Record<string, any> = {}, headers: Record<string, string> = {}) {
      const baseHeaders: Record<string, string> = {
        'Authorization': `Bearer ${jwt}`,
        'Cookie': `__session=${jwt}`,
        'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
        'Content-Type': 'application/json',
        ...headers,
      };
      const body = { make_instrumental: false, mv: 'chirp-v3-5', prompt: 'test', generation_type: 'TEXT', tags: 'test', title: 'test', ...extra };
      try {
        const r = await axios.post(`${BASE_URL}/api/generate/v2/`, body, { headers: baseHeaders, timeout: 8000 });
        result[label] = { ok: true, clips: r.data?.clips?.length };
        result.steps.push(label + ' → 200 OK ✅');
      } catch(e: any) {
        result[label] = { ok: false, status: e.response?.status, error: e.response?.data };
        result.steps.push(label + ' → ' + e.response?.status + ': ' + JSON.stringify(e.response?.data));
      }
    }

    // Test matrix with native JWT
    await testGenerate('A_nativeJWT_noToken', jwtNative!);
    if (captchaToken) await testGenerate('B_nativeJWT_withToken', jwtNative!, { token: captchaToken });

    // Test with web JWT
    if (jwtWeb) {
      await testGenerate('C_webJWT_noToken', jwtWeb);
      if (captchaToken) await testGenerate('D_webJWT_withToken', jwtWeb, { token: captchaToken });
    }

    // Test v2-web endpoint with native JWT + token
    if (captchaToken) {
      try {
        const r = await axios.post(`${BASE_URL}/api/generate/v2-web/`,
          { make_instrumental: false, mv: 'chirp-v3-5', prompt: 'test', generation_type: 'TEXT', tags: 'test', title: 'test', token: captchaToken },
          { headers: { 'Authorization': `Bearer ${jwtNative}`, 'Cookie': `__session=${jwtNative}`, 'Content-Type': 'application/json' }, timeout: 8000 });
        result['E_v2web_withToken'] = { ok: true };
        result.steps.push('E_v2web_withToken → 200 OK ✅');
      } catch(e: any) {
        result['E_v2web_withToken'] = { ok: false, status: e.response?.status, error: e.response?.data };
        result.steps.push('E_v2web_withToken → ' + e.response?.status + ': ' + JSON.stringify(e.response?.data));
      }
    }

    return new NextResponse(JSON.stringify(result, null, 2), {
      status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch(e: any) {
    result.fatal = e.message;
    result.fatalResponse = e.response?.data;
    return new NextResponse(JSON.stringify(result, null, 2), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function OPTIONS(r: Request) {
  return new Response(null, { status: 200, headers: corsHeaders });
}
