import { NextResponse, NextRequest } from "next/server";
import { corsHeaders } from "@/lib/utils";
import axios from 'axios';
import * as cookie from 'cookie';
import { Solver } from '@2captcha/captcha-solver';

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
  const result: any = { version: 'v7-2captcha', steps: [] };

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

    // Step 2: Test 2captcha hCaptcha solving
    const twocaptchaKey = process.env.TWOCAPTCHA_KEY;
    result.twocaptchaKey = twocaptchaKey ? `SET (len=${twocaptchaKey.length})` : 'NOT SET';

    if (twocaptchaKey && twocaptchaKey.trim() && twocaptchaKey !== 'undefined') {
      result.steps.push(`${ms()} solving hCaptcha via 2captcha...`);
      try {
        const solver = new Solver(twocaptchaKey);
        const solved = await solver.hcaptcha({
          pageurl: 'https://suno.com/create',
          sitekey: HCAPTCHA_SITEKEY
        });
        const token = solved?.data;
        result.hcaptchaToken = token ? token.substring(0, 60) + '...' : null;
        result.steps.push(`${ms()} 2captcha solved! token=${token ? token.substring(0, 30) + '...' : 'null'}`);

        if (token) {
          // Step 3: Try generate with real hCaptcha token
          result.steps.push(`${ms()} calling generate/v2 with real token...`);
          try {
            const genResp = await axios.post(
              `${SUNO_BASE_URL}/api/generate/v2/`,
              {
                prompt: '',
                gpt_description_prompt: 'a happy upbeat test song',
                make_instrumental: false,
                mv: 'chirp-crow',
                generation_type: 'TEXT',
                token: token
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
            result.generateClips = genResp.data?.clips?.length;
            result.steps.push(`${ms()} GENERATE SUCCESS! status=${genResp.status} clips=${genResp.data?.clips?.length}`);
          } catch(e: any) {
            result.generateSuccess = false;
            result.generateStatus = e.response?.status;
            result.generateError = e.response?.data;
            result.steps.push(`${ms()} generate err: ${e.response?.status} ${JSON.stringify(e.response?.data).substring(0, 100)}`);
          }
        }
      } catch(e: any) {
        result.twocaptchaError = e.message;
        result.steps.push(`${ms()} 2captcha err: ${e.message.substring(0, 100)}`);
      }
    } else {
      result.steps.push(`${ms()} TWOCAPTCHA_KEY not set — add it in Render environment`);
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
