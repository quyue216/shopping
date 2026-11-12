import SwaggerParser from '@apidevtools/swagger-parser';
const url = new URL('../docs/openapi.json', import.meta.url);
const { fileURLToPath } = await import('node:url');
const api = await SwaggerParser.validate(fileURLToPath(url));
console.log(`OpenAPI ${api.openapi} 校验通过：${Object.keys(api.paths).length} 条路径`);
