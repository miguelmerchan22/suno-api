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
  const t0 = Date.now();
  const ms = () => `+${Date.now() - t0}ms`;
  const result: any = { steps: [] };

  try {
    // Step 1: Auth
    const cookies = cookie.parse(SUNO_COOKIE.replace(/[\x00-\x1F\x7F]/g, ''));
    const clientToken = cookies['__client'];
    result.steps.push(`${ms()} auth start, clientToken length: ${clientToken?.length ?? 0}`);

    const sessionResp = await axios.get(
      `${CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      { headers: { Authorization: clientToken }, timeout: 8000 }
    );
    const sid = sessionResp.data?.response?.last_active_session_id;
    result.steps.push(`${ms()} session: ${sid ? 'OK sid=' + sid.substring(0, 20) : 'NOT FOUND'}`);
    if (!sid) throw new Error('No session');

    const renewResp = await axios.post(
      `${CLERK_BASE_URL}/v1/client/sessions/${sid}/tokens?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      {}, { headers: { Authorization: clientToken }, timeout: 8000 }
    );
    const jwt = renewResp.data?.jwt;
    result.steps.push(`${ms()} JWT: ${jwt ? 'OK len=' + jwt.length : 'FAILED'}`);
    if (!jwt) throw new Error('No JWT');

    // Step 2: Check captcha required
    result.steps.push(`${ms()} checking captcha required...`);
    try {
      const cResp = await axios.post(
        `${SUNO_BASE_URL}/api/c/check`,
        { ctype: 'generation' },
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Cookie: `__session=${jwt}; __client=${clientToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 8000
        }
      );
      result.captchaCheck = cResp.data;
      result.steps.push(`${ms()} captcha check: required=${cResp.data?.required}`);
    } catch(e: any) {
      result.steps.push(`${ms()} captcha check err: ${e.response?.status} ${e.message.substring(0, 60)}`);
    }

    // Step 3: Try generate with null token — see exact error
    result.steps.push(`${ms()} trying generate/v2 with null token...`);
    try {
      const genResp = await axios.post(
        `${SUNO_BASE_URL}/api/generate/v2/`,
        {
          prompt: '',
          gpt_description_prompt: 'a happy test song',
          make_instrumental: false,
          mv: 'chirp-crow',
          generation_type: 'TEXT',
          token: null
        },
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Cookie: `__session=${jwt}; __client=${clientToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'x-suno-client': 'Android prerelease-4nt180t 1.0.42'
          },
          timeout: 10000
        }
      );
      result.generateSuccess = true;
      result.generateStatus = genResp.status;
      result.generateData = genResp.data;
      result.steps.push(`${ms()} generate SUCCESS: ${genResp.status}`);
    } catch(e: any) {
      result.generateSuccess = false;
      result.generateStatus = e.response?.status;
      result.generateError = e.response?.data;
      result.steps.push(`${ms()} generate err: ${e.response?.status} ${JSON.stringify(e.response?.data).substring(0, 120)}`);
    }

    // Step 4: Try with empty string token
    result.steps.push(`${ms()} trying generate/v2 with empty string token...`);
    try {
      const genResp2 = await axios.post(
        `${SUNO_BASE_URL}/api/generate/v2/`,
        {
          prompt: '',
          gpt_description_prompt: 'a happy test song',
          make_instrumental: false,
          mv: 'chirp-crow',
          generation_type: 'TEXT',
          token: ''
        },
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Cookie: `__session=${jwt}; __client=${clientToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'x-suno-client': 'Android prerelease-4nt180t 1.0.42'
          },
          timeout: 10000
        }
      );
      result.generate2Success = true;
      result.generate2Status = genResp2.status;
      result.generate2Data = genResp2.data;
      result.steps.push(`${ms()} generate2 SUCCESS: ${genResp2.status}`);
    } catch(e: any) {
      result.generate2Success = false;
      result.generate2Status = e.response?.status;
      result.generate2Error = e.response?.data;
      result.steps.push(`${ms()} generate2 err: ${e.response?.status} ${JSON.stringify(e.response?.data).substring(0, 120)}`);
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
