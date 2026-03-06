import { NextResponse, NextRequest } from "next/server";
import { corsHeaders } from "@/lib/utils";
import axios from 'axios';
import cookie from 'cookie';

// Quick debug endpoint - tests auth and one generate call without waiting for captcha
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const SUNO_COOKIE = process.env.SUNO_COOKIE || '';
  const CLERK_BASE_URL = 'https://clerk.suno.com';
  const CLERK_VERSION = '5.15.0';
  const BASE_URL = 'https://studio-api.prod.suno.com';

  const result: any = { steps: [] };

  try {
    const cookies = cookie.parse(SUNO_COOKIE.replace(/[\x00-\x1F\x7F]/g, ''));
    const clientToken = cookies['__client'];
    result.hasClientToken = !!clientToken;
    result.steps.push('parsed cookies OK');

    // Get session ID
    const sessionResp = await axios.get(
      `${CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      { headers: { Authorization: clientToken } }
    );
    const sid = sessionResp.data?.response?.last_active_session_id;
    result.sessionId = sid ? sid.substring(0, 20) + '...' : 'NOT FOUND';
    result.steps.push('got session ID: ' + result.sessionId);

    // Get JWT
    const renewResp = await axios.post(
      `${CLERK_BASE_URL}/v1/client/sessions/${sid}/tokens?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      {}, { headers: { Authorization: clientToken } }
    );
    const jwt = renewResp.data?.jwt;
    result.jwtOk = !!jwt;
    result.jwtPreview = jwt ? jwt.substring(0, 30) + '...' : 'NOT FOUND';
    result.steps.push('got JWT: ' + result.jwtPreview);

    // Check captcha requirement
    const captchaResp = await axios.post(`${BASE_URL}/api/c/check`,
      { ctype: 'generation' },
      { headers: { 'Authorization': `Bearer ${jwt}`, 'x-suno-client': 'Android prerelease-4nt180t 1.0.42', 'Content-Type': 'application/json' } }
    );
    result.captchaCheck = captchaResp.data;
    result.steps.push('captcha check: ' + JSON.stringify(captchaResp.data));

    // Quick CapSolver test (create task only - don't wait for result)
    const capsolverKey = process.env.CAPSOLVER_KEY;
    if (capsolverKey) {
      const csResp = await axios.post('https://api.capsolver.com/createTask', {
        clientKey: capsolverKey,
        task: { type: 'AntiTurnstileTaskProxyLess', websiteURL: 'https://suno.com/create', websiteKey: '0x4AAAAAABtnpJo7aKMs9JLQ' }
      });
      result.capsolverTaskId = csResp.data?.taskId;
      result.steps.push('CapSolver task created: ' + result.capsolverTaskId);
    }

    // Test generate WITHOUT token
    try {
      const genResp = await axios.post(`${BASE_URL}/api/generate/v2/`,
        { make_instrumental: false, mv: 'chirp-v4-5', prompt: 'test', generation_type: 'TEXT', tags: 'test', title: 'test' },
        { headers: { 'Authorization': `Bearer ${jwt}`, 'x-suno-client': 'Android prerelease-4nt180t 1.0.42', 'Content-Type': 'application/json' }, timeout: 8000 }
      );
      result.generateNoToken = { ok: true, clips: genResp.data?.clips?.length };
    } catch(e: any) {
      result.generateNoToken = { ok: false, status: e.response?.status, error: e.response?.data };
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
