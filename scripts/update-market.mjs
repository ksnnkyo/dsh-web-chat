import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Build an installable entry only from a verified, already-published package version. */
export function createMarketIndex(pkg, registry) {
  const published = registry?.versions?.[pkg.version];
  const timestamp = Date.parse(registry?.time?.[pkg.version] || '');
  if (registry?.name !== pkg.name || published?.name !== pkg.name || published?.version !== pkg.version ||
      published?.dsh?.manifestVersion !== 1 || published?.repository?.url !== pkg.repository.url || !Number.isFinite(timestamp)) {
    throw new Error('注册表尚无匹配的 dsh-web-chat 版本；请先发布正确的包，再更新索引。');
  }
  return {
    format: 1,
    title: { zh: 'dsh-web-chat 插件', en: 'dsh-web-chat plugins' },
    description: { zh: 'ksnnkyo 维护的 dsh-web-chat 插件索引。', en: 'dsh-web-chat plugin index maintained by ksnnkyo.' },
    plugins: [{
      name: pkg.name,
      title: { zh: 'dsh-web-chat', en: 'dsh-web-chat' },
      description: { zh: pkg.description, en: 'DeepSeek web conversations, local groups and reviewed handoff drafts in DeepSeek Harness.' },
      icon: 'icon.svg',
      author: typeof pkg.author === 'string' ? pkg.author : pkg.author.name,
      homepage: pkg.homepage,
      repository: { url: pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') },
      versions: [{ version: pkg.version, publishTimestamp: Math.floor(timestamp / 1000), source: { type: 'npm' }, engines: { dsh: pkg.engines.dsh } }],
    }],
  };
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const response = await fetch('https://registry.npmjs.org/' + encodeURIComponent(pkg.name), { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('无法读取 npm 发布记录（HTTP ' + response.status + '），未修改市场索引。');
  const index = createMarketIndex(pkg, await response.json());
  fs.writeFileSync(new URL('../docs/market/index.json', import.meta.url), JSON.stringify(index, null, 2) + '\n');
  console.log('已根据真实 npm 发布记录更新市场索引：' + pkg.name + '@' + pkg.version);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
