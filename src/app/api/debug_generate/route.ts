import { NextResponse, NextRequest } from "next/server";
import { corsHeaders } from "@/lib/utils";
import axios from 'axios';
import * as cookie from 'cookie';

// Debug endpoint - full chain: auth → captcha check → capsolver solve → generate
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const SUNO_COOKIE = process.env.SUNO_COOKIE || '';
  const CAPSOLVER_KEY = process.env.CAPSOLVER_KEY || '';
  const CLERK_BASE_URL = 'https://clerk.suno.com';
  const CLERK_VERSION = '5.15.0';
  const BASE_URL = 'https://studio-api.prod.suno.com';
  const AUTH_HEADERS = { 'x-suno-client': 'Android prerelease-4nt180t 1.0.42', 'Content-Type': 'application/json' };

  const result: any = { steps: [], capsolverKeySet: !!CAPSOLVER_KEY };

  try {
    // Step 1: Parse cookies
    const cookies = cookie.parse(SUNO_COOKIE.replace(/[\x00-\x1F\x7F]/g, ''));
    const clientToken = cookies['__client'];
    result.hasClientToken = !!clientToken;
    result.steps.push('parsed cookies OK');

    // Step 2: Get session ID
    const sessionResp = await axios.get(
      `${CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      { headers: { Authorization: clientToken } }
    );
    const sid = sessionResp.data?.response?.last_active_session_id;
    result.sessionId = sid ? sid.substring(0, 20) + '...' : 'NOT FOUND';
    result.steps.push('got session ID: ' + result.sessionId);

    // Step 3: Get JWT
    const renewResp = await axios.post(
      `${CLERK_BASE_URL}/v1/client/sessions/${sid}/tokens?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      {}, { headers: { Authorization: clientToken } }
    );
    const jwt = renewResp.data?.jwt;
    result.jwtOk = !!jwt;
    result.jwtPreview = jwt ? jwt.substring(0, 30) + '...' : 'NOT FOUND';
    result.steps.push('got JWT: ' + result.jwtPreview);

    const bearerHeaders = { ...AUTH_HEADERS, Authorization: `Bearer ${jwt}`, Cookie: `__session=${jwt}` };

    // Step 4: Check captcha requirement
    try {
      const captchaResp = await axios.post(`${BASE_URL}/api/c/check`,
        { ctype: 'generation' },
        { headers: bearerHeaders }
      );
      result.captchaCheck = captchaResp.data;
      result.steps.push('captcha check: ' + JSON.stringify(captchaResp.data));
    } catch(e: any) {
      result.captchaCheckError = { status: e.response?.status, data: e.response?.data };
      result.steps.push('captcha check FAILED: ' + e.message);
    }

    // Step 5: Solve Turnstile via CapSolver (wait for full result)
    let captchaToken: string | null = null;
    if (CAPSOLVER_KEY) {
      try {
        const csResp = await axios.post('https://api.capsolver.com/createTask', {
          clientKey: CAPSOLVER_KEY,
          task: { type: 'AntiTurnstileTaskProxyLess', websiteURL: 'https://suno.com/create', websiteKey: '0x4AAAAAABtnpJo7aKMs9JLQ' }
        });
        const taskId = csResp.data?.taskId;
        result.capsolverTaskId = taskId;
        result.steps.push('CapSolver task created: ' + taskId);

        // Poll up to 30s
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000));
          const poll = await axios.post('https://api.capsolver.com/getTaskResult', {
            clientKey: CAPSOLVER_KEY, taskId
          });
          result.capsolverLastStatus = poll.data?.status;
          if (poll.data?.status === 'ready' && poll.data?.solution?.token) {
            captchaToken = poll.data.solution.token;
            result.captchaTokenPreview = captchaToken!.substring(0, 40) + '...';
            result.steps.push('CapSolver solved! token preview: ' + result.captchaTokenPreview);
            break;
          }
        }
        if (!captchaToken) result.steps.push('CapSolver did NOT solve in time, last status: ' + result.capsolverLastStatus);
      } catch(e: any) {
        result.capsolverError = e.message;
        result.steps.push('CapSolver error: ' + e.message);
      }
    } else {
      result.steps.push('No CAPSOLVER_KEY set, skipping captcha solve');
    }

    // Step 6: Try generate WITHOUT token
    try {
      const genResp = await axios.post(`${BASE_URL}/api/generate/v2/`,
        { make_instrumental: false, mv: 'chirp-v4-5', prompt: 'test', generation_type: 'TEXT', tags: 'test', title: 'test' },
        { headers: bearerHeaders, timeout: 8000 }
      );
      result.generateNoToken = { ok: true, clips: genResp.data?.clips?.length };
      result.steps.push('generate WITHOUT token → 200 OK');
    } catch(e: any) {
      result.generateNoToken = { ok: false, status: e.response?.status, error: e.response?.data };
      result.steps.push('generate WITHOUT token → ' + e.response?.status + ': ' + JSON.stringify(e.response?.data));
    }

    // Step 7: Try generate WITH token (if we got one)
    if (captchaToken) {
      try {
        const genResp = await axios.post(`${BASE_URL}/api/generate/v2/`,
          { make_instrumental: false, mv: 'chirp-v4-5', prompt: 'test', generation_type: 'TEXT', tags: 'test', title: 'test', token: captchaToken },
          { headers: bearerHeaders, timeout: 8000 }
        );
        result.generateWithToken = { ok: true, clips: genResp.data?.clips?.length };
        result.steps.push('generate WITH token → 200 OK!');
      } catch(e: any) {
        result.generateWithToken = { ok: false, status: e.response?.status, error: e.response?.data };
        result.steps.push('generate WITH token → ' + e.response?.status + ': ' + JSON.stringify(e.response?.data));
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
