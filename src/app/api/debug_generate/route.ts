import { NextResponse, NextRequest } from "next/server";
import { corsHeaders } from "@/lib/utils";
import axios from 'axios';
import cookie from 'cookie';

// Temporary debug endpoint - shows raw Suno API response and JWT details
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const SUNO_COOKIE = process.env.SUNO_COOKIE || '';
  const CLERK_BASE_URL = 'https://clerk.suno.com';
  const CLERK_VERSION = '5.15.0';
  const BASE_URL = 'https://studio-api.prod.suno.com';

  const cookies = cookie.parse(SUNO_COOKIE.replace(/[\x00-\x1F\x7F]/g, ''));
  const clientToken = cookies['__client'];

  const debug: any = {
    hasSunoCookie: !!SUNO_COOKIE,
    hasClientToken: !!clientToken,
    clientTokenPreview: clientToken ? clientToken.substring(0, 20) + '...' : null,
    steps: []
  };

  try {
    // Step 1: Get session ID
    debug.steps.push('Getting session ID from Clerk...');
    const sessionResp = await axios.get(
      `${CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      { headers: { Authorization: clientToken } }
    );
    const sid = sessionResp.data?.response?.last_active_session_id;
    debug.sessionId = sid ? sid.substring(0, 15) + '...' : null;
    debug.steps.push(`Got session ID: ${debug.sessionId}`);

    if (!sid) {
      return new NextResponse(JSON.stringify({ debug, error: 'No session ID' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // Step 2: Get JWT
    debug.steps.push('Getting JWT from Clerk keepAlive...');
    const renewResp = await axios.post(
      `${CLERK_BASE_URL}/v1/client/sessions/${sid}/tokens?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      {},
      { headers: { Authorization: clientToken } }
    );
    const jwt = renewResp.data?.jwt;
    debug.jwtPreview = jwt ? jwt.substring(0, 30) + '...' : null;
    debug.jwtLength = jwt ? jwt.length : 0;
    debug.steps.push(`Got JWT: ${debug.jwtPreview}`);

    if (!jwt) {
      return new NextResponse(JSON.stringify({ debug, error: 'No JWT from keepAlive' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // Step 3: Check captcha requirement
    debug.steps.push('Checking captcha requirement...');
    const captchaCheckResp = await axios.post(
      `${BASE_URL}/api/c/check`,
      { ctype: 'generation' },
      {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Cookie: `__client=${clientToken}`,
          'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
          'Content-Type': 'application/json'
        }
      }
    );
    debug.captchaRequired = captchaCheckResp.data;
    debug.steps.push(`Captcha check: ${JSON.stringify(captchaCheckResp.data)}`);

    // Step 4: Try generate WITHOUT token to see full error
    debug.steps.push('Attempting generate without captcha token...');
    try {
      const payload = {
        make_instrumental: false,
        mv: 'chirp-v4-5',
        prompt: 'test',
        generation_type: 'TEXT',
        tags: 'test',
        title: 'test',
        // No token field
      };
      const generateResp = await axios.post(
        `${BASE_URL}/api/generate/v2/`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${jwt}`,
            Cookie: `__client=${clientToken}`,
            'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      debug.generateSuccess = true;
      debug.generateResponse = generateResp.data;
    } catch (genErr: any) {
      debug.generateError = {
        status: genErr.response?.status,
        data: genErr.response?.data,
        headers: genErr.response?.headers ? Object.fromEntries(Object.entries(genErr.response.headers).slice(0, 10)) : null
      };
      debug.steps.push(`Generate failed: ${genErr.response?.status} ${JSON.stringify(genErr.response?.data)}`);
    }

    return new NextResponse(JSON.stringify(debug, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (err: any) {
    debug.fatalError = err.message;
    debug.fatalStack = err.response?.data;
    return new NextResponse(JSON.stringify(debug, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 200, headers: corsHeaders });
}
