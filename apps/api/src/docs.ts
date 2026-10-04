import { openapiYaml } from './contract.generated';

const swaggerHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Photobooth API · Swagger</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui.css" integrity="sha384-+yyzNgM3K92sROwsXxYCxaiLWxWJ0G+v/9A+qIZ2rgefKgkdcmJI+L601cqPD/Ut" crossorigin="anonymous">
<style>body{margin:0} .topbar{display:none}</style></head>
<body><div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-bundle.js" integrity="sha384-qn5tagrAjZi8cSmvZ+k3zk4+eDEEUcP9myuR2J6V+/H6rne++v6ChO7EeHAEzqxQ" crossorigin="anonymous"></script>
<script src="https://unpkg.com/swagger-ui-dist@5.11.0/swagger-ui-standalone-preset.js" integrity="sha384-SiLF+uYBf9lVQW98s/XUYP14enXJN31bn0zu3BS1WFqr5hvnMF+w132WkE/v0uJw" crossorigin="anonymous"></script>
<script>window.onload=function(){window.ui=SwaggerUIBundle({url:'/openapi.yaml',dom_id:'#swagger-ui',deepLinking:true,presets:[SwaggerUIBundle.presets.apis,SwaggerUIStandalonePreset],layout:'StandaloneLayout',withCredentials:true,persistAuthorization:false});};</script>
</body></html>`;

export function docsRoute(request: Request, path: string): Response | null {
  if (request.method !== 'GET') return null;
  if (path === '/docs' || path === '/docs/') return new Response(swaggerHtml, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'self' 'unsafe-inline' https://unpkg.com; script-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data:; connect-src 'self'; font-src https://unpkg.com; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' }
  });
  if (path === '/openapi.yaml') return new Response(openapiYaml, {
    headers: { 'content-type': 'application/yaml; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  });
  return null;
}
