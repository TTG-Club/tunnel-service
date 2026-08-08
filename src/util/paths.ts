import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Корень пакета: `src/util/` -> репозиторий, `dist/util/` -> `/app` в образе.
 * Так `migrations/` и `data/` находятся одинаково и в dev, и в контейнере,
 * независимо от текущей рабочей директории.
 */
export const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

export function fromPackageRoot(relativeOrAbsolute: string): string {
  return isAbsolute(relativeOrAbsolute)
    ? relativeOrAbsolute
    : resolve(packageRoot, relativeOrAbsolute);
}
