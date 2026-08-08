import { createHash } from 'node:crypto';
import type { NodeRow } from './repository.js';

/**
 * Выбор ноды методом rendezvous hashing (HRW).
 *
 * Требование — стабильность: пока набор живых нод не менялся, аккаунт каждый
 * раз получает ту же ноду, иначе при переподключении мастер уезжал бы на
 * другой адрес. При этом аккаунты равномерно размазаны по нодам, а выпадение
 * одной ноды переносит только её аккаунты, а не перетасовывает всех.
 */
function score(nodeId: string, accountId: string): bigint {
  const digest = createHash('sha256').update(`${nodeId}:${accountId}`, 'utf8').digest();
  return digest.readBigUInt64BE(0);
}

export function selectNode(nodes: readonly NodeRow[], accountId: string): NodeRow | null {
  let best: NodeRow | null = null;
  let bestScore = -1n;

  for (const node of nodes) {
    const value = score(node.id, accountId);
    // При равенстве — по id, чтобы выбор не зависел от порядка строк из базы.
    if (value > bestScore || (value === bestScore && best !== null && node.id < best.id)) {
      best = node;
      bestScore = value;
    }
  }

  return best;
}
