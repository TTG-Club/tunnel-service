/**
 * Слаги, которые нельзя отдавать пользователям: технические имена хостов,
 * будущие сервисные поддомены и всё, что похоже на «официальное».
 *
 * Список намеренно с запасом: добавить имя сюда бесплатно, а отобрать уже
 * выданный адрес — нет.
 */
const RESERVED = [
  // из задания
  'www', 'api', 'admin', 'mail', 'ns1', 'ns2', 'cdn', 'static', 'assets',
  'play', 'node', 'nodes', 'status', 'help', 'support', 'docs', 'blog',
  'shop', 'billing', 'auth', 'account', 'login', 'register', 'update',
  'dev', 'test', 'staging', 'demo', 'smtp', 'imap',

  // инфраструктура и почта
  'ns', 'ns3', 'ns4', 'dns', 'mx', 'pop', 'pop3', 'webmail', 'email',
  'postmaster', 'hostmaster', 'abuse', 'noc', 'vpn', 'proxy', 'gateway',
  'router', 'edge', 'relay', 'origin', 'lb', 'ftp', 'sftp', 'ssh', 'git',
  'ci', 'cd', 'registry', 's3', 'backup', 'db', 'redis', 'grafana',
  'prometheus', 'metrics', 'logs', 'kibana', 'sentry',

  // наши собственные сущности
  'tunnel', 'tunnels', 'control', 'controlplane', 'ttg', 'club', 'vtt',
  'subscriber', 'subscription', 'subscriptions', 'ticket', 'tickets',
  'jwks', 'well-known', 'health', 'ready', 'internal', 'system', 'root',
  'localhost', 'local', 'example', 'invalid',

  // продуктовые и «официальные» имена
  'accounts', 'signin', 'signup', 'signout', 'logout', 'password',
  'reset', 'verify', 'oauth', 'sso', 'token', 'security', 'legal',
  'terms', 'privacy', 'about', 'contact', 'feedback', 'news', 'press',
  'forum', 'wiki', 'chat', 'panel', 'dashboard', 'console', 'manage',
  'manager', 'moderator', 'mod', 'team', 'staff', 'official', 'store',
  'pay', 'payment', 'payments', 'invoice', 'order', 'orders', 'cart',
  'download', 'downloads', 'files', 'media', 'images', 'img', 'video',
  'sitemap', 'robots', 'favicon', 'search', 'app', 'apps', 'web', 'ws',
  'wss', 'http', 'https', 'beta', 'alpha', 'preview', 'prod', 'production',
  'sandbox', 'stage', 'user', 'users', 'me', 'my', 'new', 'null',
  'undefined', 'master', 'player', 'players', 'game', 'games', 'world',
  'worlds',
] as const;

export const RESERVED_SLUGS: ReadonlySet<string> = new Set<string>(RESERVED);

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}
