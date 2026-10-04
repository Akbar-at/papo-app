import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';

const state = await mkdtemp(join(tmpdir(),'papo-admin-ui-'));
const port = randomInt(20000,40000);
const origin = `http://127.0.0.1:${port}`;
let server, browser;
let serverErrors = '';
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function startServer() {
  server = spawn(process.execPath,['--import','tsx','dev/local-server.ts'],{
    cwd:new URL('../apps/api/',import.meta.url),
    env:{...process.env,PHOTOBOOTH_DEV_DATA_DIR:state,PORT:String(port),PAPO_ADMIN_EMAIL:'admin@papo.local',PAPO_ADMIN_PASSWORD:'Browser-smoke-password-2026'},
    stdio:['ignore','pipe','pipe']
  });
  server.stderr.on('data',bytes=>{serverErrors+=String(bytes).slice(0,2000);});
  for(let attempt=0;attempt<200;attempt++) {
    if(server.exitCode!==null) throw new Error(`Server failed: ${serverErrors}`);
    try {if((await fetch(`${origin}/healthz`)).ok)return;}catch{}
    await sleep(100);
  }
  throw new Error(`Server readiness failed: ${serverErrors}`);
}
async function stopServer() {
  if(!server || server.exitCode!==null)return;
  const exited = new Promise(resolve=>server.once('exit',resolve));server.kill('SIGTERM');await exited;
}
try {
  await startServer();
  const admin = JSON.parse(await readFile(join(state,'admin.json'),'utf8'));
  browser = await chromium.launch({headless:true,executablePath:process.env.PAPO_BROWSER_EXECUTABLE ?? (!process.env.CI && existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined)});
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  await page.goto(origin);
  await expect(page.getByRole('heading',{name:'Welcome back.'})).toBeVisible();
  await page.getByLabel('Email',{exact:true}).fill(admin.email);
  await page.getByLabel('Password',{exact:true}).fill(admin.password);
  await page.getByRole('button',{name:'Sign in',exact:false}).click();
  await expect(page.locator('#app-view')).toBeVisible();
  const session=(await context.cookies()).find(cookie=>cookie.name==='papo_local_session');assert.ok(session?.httpOnly);
  assert.equal(await page.evaluate(()=>document.cookie),'');
  const nav=page.getByRole('navigation');
  await nav.getByRole('button',{name:'Booths',exact:true}).click();
  const boothForm=page.locator('#booth-form');
  await boothForm.getByLabel('Booth name').fill('Browser smoke booth');
  await boothForm.getByRole('button',{name:'Register booth'}).click();
  await expect(page.locator('#booth-result code')).toBeVisible();
  const device=await page.locator('#booth-result code').textContent();
  await nav.getByRole('button',{name:'Frames',exact:true}).click();
  const frameForm=page.locator('#frame-form');
  await frameForm.getByLabel('Frame name').fill('Browser smoke frame');
  await frameForm.getByLabel('Photo slots').selectOption('4');
  await frameForm.getByRole('button',{name:'Create frame'}).click();
  await expect(page.locator('#frame-list')).toContainText('Browser smoke frame');
  await nav.getByRole('button',{name:'Configuration',exact:true}).click();
  const configForm=page.locator('#config-form');
  await expect(configForm.locator('select[name=booth_id] option:checked')).toHaveText('Browser smoke booth');
  await configForm.getByLabel('Browser smoke frame').check();
  await configForm.getByLabel('Price (Rp)').fill('30000');
  await configForm.getByRole('button',{name:'Publish configuration'}).click();
  await expect(page.locator('#config-result')).toContainText('Version 1 published');
  await nav.getByRole('button',{name:'Vouchers',exact:true}).click();
  await page.locator('#voucher-form').getByRole('button',{name:'Issue voucher'}).click();
  await expect(page.locator('#voucher-result code')).toBeVisible();
  const voucher=await page.locator('#voucher-result code').textContent();
  const configResponse=await fetch(`${origin}/v1/device/configuration`,{headers:{authorization:`Bearer ${device}`}});
  assert.equal(configResponse.status,200);const configuration=await configResponse.json();
  assert.equal(configuration.price_idr,30000);assert.ok(configuration.frames.some(frame=>frame.manifest.slots===4));
  const authorized=await fetch(`${origin}/v1/device/sessions`,{method:'POST',headers:{authorization:`Bearer ${device}`,'content-type':'application/json'},body:JSON.stringify({client_session_id:crypto.randomUUID(),authorization:{kind:'voucher',code:voucher}})});
  assert.equal(authorized.status,201);
  // A fresh process must retain users, sessions, booths and published versions.
  await stopServer();await startServer();await page.reload();
  await expect(page.locator('#app-view')).toBeVisible();
  await nav.getByRole('button',{name:'Vouchers',exact:true}).click();
  await expect(page.locator('#voucher-list')).toContainText('Redeemed');
  await nav.getByRole('button',{name:'Overview',exact:true}).click();
  await expect(page.locator('#booth-count')).toHaveText('2');
  await mkdir(new URL('../.local/',import.meta.url),{recursive:true});
  await page.screenshot({path:new URL('../.local/admin-overview.png',import.meta.url).pathname,fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile layout must fit the viewport');
  await nav.getByRole('button',{name:'Account',exact:true}).click();
  const account=page.locator('#password-form');
  await account.getByLabel('Current password',{exact:true}).fill(admin.password);
  await account.getByLabel('New password',{exact:true}).fill('Changed-browser-password-2026');
  await account.getByRole('button',{name:'Change password'}).click();
  await expect(page.locator('#login-view')).toBeVisible();
  await page.getByLabel('Email',{exact:true}).fill(admin.email);
  await page.getByLabel('Password',{exact:true}).fill('Changed-browser-password-2026');
  await page.getByRole('button',{name:'Sign in',exact:false}).click();
  await expect(page.locator('#app-view')).toBeVisible();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.locator('#login-view')).toBeVisible();await page.reload();
  await expect(page.locator('#login-view')).toBeVisible();assert.deepEqual(pageErrors,[]);
  console.log('PASS: browser sign-in, booth, frame, configuration, voucher redemption, restart persistence, mobile layout, password change and sign-out');
} finally {
  if(browser)await browser.close();await stopServer();await rm(state,{recursive:true,force:true});
}
