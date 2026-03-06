import { NextResponse, NextRequest } from "next/server";
import { sunoApi } from "@/lib/SunoApi";
import { corsHeaders } from "@/lib/utils";
import axios from 'axios';
import cookie from 'cookie';

// Temporary debug endpoint to diagnose token validation issues
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const debug: any = {
    timestamp: new Date().toISOString(),
    steps: [],
    errors: []
  };

  try {
    // Step 1: Initialize sunoApi (getAuthToken + keepAlive)
    debug.steps.push('Initializing sunoApi...');
    const SUNO_COOKIE = process.env.SUNO_COOKIE || '';
    debug.hasSunoCookie = !!SUNO_COOKIE;
    debug.cookieKeys = Object.keys(cookie.parse(SUNO_COOKIE));

    const api = await sunoApi(SUNO_COOKIE);
    debug.steps.push('sunoApi initialized OK');

    // Step 2: Get captcha info (without solving)
    debug.steps.push('Getting captcha info...');
    const captchaResult = await api.getCaptcha();
    debug.captchaToken = captchaResult ? captchaResult.substring(0, 30) + '...' : null;
    debug.captchaNull = captchaResult === null;
    debug.steps.push(`getCaptcha result: ${captchaResult ? 'got token' : 'null/no captcha'}`);

    // Step 3: Try the generate API directly with minimal payload + captcha token
    debug.steps.push('Attempting raw generate request...');

    // Access internals via keepAlive
    await (api as any).keepAlive();

    const jwt = (api as any).currentToken;
    debug.hasJwt = !!jwt;
    debug.jwtPreview = jwt ? jwt.substring(0, 30) + '...' : null;
    debug.jwtLength = jwt ? jwt.length : 0;

    const cookies = (api as any).cookies;
    debug.cookieKeys2 = Object.keys(cookies);

    const BASE_URL = 'https://studio-api.prod.suno.com';

    // Check captcha required
    try {
      const checkResp = await axios.post(`${BASE_URL}/api/c/check`,
        { ctype: 'generation' },
        {
          headers: {
            'Authorization': `Bearer ${jwt}`,
            'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
            'X-Requested-With': 'com.suno.android',
            'Content-Type': 'application/json'
          }
        }
      );
      debug.captchaCheckResponse = checkResp.data;
    } catch(e: any) {
      debug.captchaCheckError = { status: e.response?.status, data: e.response?.data };
    }

    // Attempt generate WITHOUT token
    try {
      const payload = {
        make_instrumental: false,
        mv: 'chirp-v4-5',
        prompt: 'test song',
        generation_type: 'TEXT',
        tags: 'test',
        title: 'debug test'
      };
      const genResp = await axios.post(`${BASE_URL}/api/generate/v2/`, payload, {
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
          'X-Requested-With': 'com.suno.android',
          'Content-Type': 'application/json'
        },
        timeout: 8000
      });
      debug.generateNoToken = { success: true, data: genResp.data };
    } catch(e: any) {
      debug.generateNoToken = {
        success: false,
        status: e.response?.status,
        data: e.response?.data,
        headers: e.response?.headers ? {
          'content-type': e.response.headers['content-type'],
          'x-request-id': e.response.headers['x-request-id']
        } : null
      };
    }

    // If we have a captcha token, also try WITH it
    if (captchaResult) {
      try {
        const payloadWithToken = {
          make_instrumental: false,
          mv: 'chirp-v4-5',
          prompt: 'test song',
          generation_type: 'TEXT',
          tags: 'test',
          title: 'debug test',
          token: captchaResult
        };
        const genResp2 = await axios.post(`${BASE_URL}/api/generate/v2/`, payloadWithToken, {
          headers: {
            'Authorization': `Bearer ${jwt}`,
            'x-suno-client': 'Android prerelease-4nt180t 1.0.42',
            'X-Requested-With': 'com.suno.android',
            'Content-Type': 'application/json'
          },
          timeout: 8000
        });
        debug.generateWithToken = { success: true, data: genResp2.data };
      } catch(e: any) {
        debug.generateWithToken = {
          success: false,
          status: e.response?.status,
          data: e.response?.data
        };
      }
    }

    return new NextResponse(JSON.stringify(debug, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });

  } catch (err: any) {
    debug.fatalError = err.message;
    debug.fatalStack = err.stack?.split('\n').slice(0, 5).join('\n');
    return new NextResponse(JSON.stringify(debug, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 200, headers: corsHeaders });
}
