// Probe the actual daemon catalog and the same C9 function used by the plugin.
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { createPaseoApi } from '@getpaseo/client';
import { federationAvailability } from '../../plugin/role-workflow/server/federation.ts';
const [target, home] = process.argv.slice(2);
const client = new DaemonClient({ url: `ws://${target}/ws`, clientId: 'airport-acceptance', clientType: 'cli', reconnect: { enabled: false } });
try {
  await client.connect();
  const api = createPaseoApi(client);
  const catalog = await api.providers.listAvailable();
  const availability = await federationAvailability(api, '', home);
  console.log(JSON.stringify({ catalog, availability }));
} finally { await client.close(); }
