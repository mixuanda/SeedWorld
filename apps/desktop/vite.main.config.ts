import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

const mainProcessExternals = [
  ...new Set([
    ...builtinModules,
    ...builtinModules.map((moduleName) => `node:${moduleName}`),
    'node:sqlite',
    'sqlite',
    'gray-matter',
  ]),
];

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: mainProcessExternals,
    },
  },
});
