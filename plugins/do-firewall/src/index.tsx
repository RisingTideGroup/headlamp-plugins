import { registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { FirewallPage } from './FirewallPage';

// Two entry points to the same page. Inside a cluster (/c/<cluster>/do-firewall)
// the DO cluster is matched from the Headlamp cluster name and labels load
// from it. On the home screen (/do-firewall-home, no cluster) the page talks only
// to DigitalOcean: the break-glass path when this host's IP has fallen off the
// allowlist and Headlamp can no longer reach the cluster. Labels then show a
// warning; the allowlist still loads and saves.
registerSidebarEntry({
  parent: null,
  name: 'do-firewall',
  label: 'DO Firewall',
  url: '/do-firewall',
  icon: 'mdi:wall-fire',
});

registerRoute({
  path: '/do-firewall',
  sidebar: 'do-firewall',
  name: 'do-firewall',
  exact: true,
  component: () => <FirewallPage />,
});

// Headlamp keys plugin routes by path (redux/routesSlice.ts: routes[route.path]), so
// the home-screen route needs its own path; sharing '/do-firewall' let the second
// registration replace the first and the other entry 404'd.
registerSidebarEntry({
  parent: null,
  name: 'do-firewall-home',
  label: 'DO Firewall',
  url: '/do-firewall-home',
  useClusterURL: false,
  sidebar: 'HOME',
  icon: 'mdi:wall-fire',
});

registerRoute({
  path: '/do-firewall-home',
  sidebar: { item: 'do-firewall-home', sidebar: 'HOME' },
  name: 'do-firewall-home',
  exact: true,
  useClusterURL: false,
  noAuthRequired: true,
  component: () => <FirewallPage />,
});
