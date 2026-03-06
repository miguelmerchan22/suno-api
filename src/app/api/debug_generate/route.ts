import { NextResponse, NextRequest } from "next/server";
import { corsHeaders } from "@/lib/utils";
import axios from 'axios';
import * as cookie from 'cookie';
import { chromium } from 'rebrowser-playwright-core';

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

    // CapSolver doesn't support hCaptcha - skip it, go straight to browser test

    // Test browser launch + navigate to suno.com/create
    try {
      result.steps.push('launching Chromium...');
      const browser = await chromium.launch({
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--enable-unsafe-swiftshader'],
        headless: true
      });
      result.steps.push('Chromium launched OK');
      const ctx = await browser.newContext();
      // load cookies
      await ctx.addCookies([
        { name: '__client', value: cookies['__client'] || '', domain: '.suno.com', path: '/' },
        { name: '__session', value: jwtNative || '', domain: '.suno.com', path: '/' }
      ]);
      const page = await ctx.newPage();

      // Intercept generate/v2 request
      let interceptedToken: string | null = null;
      const captureP = new Promise<void>((res) => {
        page.route('**/api/generate/v2/**', async (route) => {
          try { interceptedToken = route.request().postDataJSON()?.token || 'EMPTY'; } catch(e) { interceptedToken = 'PARSE_ERROR'; }
          route.abort();
          res();
        });
      });

      result.steps.push('navigating to suno.com/create...');
      await page.goto('https://suno.com/create', { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {});
      const finalUrl = page.url();
      const pageTitle = await page.title();
      result.pageUrl = finalUrl;
      result.pageTitle = pageTitle;
      result.steps.push('final URL: ' + finalUrl + ' | title: ' + pageTitle);

      // Check what elements exist
      const hasCustomTextarea = await page.locator('.custom-textarea').count();
      const hasAnyTextarea = await page.locator('textarea').count();
      const hasCreateBtn = await page.locator('button[aria-label="Create"]').count();
      const hasLoginBtn = await page.locator('button:has-text("Sign in"), a:has-text("Log in"), [data-testid="login"]').count();
      result.elements = { hasCustomTextarea, hasAnyTextarea, hasCreateBtn, hasLoginBtn };
      result.steps.push('elements: textarea=' + hasCustomTextarea + ' anyTextarea=' + hasAnyTextarea + ' createBtn=' + hasCreateBtn + ' loginBtn=' + hasLoginBtn);

      // Try clicking create if elements found
      if (hasCustomTextarea > 0 && hasCreateBtn > 0) {
        try { await page.getByLabel('Close').click({ timeout: 1500 }); } catch(e) {}
        const ta = page.locator('.custom-textarea').first();
        await ta.click({ timeout: 5000 });
        await ta.pressSequentially('test', { delay: 50 });
        page.locator('button[aria-label="Create"] div.flex').click().catch(() => {});
        await Promise.race([captureP, new Promise(r => setTimeout(r, 15000))]);
      } else {
        result.steps.push('skipping create click - elements not found');
      }

      result.browserToken = interceptedToken;
      const tok = interceptedToken as string | null;
      result.steps.push('browser token: ' + (tok ? tok.substring(0, 30) + '...' : 'null'));
      await browser.close();
    } catch(e: any) {
      result.steps.push('browser test error: ' + e.message);
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
