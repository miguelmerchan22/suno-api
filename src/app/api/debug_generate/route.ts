import { NextResponse, NextRequest } from "next/server";
import { corsHeaders } from "@/lib/utils";
import axios from 'axios';
import * as cookie from 'cookie';

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const SUNO_COOKIE = process.env.SUNO_COOKIE || '';
  const CLERK_BASE_URL = 'https://clerk.suno.com';
  const SUNO_BASE_URL = 'https://studio-api.prod.suno.com';
  const CLERK_VERSION = '5.15.0';
  const HCAPTCHA_SITEKEY = 'd65453de-3f1a-4aac-9366-a0f06e52b2ce';
  const t0 = Date.now();
  const ms = () => `+${Date.now() - t0}ms`;
  const result: any = { steps: [] };

  try {
    // Step 1: Auth
    const cookies = cookie.parse(SUNO_COOKIE.replace(/[\x00-\x1F\x7F]/g, ''));
    const clientToken = cookies['__client'];
    const sessionResp = await axios.get(
      `${CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      { headers: { Authorization: clientToken }, timeout: 8000 }
    );
    const sid = sessionResp.data?.response?.last_active_session_id;
    result.steps.push(`${ms()} session: ${sid ? 'OK' : 'NOT FOUND'}`);
    if (!sid) throw new Error('No session');

    const renewResp = await axios.post(
      `${CLERK_BASE_URL}/v1/client/sessions/${sid}/tokens?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      {}, { headers: { Authorization: clientToken }, timeout: 8000 }
    );
    const jwt = renewResp.data?.jwt;
    result.steps.push(`${ms()} JWT: ${jwt ? 'OK' : 'FAILED'}`);
    if (!jwt) throw new Error('No JWT');

    // Step 2: Test ALL CapSolver task types
    const capsolverKey = process.env.CAPSOLVER_KEY;
    result.capsolverKey = capsolverKey ? 'SET (len=' + capsolverKey.length + ')' : 'NOT SET';
    result.capsolver = {};

    if (capsolverKey && capsolverKey.trim()) {
      const taskTypes = [
        'HCaptchaEnterpriseTaskProxyLess',
        'HCaptchaTaskProxyLess',
        'HCaptchaTurboTask',
      ];

      for (const taskType of taskTypes) {
        result.steps.push(`${ms()} trying CapSolver ${taskType}...`);
        try {
          const createRes = await axios.post('https://api.capsolver.com/createTask', {
            clientKey: capsolverKey,
            task: {
              type: taskType,
              websiteURL: 'https://suno.com/create',
              websiteKey: HCAPTCHA_SITEKEY,
              isInvisible: true
            }
          }, { timeout: 10000 });

          result.capsolver[taskType] = {
            httpStatus: 200,
            body: createRes.data
          };
          result.steps.push(`${ms()} ${taskType} → errorId=${createRes.data?.errorId} taskId=${createRes.data?.taskId} err=${createRes.data?.errorDescription}`);
          // Don't poll - just capture the create response to see what's supported
        } catch(e: any) {
          result.capsolver[taskType] = {
            httpStatus: e.response?.status,
            body: e.response?.data,
            exception: e.message.substring(0, 100)
          };
          result.steps.push(`${ms()} ${taskType} HTTP ${e.response?.status}: ${JSON.stringify(e.response?.data).substring(0, 80)}`);
        }
      }
    }

    // Step 3: Captcha check
    try {
      const cResp = await axios.post(
        `${SUNO_BASE_URL}/api/c/check`,
        { ctype: 'generation' },
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Cookie: `__session=${jwt}`,
            'Content-Type': 'application/json'
          },
          timeout: 8000
        }
      );
      result.captchaRequired = cResp.data?.required;
      result.steps.push(`${ms()} captcha required=${cResp.data?.required}`);
    } catch(e: any) {
      result.steps.push(`${ms()} captcha check err: ${e.response?.status}`);
    }

    result.totalMs = Date.now() - t0;
    return new NextResponse(JSON.stringify(result, null, 2), {
      status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch(e: any) {
    result.fatal = e.message;
    result.totalMs = Date.now() - t0;
    return new NextResponse(JSON.stringify(result, null, 2), {
      status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function OPTIONS(r: Request) {
  return new Response(null, { status: 200, headers: corsHeaders });
}
