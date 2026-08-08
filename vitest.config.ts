import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Тесты не ходят в базу и в сеть: покрываем только то, где ошибка дорого
    // стоит — слаги, тикеты, кэш подписки, секреты в логах.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
