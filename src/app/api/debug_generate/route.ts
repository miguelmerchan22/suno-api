import { NextResponse, NextRequest } from "next/server";
import { corsHeaders } from "@/lib/utils";
import axios from 'axios';
import * as cookie from 'cookie';
import { chromium } from 'rebrowser-playwright-core';

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const SUNO_COOKIE = process.env.SUNO_COOKIE || '';
  const CLERK_BASE_URL = 'https://clerk.suno.com';
  const CLERK_VERSION = '5.15.0';
  const t0 = Date.now();
  const ms = () => `+${Date.now() - t0}ms`;
  const result: any = { steps: [] };

  try {
    // Quick auth - get JWT
    const cookies = cookie.parse(SUNO_COOKIE.replace(/[\x00-\x1F\x7F]/g, ''));
    const clientToken = cookies['__client'];
    result.steps.push(`${ms()} auth start`);
    const sessionResp = await axios.get(
      `${CLERK_BASE_URL}/v1/client?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      { headers: { Authorization: clientToken } }
    );
    const sid = sessionResp.data?.response?.last_active_session_id;
    result.steps.push(`${ms()} session: ${sid ? 'OK' : 'NOT FOUND'}`);
    if (!sid) throw new Error('No session');

    const renewResp = await axios.post(
      `${CLERK_BASE_URL}/v1/client/sessions/${sid}/tokens?_is_native=true&_clerk_js_version=${CLERK_VERSION}`,
      {}, { headers: { Authorization: clientToken } }
    );
    const jwt = renewResp.data?.jwt;
    result.steps.push(`${ms()} JWT: ${jwt ? 'OK' : 'FAILED'}`);

    // Browser test
    result.steps.push(`${ms()} launching Chromium...`);
    const browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--enable-unsafe-swiftshader'],
      headless: true
    });
    result.steps.push(`${ms()} Chromium OK`);

    const ctx = await browser.newContext();
    await ctx.addCookies([
      { name: '__client', value: clientToken || '', domain: '.suno.com', path: '/', sameSite: 'Lax' },
      { name: '__session', value: jwt || '', domain: '.suno.com', path: '/', sameSite: 'Lax' }
    ]);
    const page = await ctx.newPage();
    result.steps.push(`${ms()} context+page ready`);

    // Intercept generate/v2 to capture hCaptcha token
    let interceptedToken: string | null = null;
    const captureP = new Promise<void>((res) => {
      page.route('**/api/generate/v2/**', async (route) => {
        try { interceptedToken = route.request().postDataJSON()?.token || 'EMPTY'; } catch(e) { interceptedToken = 'ERROR'; }
        route.abort();
        res();
      });
    });

    // Navigate
    result.steps.push(`${ms()} navigating to suno.com/create...`);
    await page.goto('https://suno.com/create', {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    }).catch((e: any) => result.steps.push(`${ms()} goto catch: ${e.message.substring(0, 80)}`));
    result.steps.push(`${ms()} after goto, url: ${page.url().substring(0, 100)}`);

    // Fixed 20s wait — covers Clerk handshake redirect + React render
    result.steps.push(`${ms()} sleeping 20s for Clerk handshake + React...`);
    await new Promise(r => setTimeout(r, 20000));
    result.steps.push(`${ms()} awake, url now: ${page.url().substring(0, 100)}`);

    const url = page.url();
    const title = await page.title().catch(() => '?');
    result.url = url.substring(0, 100);
    result.title = title;
    result.steps.push(`${ms()} title: ${title}`);

    // Count key elements
    const counts: any = {};
    for (const [name, sel] of [
      ['custom-textarea', '.custom-textarea'],
      ['textarea', 'textarea'],
      ['create-btn', 'button[aria-label="Create"]'],
      ['sign-in', 'text=Sign in'],
      ['sign-up', 'text=Sign up'],
    ] as [string, string][]) {
      counts[name] = await page.locator(sel).count().catch(() => -1);
    }
    result.elements = counts;
    result.steps.push(`${ms()} elements: ${JSON.stringify(counts)}`);

    // If logged in UI found, trigger create
    if (counts['custom-textarea'] > 0 && counts['create-btn'] > 0) {
      result.steps.push(`${ms()} UI found! triggering create...`);
      try { await page.getByLabel('Close').click({ timeout: 1000 }); } catch(e) {}
      const ta = page.locator('.custom-textarea').first();
      await ta.click({ timeout: 3000 }).catch(() => {});
      await ta.pressSequentially('test', { delay: 50 });
      page.locator('button[aria-label="Create"] div.flex').click().catch(() => {});
      await Promise.race([captureP, new Promise(r => setTimeout(r, 8000))]);
      result.steps.push(`${ms()} after create race`);
      const tok = interceptedToken as string | null;
      result.browserToken = tok ? tok.substring(0, 40) + '...' : null;
      result.steps.push(`${ms()} token: ${tok ? tok.substring(0, 30) + '...' : 'null'}`);
    }

    await browser.close();
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
