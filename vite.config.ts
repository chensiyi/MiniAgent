import { defineConfig } from 'vite';

// basement 库构建：产出浏览器可用的 IIFE 全局 `MiniAgent`，
// 供油猴 / 浏览器标签分支经 userscript `@require` 引入（运行时加载 basement 仅绑定 executor↔agent，
// 不自动启动；由环境层经 gm_storage.register 触发 boot() 完成启动后，再挂载 GM_* 存储 / DOM UI 等）。
// 仅打包核心（引擎 + 工具 + 内存存储），不含任何环境层（无 GM_* / 无 UI / 无持久化）。
export default defineConfig({
  build: {
    lib: {
      entry: 'src/agent.ts',
      name: 'MiniAgent',
      formats: ['iife'],
      fileName: () => 'miniagent-basement.js',
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
});
